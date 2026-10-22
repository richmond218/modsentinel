import { describe, it, expect, vi } from "vitest";
import {
  actOnVerdict,
  buildModNote,
  buildReportReason,
  MAX_MOD_NOTE_CHARS,
  MAX_REPORT_REASON_CHARS,
  maybeFlag,
  type RedditModAdapter,
} from "../src/moderation/flag.js";
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

describe("actOnVerdict", () => {
  const v = (confidence: number): Verdict => ({ violates: true, which_rule: 2, confidence, reasoning: "Spam link." });

  function full() {
    return {
      report: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      addModNote: vi.fn(async () => {}),
    };
  }

  it("reports below the auto-remove threshold and removes at or above it", async () => {
    const r = full();
    expect(await actOnVerdict(r, CONTENT, v(0.9), { threshold: 0.85, dryRun: false, autoRemoveThreshold: 0.97 })).toEqual({
      flagged: true,
      action: "reported",
    });
    expect(await actOnVerdict(r, CONTENT, v(0.97), { threshold: 0.85, dryRun: false, autoRemoveThreshold: 0.97 })).toEqual({
      flagged: true,
      action: "removed",
    });
    expect(r.report).toHaveBeenCalledOnce();
    expect(r.remove).toHaveBeenCalledWith({ id: CONTENT.id, kind: CONTENT.kind });
  });

  it("never removes when auto-remove is off", async () => {
    const r = full();
    await actOnVerdict(r, CONTENT, v(0.999), { threshold: 0.85, dryRun: false, autoRemoveThreshold: 0 });
    expect(r.remove).not.toHaveBeenCalled();
  });

  it("only says what it would do in dry run", async () => {
    const r = full();
    expect(await actOnVerdict(r, CONTENT, v(0.99), { threshold: 0.85, dryRun: true, autoRemoveThreshold: 0.95 })).toEqual({
      flagged: true,
      action: "would_remove",
    });
    expect(r.remove).not.toHaveBeenCalled();
    expect(r.report).not.toHaveBeenCalled();
    expect(r.addModNote).not.toHaveBeenCalled();
  });

  it("always leaves a mod note on removals, and on reports only when enabled", async () => {
    const r = full();
    await actOnVerdict(r, CONTENT, v(0.9), { threshold: 0.85, dryRun: false });
    expect(r.addModNote).not.toHaveBeenCalled();
    await actOnVerdict(r, CONTENT, v(0.9), { threshold: 0.85, dryRun: false, addModNote: true });
    expect(r.addModNote).toHaveBeenCalledWith(expect.objectContaining({ user: "test", redditId: "t3_xyz" }));
    await actOnVerdict(r, CONTENT, v(0.99), { threshold: 0.85, dryRun: false, autoRemoveThreshold: 0.95 });
    expect(r.addModNote).toHaveBeenCalledTimes(2);
  });

  it("still succeeds when the mod note fails", async () => {
    const r = { ...full(), addModNote: vi.fn(async () => Promise.reject(new Error("notes disabled"))) };
    await expect(
      actOnVerdict(r, CONTENT, v(0.9), { threshold: 0.85, dryRun: false, addModNote: true }),
    ).resolves.toEqual({ flagged: true, action: "reported" });
  });
});

describe("buildModNote", () => {
  it("fits Reddit's 250-char note limit", () => {
    const note = buildModNote({ violates: true, which_rule: 1, confidence: 0.9, reasoning: "z".repeat(1000) }, "removed");
    expect(note.length).toBeLessThanOrEqual(MAX_MOD_NOTE_CHARS);
    expect(note).toMatch(/^ModSentinel auto-removed \(Rule 1, 90%\)/);
  });
});
