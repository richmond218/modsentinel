import { AuditEntrySchema, type AuditEntry, type ContentItem, type Verdict } from "../types.js";

/**
 * Minimal KV interface that Devvit's `context.redis` satisfies.
 * Extracted to keep this module Devvit-agnostic for unit testing.
 */
export interface KVStore {
  hSet(key: string, fields: Record<string, string>): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hKeys(key: string): Promise<string[]>;
  hDel(key: string, fields: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
}

const AUDIT_KEY = "modsentinel:audit";
const RETENTION_SECONDS = 60 * 60 * 24 * 14; // 14 days
const MAX_ENTRIES = 500;

/**
 * Append an audit entry. Entries are stored as a hash keyed by content_id so
 * later mod feedback (true/false positive) can update the same record.
 */
export async function recordDecision(
  store: KVStore,
  content: ContentItem,
  verdict: Verdict,
  flagged: boolean,
): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    content_id: content.id,
    content_kind: content.kind,
    content_excerpt: ((content.title ? content.title + " — " : "") + content.body).slice(0, 280),
    verdict,
    flagged,
    mod_feedback: null,
  };
  await store.hSet(AUDIT_KEY, { [content.id]: JSON.stringify(entry) });
  await store.expire(AUDIT_KEY, RETENTION_SECONDS);
  await maybeTrim(store);
}

/** Read the most recent N audit entries, newest first. */
export async function recentDecisions(store: KVStore, limit = 50): Promise<AuditEntry[]> {
  const all = await store.hGetAll(AUDIT_KEY);
  const entries: AuditEntry[] = [];
  for (const raw of Object.values(all)) {
    try {
      const parsed = AuditEntrySchema.safeParse(JSON.parse(raw));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // Skip corrupt entries
    }
  }
  entries.sort((a, b) => b.ts.localeCompare(a.ts));
  return entries.slice(0, limit);
}

/** Update an entry with mod feedback (true positive / false positive / etc.). */
export async function recordModFeedback(
  store: KVStore,
  contentId: string,
  feedback: AuditEntry["mod_feedback"],
): Promise<boolean> {
  const raw = await store.hGet(AUDIT_KEY, contentId);
  if (!raw) return false;
  let entry: AuditEntry;
  try {
    entry = AuditEntrySchema.parse(JSON.parse(raw));
  } catch {
    return false;
  }
  entry.mod_feedback = feedback;
  await store.hSet(AUDIT_KEY, { [contentId]: JSON.stringify(entry) });
  return true;
}

async function maybeTrim(store: KVStore): Promise<void> {
  const keys = await store.hKeys(AUDIT_KEY);
  if (keys.length <= MAX_ENTRIES) return;
  // Drop oldest by parsing ts; simple O(N) sort acceptable at this scale.
  const entries = await store.hGetAll(AUDIT_KEY);
  const sorted: Array<{ id: string; ts: string }> = [];
  for (const [id, raw] of Object.entries(entries)) {
    try {
      const parsed = JSON.parse(raw) as { ts?: string };
      sorted.push({ id, ts: parsed.ts ?? "" });
    } catch {
      sorted.push({ id, ts: "" });
    }
  }
  sorted.sort((a, b) => a.ts.localeCompare(b.ts));
  const toDelete = sorted.slice(0, sorted.length - MAX_ENTRIES).map((e) => e.id);
  if (toDelete.length > 0) {
    await store.hDel(AUDIT_KEY, toDelete);
  }
}

/** Summary stats for the audit dashboard. */
export interface AuditStats {
  total: number;
  flagged: number;
  true_positives: number;
  false_positives: number;
  unrated: number;
  precision: number | null; // tp / (tp + fp)
}

export async function auditStats(store: KVStore): Promise<AuditStats> {
  const entries = await recentDecisions(store, MAX_ENTRIES);
  const flagged = entries.filter((e) => e.flagged);
  const tp = flagged.filter((e) => e.mod_feedback === "true_positive").length;
  const fp = flagged.filter((e) => e.mod_feedback === "false_positive").length;
  const unrated = flagged.filter((e) => e.mod_feedback === null).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  return {
    total: entries.length,
    flagged: flagged.length,
    true_positives: tp,
    false_positives: fp,
    unrated,
    precision,
  };
}
