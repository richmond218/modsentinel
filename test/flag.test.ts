import { describe, it, expect, vi } from "vitest";
import { maybeFlag, buildReportReason, MAX_REPORT_REASON_CHARS, type RedditModAdapter } from "../src/moderation/flag.js";
import type { ContentItem, Verdict } from "../src/types.js";

function adapter(): RedditModAdapter & { report: ReturnType<typeof vi.fn> } {
  return {
    report: vi.fn(async () => {}),
  };
}

const CONTENT: ContentItem = {
  id: "t3_xyz",
  kind: "post",
  author: "test",
  body: "test body",
};

describe("maybeFlag", () => {
  it("flags when violates && confidence >= threshold && !dryRun", async () => {
    const r = adapter();
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.9, reasoning: "X" };
    const flagged = await maybeFlag(r, CONTENT, v, { threshold: 0.85, dryRun: false });
    expect(flagged).toBe(true);
    expect(r.report).toHaveBeenCalledOnce();
  });

  it("does NOT call report in dry-run mode but returns true", async () => {
    const r = adapter();
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.9, reasoning: "X" };
    const flagged = await maybeFlag(r, CONTENT, v, { threshold: 0.85, dryRun: true });
    expect(flagged).toBe(true);
    expect(r.report).not.toHaveBeenCalled();
  });

  it("does not flag when confidence < threshold", async () => {
    const r = adapter();
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.7, reasoning: "X" };
    const flagged = await maybeFlag(r, CONTENT, v, { threshold: 0.85, dryRun: false });
    expect(flagged).toBe(false);
    expect(r.report).not.toHaveBeenCalled();
  });

  it("does not flag when violates=false", async () => {
    const r = adapter();
    const v: Verdict = { violates: false, which_rule: null, confidence: 0.95, reasoning: "X" };
    const flagged = await maybeFlag(r, CONTENT, v, { threshold: 0.85, dryRun: false });
    expect(flagged).toBe(false);
  });
});

describe("buildReportReason", () => {
  it("includes rule index, confidence percent, and reasoning", () => {
    const v: Verdict = { violates: true, which_rule: 2, confidence: 0.91, reasoning: "Spam link drop." };
    const r = buildReportReason(v);
    expect(r).toContain("R2");
    expect(r).toContain("91%");
    expect(r).toContain("Spam link drop");
  });

  it("truncates very long reasoning to Reddit's 100-char report limit", () => {
    const long = "x".repeat(2000);
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.9, reasoning: long };
    const r = buildReportReason(v);
    expect(r.length).toBeLessThanOrEqual(MAX_REPORT_REASON_CHARS);
    expect(r.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in reasoning", () => {
    const v: Verdict = {
      violates: true,
      which_rule: 1,
      confidence: 0.9,
      reasoning: "line\nbreak\n\tand\t tabs",
    };
    const r = buildReportReason(v);
    expect(r).not.toContain("\n");
    expect(r).not.toContain("\t");
  });

  it("leaves short reasoning untouched", () => {
    const v: Verdict = { violates: true, which_rule: 3, confidence: 0.88, reasoning: "Off-topic: JavaScript question." };
    expect(buildReportReason(v)).toBe("ModSentinel R3 88%: Off-topic: JavaScript question.");
  });
});

describe("maybeFlag — threshold boundary", () => {
  it("flags at exactly the threshold", async () => {
    const r = adapter();
    const v: Verdict = { violates: true, which_rule: 1, confidence: 0.85, reasoning: "X" };
    expect(await maybeFlag(r, CONTENT, v, { threshold: 0.85, dryRun: false })).toBe(true);
    const call = r.report.mock.calls[0] as unknown as [unknown, { reason: string }];
    expect(call[1].reason.length).toBeLessThanOrEqual(MAX_REPORT_REASON_CHARS);
  });
});
