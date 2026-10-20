import { describe, it, expect, beforeEach } from "vitest";
import {
  recordDecision,
  recentDecisions,
  recordModFeedback,
  recordFeedbackFromModAction,
  getDecision,
  estimateCostUsd,
  formatStats,
  auditStats,
  type KVStore,
} from "../src/moderation/audit.js";
import type { ContentItem, Verdict } from "../src/types.js";
import { memStore } from "./helpers.js";


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

describe("recordFeedbackFromModAction", () => {
  const post: ContentItem = { id: "t3_fb", kind: "post", author: "u", body: "b" };
  const comment: ContentItem = { id: "t1_fb", kind: "comment", author: "u", body: "b" };
  const flaggedVerdict: Verdict = { violates: true, which_rule: 1, confidence: 0.9, reasoning: "r" };
  const cleanVerdict: Verdict = { violates: false, which_rule: null, confidence: 0.9, reasoning: "r" };

  it("removing a flagged item is a true positive; approving it is a false positive", async () => {
    const store = memStore();
    await recordDecision(store, post, flaggedVerdict, true);
    expect(await recordFeedbackFromModAction(store, post.id, "removelink")).toBe("true_positive");
    expect(await recordFeedbackFromModAction(store, post.id, "approvelink")).toBe("false_positive");
    expect((await getDecision(store, post.id))?.mod_feedback).toBe("false_positive");
  });

  it("removing an unflagged item is a miss; approving it is a true negative", async () => {
    const store = memStore();
    await recordDecision(store, comment, cleanVerdict, false);
    expect(await recordFeedbackFromModAction(store, comment.id, "spamcomment")).toBe("false_negative");
    expect(await recordFeedbackFromModAction(store, comment.id, "approvecomment")).toBe("true_negative");
  });

  it("ignores unrelated actions and unknown items", async () => {
    const store = memStore();
    await recordDecision(store, post, flaggedVerdict, true);
    expect(await recordFeedbackFromModAction(store, post.id, "lock")).toBeNull();
    expect(await recordFeedbackFromModAction(store, "t3_never_seen", "removelink")).toBeNull();
    expect((await getDecision(store, post.id))?.mod_feedback).toBeNull();
  });
});

describe("auditStats — recall and cost", () => {
  it("computes recall from misses and sums estimated cost", async () => {
    const store = memStore();
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.9, reasoning: "r" };
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    await recordDecision(store, { id: "t3_1", kind: "post", author: "a", body: "b" }, v, true, {
      model: "claude-haiku-5-5",
      usage,
    });
    await recordDecision(
      store,
      { id: "t3_2", kind: "post", author: "a", body: "b" },
      { ...v, violates: false, which_rule: null },
      false,
      { model: "claude-haiku-5-5", usage },
    );
    await recordModFeedback(store, "t3_1", "true_positive");
    await recordModFeedback(store, "t3_2", "false_negative");
    const stats = await auditStats(store);
    expect(stats.recall).toBeCloseTo(0.5);
    expect(stats.false_negatives).toBe(1);
    expect(stats.estimated_cost_usd).toBeCloseTo(0.2);
    expect(formatStats(stats)).toContain("recall 50%");
  });
});

describe("estimateCostUsd", () => {
  it("prices cache reads at a tenth and cache writes at 1.25x of input", () => {
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2);
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      }),
    ).toBeCloseTo(2.5);
    expect(estimateCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(20);
  });

  it("is zero without usage data", () => {
    expect(estimateCostUsd("claude-haiku-5-5", undefined)).toBe(0);
  });
});
