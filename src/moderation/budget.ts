/**
 * Daily cap on Claude calls so a raid, a spam wave or a misconfigured sub
 * can't run up an unbounded API bill on the mod's key.
 */

/** Minimal counter interface that Devvit's `context.redis` satisfies. */
export interface CounterStore {
  incrBy(key: string, value: number): Promise<number>;
  get(key: string): Promise<string | undefined>;
  expire(key: string, seconds: number): Promise<boolean>;
}

const KEY_PREFIX = "modsentinel:calls:";
const TWO_DAYS_SECONDS = 60 * 60 * 48;

function dayKey(now: Date): string {
  return KEY_PREFIX + now.toISOString().slice(0, 10);
}

/**
 * Reserve one call against today's (UTC) budget. Returns false when the
 * limit is already used up. A limit of 0 means unlimited.
 */
export async function tryConsumeCall(
  store: CounterStore,
  dailyLimit: number,
  now: Date = new Date(),
): Promise<boolean> {
  const key = dayKey(now);
  const used = await store.incrBy(key, 1);
  if (used === 1) await store.expire(key, TWO_DAYS_SECONDS);
  return dailyLimit <= 0 || used <= dailyLimit;
}

/** Calls made so far today (UTC). Over-limit attempts are counted too. */
export async function callsToday(store: CounterStore, now: Date = new Date()): Promise<number> {
  const raw = await store.get(dayKey(now));
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}
