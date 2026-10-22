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

/** Optional details recorded alongside a decision. */
export interface DecisionMeta {
  model?: string;
  usage?: AuditEntry["usage"];
  action?: AuditEntry["action"];
}

/**
 * Short, stable fingerprint of the text ModSentinel judged (FNV-1a, 32-bit).
 * Used to tell a real edit from a re-delivered or no-op update event.
 */
export function contentHash(content: ContentItem): string {
  const text = [content.title ?? "", content.body, content.url ?? "", ...(content.imageUrls ?? [])].join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Append an audit entry. Entries are stored as a hash keyed by content_id so
 * later mod feedback (true/false positive) can update the same record.
 */
export async function recordDecision(
  store: KVStore,
  content: ContentItem,
  verdict: Verdict,
  flagged: boolean,
  meta: DecisionMeta = {},
): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    content_id: content.id,
    content_kind: content.kind,
    author: content.author,
    content_excerpt: ((content.title ? content.title + " — " : "") + content.body).slice(0, 280),
    verdict,
    flagged,
    content_hash: contentHash(content),
    mod_feedback: null,
    ...(meta.action !== undefined ? { action: meta.action } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
  };
  await store.hSet(AUDIT_KEY, { [content.id]: JSON.stringify(entry) });
  await store.expire(AUDIT_KEY, RETENTION_SECONDS);
  await maybeTrim(store);
}

/** Read the audit entry for one post/comment, if ModSentinel has seen it. */
export async function getDecision(store: KVStore, contentId: string): Promise<AuditEntry | null> {
  const raw = await store.hGet(AUDIT_KEY, contentId);
  if (!raw) return null;
  try {
    const parsed = AuditEntrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  const entry = await getDecision(store, contentId);
  if (!entry) return false;
  entry.mod_feedback = feedback;
  await store.hSet(AUDIT_KEY, { [contentId]: JSON.stringify(entry) });
  return true;
}

const REMOVE_ACTIONS = new Set(["removelink", "removecomment", "spamlink", "spamcomment"]);
const APPROVE_ACTIONS = new Set(["approvelink", "approvecomment"]);

/**
 * Turn a moderator's action on an item into accuracy feedback for the
 * verdict ModSentinel gave it, so precision/recall are measured from what
 * mods actually do instead of requiring them to rate each item by hand.
 *
 * Removing a flagged item → true positive; approving it → false positive.
 * Removing an unflagged item → false negative (a miss); approving it →
 * true negative. The latest action wins if a mod changes their mind.
 *
 * Returns the feedback recorded, or null when the action is irrelevant or
 * the item was never classified.
 */
export async function recordFeedbackFromModAction(
  store: KVStore,
  contentId: string,
  action: string,
): Promise<AuditEntry["mod_feedback"]> {
  const removed = REMOVE_ACTIONS.has(action);
  const approved = APPROVE_ACTIONS.has(action);
  if (!removed && !approved) return null;

  const entry = await getDecision(store, contentId);
  if (!entry) return null;

  const feedback: AuditEntry["mod_feedback"] = entry.flagged
    ? removed
      ? "true_positive"
      : "false_positive"
    : removed
      ? "false_negative"
      : "true_negative";
  entry.mod_feedback = feedback;
  await store.hSet(AUDIT_KEY, { [contentId]: JSON.stringify(entry) });
  return feedback;
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

/** USD per million tokens [input, output] for each selectable model. */
const PRICES_PER_MTOK: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

/** Estimated USD cost of one call. Cache reads bill at 0.1x input, cache writes at 1.25x. */
export function estimateCostUsd(model: string | undefined, usage: AuditEntry["usage"]): number {
  if (!usage) return 0;
  const [inPrice, outPrice] = PRICES_PER_MTOK[model ?? ""] ?? PRICES_PER_MTOK["claude-haiku-5-5"]!;
  const inputEquivalent =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return (inputEquivalent * inPrice + usage.output_tokens * outPrice) / 1_000_000;
}

/** Summary stats for the audit dashboard. */
export interface AuditStats {
  total: number;
  flagged: number;
  removed: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  unrated: number;
  precision: number | null; // tp / (tp + fp)
  recall: number | null; // tp / (tp + fn)
  estimated_cost_usd: number;
}

export async function auditStats(store: KVStore, since?: Date): Promise<AuditStats> {
  const all = await recentDecisions(store, MAX_ENTRIES);
  return computeStats(since ? all.filter((e) => e.ts >= since.toISOString()) : all);
}

/** Stats over a given set of audit entries. */
export function computeStats(entries: AuditEntry[]): AuditStats {
  const flagged = entries.filter((e) => e.flagged);
  const tp = flagged.filter((e) => e.mod_feedback === "true_positive").length;
  const fp = flagged.filter((e) => e.mod_feedback === "false_positive").length;
  const fn = entries.filter((e) => !e.flagged && e.mod_feedback === "false_negative").length;
  const unrated = flagged.filter((e) => e.mod_feedback === null).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const cost = entries.reduce((sum, e) => sum + estimateCostUsd(e.model, e.usage), 0);
  return {
    total: entries.length,
    flagged: flagged.length,
    removed: entries.filter((e) => e.action === "removed").length,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    unrated,
    precision,
    recall,
    estimated_cost_usd: cost,
  };
}

/** One-line human summary of the stats, sized for a toast. */
export function formatStats(s: AuditStats): string {
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  return (
    `${s.total} scanned, ${s.flagged} flagged (${s.unrated} unreviewed). ` +
    `Precision ${pct(s.precision)}, recall ${pct(s.recall)}. ` +
    `~$${s.estimated_cost_usd.toFixed(2)} over 14 days.`
  );
}
