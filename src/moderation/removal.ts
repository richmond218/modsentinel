import type { ContentItem, Rule } from "../types.js";
import type { CounterStore } from "./budget.js";

/** Values for the removal-message placeholders. Missing ones are left as-is. */
export interface RemovalVars {
  author?: string;
  kind?: ContentItem["kind"];
  subreddit?: string;
  rule?: Rule;
  reason?: string;
}

/**
 * Fill the mod's removal template. Placeholders without a value are left in
 * place, so the message can be rendered in two steps: everything known up
 * front when the form opens, then the rule the mod picks when they submit.
 */
export function renderRemovalMessage(template: string, vars: RemovalVars): string {
  const values: Record<string, string | undefined> = {
    author: vars.author,
    kind: vars.kind,
    subreddit: vars.subreddit,
    rule_number: vars.rule ? String(vars.rule.index) : undefined,
    rule_name: vars.rule?.short_name,
    rule_description: vars.rule?.description,
    reason: vars.reason,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Pick the rule for a removal: the one the mod chose, else the one the verdict cited. */
export function resolveRule(rules: Rule[], chosen: string | undefined, verdictRule: number | null | undefined): Rule | undefined {
  const index = chosen !== undefined && chosen !== "" ? Number(chosen) : verdictRule ?? undefined;
  return rules.find((r) => r.index === index);
}

/** Minimal store for the item a moderator is mid-way through removing. */
export interface PendingStore {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
  expire: CounterStore["expire"];
}

const PENDING_PREFIX = "modsentinel:pending_removal:";
const PENDING_TTL_SECONDS = 15 * 60;

/**
 * Remember which item a moderator opened the removal form for. Devvit form
 * submissions only carry field values, so the target is keyed by the mod.
 */
export async function setPendingRemoval(store: PendingStore, moderatorId: string, targetId: string): Promise<void> {
  const key = PENDING_PREFIX + moderatorId;
  await store.set(key, targetId);
  await store.expire(key, PENDING_TTL_SECONDS);
}

/** Read and clear the pending removal for a moderator (one form submit per open). */
export async function takePendingRemoval(store: PendingStore, moderatorId: string): Promise<string | undefined> {
  const key = PENDING_PREFIX + moderatorId;
  const targetId = await store.get(key);
  if (targetId) await store.del(key);
  return targetId;
}
