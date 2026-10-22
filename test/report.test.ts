import { describe, it, expect } from "vitest";
import { computeStats } from "../src/moderation/audit.js";
import { buildWeeklyReport, tuningTips } from "../src/moderation/report.js";
import type { AuditEntry } from "../src/types.js";
import { SAMPLE_RULES } from "./fixtures.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const CONFIG = { confidence_threshold: 0.85, dry_run: false };

function entry(over: Partial<AuditEntry> & { rule?: number | null }): AuditEntry {
  const rule = over.rule === undefined ? 1 : over.rule;
  return {
    ts: "2026-10-19T12:00:00Z",
    content_id: `t3_${Math.random().toString(36).slice(2)}`,
    content_kind: "post",
    content_excerpt: "some | text\nhere",
    verdict: { violates: rule !== null, which_rule: rule, confidence: 0.9, reasoning: "r" },
    flagged: rule !== null,
    mod_feedback: null,
    ...over,
  };
}

describe("buildWeeklyReport", () => {
  it("returns null when nothing was scanned this week", () => {
    expect(buildWeeklyReport([], SAMPLE_RULES, CONFIG, NOW)).toBeNull();
    expect(buildWeeklyReport([entry({ ts: "2026-10-01T00:00:00Z" })], SAMPLE_RULES, CONFIG, NOW)).toBeNull();
  });

  it("summarises the week with per-rule counts and overturned examples", () => {
    const entries = [
      entry({ rule: 1, mod_feedback: "true_positive" }),
      entry({ rule: 1, mod_feedback: "false_positive", content_excerpt: "heated but fine" }),
      entry({ rule: 2, mod_feedback: "true_positive", action: "removed" }),
      entry({ rule: null }),
      entry({ rule: 3, ts: "2026-09-01T00:00:00Z" }), // older than a week
    ];
    const report = buildWeeklyReport(entries, SAMPLE_RULES, CONFIG, NOW)!;
    expect(report.subject).toBe("ModSentinel weekly report: 3 flagged, precision 67%");
    expect(report.subject.length).toBeLessThanOrEqual(100);
    expect(report.bodyMarkdown).toContain("scanned **4** items");
    expect(report.bodyMarkdown).toContain("(auto-removed 1)");
    expect(report.bodyMarkdown).toContain("| 1. No personal attacks | 2 | 1 |");
    expect(report.bodyMarkdown).toContain('Rule 1: "heated but fine"');
    expect(report.bodyMarkdown).not.toContain("Must be on-topic");
  });

  it("says 'would have flagged' in dry run", () => {
    const report = buildWeeklyReport([entry({})], SAMPLE_RULES, { ...CONFIG, dry_run: true }, NOW)!;
    expect(report.bodyMarkdown).toContain("would have flagged");
  });

  it("keeps table cells intact when excerpts contain pipes or newlines", () => {
    const report = buildWeeklyReport(
      [entry({ mod_feedback: "false_positive", content_excerpt: "a | b\nc" })],
      SAMPLE_RULES,
      CONFIG,
      NOW,
    )!;
    expect(report.bodyMarkdown).toContain('"a / b c"');
  });
});

describe("tuningTips", () => {
  const many = (n: number, fb: AuditEntry["mod_feedback"], rule: number | null = 1) =>
    Array.from({ length: n }, () => entry({ rule, mod_feedback: fb }));

  it("suggests a higher threshold when precision is low", () => {
    const stats = computeStats([...many(2, "true_positive"), ...many(4, "false_positive")]);
    expect(tuningTips(stats, CONFIG).join(" ")).toMatch(/raising the confidence threshold from 0.85 to 0.9/);
  });

  it("flags low recall", () => {
    const stats = computeStats([...many(2, "true_positive"), ...many(4, "false_negative", null)]);
    expect(tuningTips(stats, CONFIG).join(" ")).toMatch(/recall 33%/);
  });

  it("suggests leaving dry run once precision is high", () => {
    const stats = computeStats(many(10, "true_positive"));
    expect(tuningTips(stats, { ...CONFIG, dry_run: true })).toContain(
      "Dry-run precision is above 90%. It looks ready to turn dry run off.",
    );
  });

  it("stays quiet on too little data", () => {
    expect(tuningTips(computeStats(many(2, "false_positive")), CONFIG)).toEqual([]);
  });
});
