import { describe, it, expect, vi } from "vitest";
import type { ClassifyResult } from "../src/classifier/claude.js";
import { getDecision } from "../src/moderation/audit.js";
import { scanContent, type ScanDeps } from "../src/scan.js";
import type { ContentItem, SubredditConfig, Verdict } from "../src/types.js";
import { SAMPLE_RULES, POST_VIOLATION_RULE1 } from "./fixtures.js";
import { memCounters, memStore } from "./helpers.js";

const CONFIG: SubredditConfig = {
  subreddit: "test",
  rules: SAMPLE_RULES,
  examples: [],
  confidence_threshold: 0.85,
  dry_run: false,
  scan_posts: true,
  scan_comments: false,
  llm_model: "claude-haiku-5-5",
  daily_call_limit: 100,
  skip_moderators: true,
  skip_approved_users: true,
  exempt_users: [],
  min_content_chars: 3,
  auto_remove_threshold: 0,
  add_mod_notes: false,
  rescan_edits: true,
  weekly_report: true,
};

const VIOLATION: Verdict = { violates: true, which_rule: 1, confidence: 0.95, reasoning: "Insult." };

function deps(overrides: Partial<ScanDeps> & { config?: Partial<SubredditConfig> | null; verdict?: Verdict } = {}) {
  const classifyWithUsage = vi.fn(
    async (): Promise<ClassifyResult> => ({
      verdict: overrides.verdict ?? VIOLATION,
      usage: { input_tokens: 100, output_tokens: 30 },
    }),
  );
  const report = vi.fn(async () => {});
  const d: ScanDeps = {
    loadConfig: async () => (overrides.config === null ? null : { ...CONFIG, ...overrides.config }),
    classifier: () => ({ classifyWithUsage }),
    reddit: { report },
    kv: memStore(),
    counters: memCounters(),
    isModerator: async () => false,
    isApprovedUser: async () => false,
    ...overrides,
  };
  return { d, classifyWithUsage, report };
}

