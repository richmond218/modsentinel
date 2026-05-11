import { describe, it, expect, beforeEach } from "vitest";
import {
  recordDecision,
  recentDecisions,
  recordModFeedback,
  auditStats,
  type KVStore,
} from "../src/moderation/audit.js";
import type { ContentItem, Verdict } from "../src/types.js";

/** In-memory KV store that mimics Devvit's `context.redis` hash API. */
function memStore(): KVStore {
  const store = new Map<string, Map<string, string>>();
  return {
    async hSet(key, fields) {
      let h = store.get(key);
      if (!h) {
        h = new Map();
        store.set(key, h);
      }
      let added = 0;
      for (const [f, v] of Object.entries(fields)) {
        if (!h.has(f)) added++;
        h.set(f, v);
      }
      return added;
    },
    async hGet(key, field) {
      return store.get(key)?.get(field);
    },
    async hGetAll(key) {
      const h = store.get(key);
      return h ? Object.fromEntries(h) : {};
    },
    async hKeys(key) {
      return Array.from(store.get(key)?.keys() ?? []);
    },
    async hDel(key, fields) {
      const h = store.get(key);
      if (!h) return 0;
      let removed = 0;
      for (const f of fields) {
        if (h.delete(f)) removed++;
      }
      return removed;
    },
    async expire() {
      return true;
    },
  };
}

const content = (id: string, body = "test body"): ContentItem => ({
  id,
  kind: "post",
  author: "test_user",
  body,
});

const verdictFlag: Verdict = { violates: true, which_rule: 1, confidence: 0.95, reasoning: "Bad" };
const verdictClean: Verdict = { violates: false, which_rule: null, confidence: 0.2, reasoning: "Good" };

describe("audit log", () => {
  let store: KVStore;

  beforeEach(() => {
    store = memStore();
  });

  it("records a decision and reads it back", async () => {
    await recordDecision(store, content("t3_a"), verdictFlag, true);
    const recent = await recentDecisions(store);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content_id).toBe("t3_a");
    expect(recent[0]?.flagged).toBe(true);
  });

  it("preserves newest-first ordering", async () => {
    await recordDecision(store, content("t3_oldest"), verdictClean, false);
    await new Promise((r) => setTimeout(r, 5));
    await recordDecision(store, content("t3_middle"), verdictFlag, true);
    await new Promise((r) => setTimeout(r, 5));
    await recordDecision(store, content("t3_newest"), verdictClean, false);

    const recent = await recentDecisions(store);
    expect(recent[0]?.content_id).toBe("t3_newest");
    expect(recent[2]?.content_id).toBe("t3_oldest");
  });

  it("recordModFeedback updates an existing entry", async () => {
    await recordDecision(store, content("t3_a"), verdictFlag, true);
    const ok = await recordModFeedback(store, "t3_a", "true_positive");
    expect(ok).toBe(true);

    const recent = await recentDecisions(store);
    expect(recent[0]?.mod_feedback).toBe("true_positive");
  });

  it("recordModFeedback returns false for unknown id", async () => {
    const ok = await recordModFeedback(store, "t3_does_not_exist", "true_positive");
    expect(ok).toBe(false);
  });

  it("auditStats computes precision over labelled decisions", async () => {
    await recordDecision(store, content("t3_a"), verdictFlag, true);
    await recordDecision(store, content("t3_b"), verdictFlag, true);
    await recordDecision(store, content("t3_c"), verdictFlag, true);
    await recordDecision(store, content("t3_d"), verdictClean, false);
    await recordModFeedback(store, "t3_a", "true_positive");
    await recordModFeedback(store, "t3_b", "true_positive");
    await recordModFeedback(store, "t3_c", "false_positive");

    const stats = await auditStats(store);
    expect(stats.total).toBe(4);
    expect(stats.flagged).toBe(3);
    expect(stats.true_positives).toBe(2);
    expect(stats.false_positives).toBe(1);
    expect(stats.precision).toBeCloseTo(2 / 3);
  });

  it("auditStats handles zero labelled flags (precision=null)", async () => {
    await recordDecision(store, content("t3_a"), verdictClean, false);
    const stats = await auditStats(store);
    expect(stats.precision).toBeNull();
  });
});