describe("scanContent", () => {
  it("classifies, reports and records a violation", async () => {
    const { d, classifyWithUsage, report } = deps();
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toMatchObject({ status: "classified", flagged: true, action: "reported", dryRun: false });
    expect(classifyWithUsage).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    const entry = await getDecision(d.kv, POST_VIOLATION_RULE1.id);
    expect(entry?.flagged).toBe(true);
    expect(entry?.model).toBe("claude-haiku-5-5");
    expect(entry?.usage?.input_tokens).toBe(100);
    expect(entry?.author).toBe(POST_VIOLATION_RULE1.author);
  });

  it("does nothing until setup is complete", async () => {
    const { d, classifyWithUsage } = deps({ config: null });
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toMatchObject({ status: "skipped" });
    expect(classifyWithUsage).not.toHaveBeenCalled();
  });

  it("respects the post/comment toggles", async () => {
    const { d, classifyWithUsage } = deps();
    const comment: ContentItem = { id: "t1_a", kind: "comment", author: "x", body: "you are an idiot" };
    expect(await scanContent(d, comment)).toEqual({ status: "skipped", reason: "comment scanning is off" });
    expect(classifyWithUsage).not.toHaveBeenCalled();
  });

  it("never pays twice for the same item", async () => {
    const { d, classifyWithUsage, report } = deps();
    await scanContent(d, POST_VIOLATION_RULE1);
    const second = await scanContent(d, POST_VIOLATION_RULE1);
    expect(second).toEqual({ status: "skipped", reason: "already scanned" });
    expect(classifyWithUsage).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it("skips moderators' content", async () => {
    const { d, classifyWithUsage } = deps({ isModerator: async () => true });
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out.status).toBe("skipped");
    expect(classifyWithUsage).not.toHaveBeenCalled();
  });

  it("force re-scans and ignores skip rules, for the mod menu", async () => {
    const { d, classifyWithUsage } = deps({ isModerator: async () => true });
    await scanContent(d, POST_VIOLATION_RULE1, { force: true });
    await scanContent(d, POST_VIOLATION_RULE1, { force: true });
    expect(classifyWithUsage).toHaveBeenCalledTimes(2);
  });

  it("stops calling Claude once the daily limit is used up", async () => {
    const { d, classifyWithUsage } = deps({ config: { daily_call_limit: 2 } });
    for (let i = 0; i < 4; i++) {
      await scanContent(d, { ...POST_VIOLATION_RULE1, id: `t3_${i}` });
    }
    expect(classifyWithUsage).toHaveBeenCalledTimes(2);
    const out = await scanContent(d, { ...POST_VIOLATION_RULE1, id: "t3_last" });
    expect(out).toEqual({ status: "skipped", reason: "daily scan limit (2) reached" });
  });

  it("skips when no configured rule applies to the content kind", async () => {
    const { d, classifyWithUsage } = deps({
      config: {
        scan_comments: true,
        rules: [{ index: 1, short_name: "Flair posts", description: "x", applies_to: "post" }],
      },
    });
    const out = await scanContent(d, { id: "t1_z", kind: "comment", author: "a", body: "a comment" });
    expect(out).toEqual({ status: "skipped", reason: "no rules apply to comments" });
    expect(classifyWithUsage).not.toHaveBeenCalled();
  });

  it("reports classifier errors without throwing or recording", async () => {
    const { d } = deps({
      classifier: () => ({
        classifyWithUsage: async () => {
          throw new Error("Claude API 401: invalid x-api-key");
        },
      }),
    });
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toEqual({ status: "error", error: "Claude API 401: invalid x-api-key" });
    expect(await getDecision(d.kv, POST_VIOLATION_RULE1.id)).toBeNull();
  });

  it("still records the verdict when reporting to Reddit fails", async () => {
    const { d } = deps({
      reddit: {
        report: async () => {
          throw new Error("403");
        },
      },
    });
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toMatchObject({ status: "classified", flagged: false });
    expect((await getDecision(d.kv, POST_VIOLATION_RULE1.id))?.verdict.which_rule).toBe(1);
  });

  it("does not report in dry-run mode but records a would-flag", async () => {
    const { d, report } = deps({ config: { dry_run: true } });
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toMatchObject({ status: "classified", flagged: true, dryRun: true });
    expect(report).not.toHaveBeenCalled();
  });
});

describe("scanContent — edits", () => {
  const CLEAN: Verdict = { violates: false, which_rule: null, confidence: 0.9, reasoning: "Fine." };
  const original: ContentItem = { id: "t3_edit", kind: "post", author: "a", title: "Help", body: "How do I parse JSON?" };
  const edited: ContentItem = { ...original, body: "Buy followers at spam.example" };

  it("re-scans a clean item whose text changed", async () => {
    const { d, classifyWithUsage } = deps({ verdict: CLEAN });
    await scanContent(d, original);
    const out = await scanContent(d, edited, { edited: true });
    expect(out.status).toBe("classified");
    expect(classifyWithUsage).toHaveBeenCalledTimes(2);
  });

  it("skips edit events whose text is unchanged", async () => {
    const { d, classifyWithUsage } = deps({ verdict: CLEAN });
    await scanContent(d, original);
    expect(await scanContent(d, original, { edited: true })).toEqual({ status: "skipped", reason: "text unchanged" });
    expect(classifyWithUsage).toHaveBeenCalledOnce();
  });

  it("doesn't re-scan items already flagged or reviewed, or when turned off", async () => {
    const flagged = deps();
    await scanContent(flagged.d, original);
    expect(await scanContent(flagged.d, edited, { edited: true })).toEqual({
      status: "skipped",
      reason: "already flagged",
    });

    const off = deps({ verdict: CLEAN, config: { rescan_edits: false } });
    await scanContent(off.d, original);
    expect(await scanContent(off.d, edited, { edited: true })).toEqual({
      status: "skipped",
      reason: "edit re-scanning is off",
    });
  });

  it("scans an edited item it has never seen", async () => {
    const { d, classifyWithUsage } = deps({ verdict: CLEAN });
    await scanContent(d, edited, { edited: true });
    expect(classifyWithUsage).toHaveBeenCalledOnce();
  });
});

describe("scanContent — auto-remove", () => {
  it("removes instead of reporting at or above the auto-remove threshold", async () => {
    const remove = vi.fn(async () => {});
    const addModNote = vi.fn(async () => {});
    const { d, report } = deps({ config: { auto_remove_threshold: 0.95 } });
    d.reddit = { ...d.reddit, remove, addModNote };
    const out = await scanContent(d, POST_VIOLATION_RULE1);
    expect(out).toMatchObject({ status: "classified", action: "removed" });
    expect(remove).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(addModNote).toHaveBeenCalledOnce();
    expect((await getDecision(d.kv, POST_VIOLATION_RULE1.id))?.action).toBe("removed");
  });

  it("reports when confidence is between the flag and remove thresholds", async () => {
    const remove = vi.fn(async () => {});
    const { d, report } = deps({ config: { auto_remove_threshold: 0.97 } });
    d.reddit = { ...d.reddit, remove };
    await scanContent(d, POST_VIOLATION_RULE1);
    expect(remove).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
  });
});
