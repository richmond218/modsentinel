import type { AuditEntry, Rule } from "../types.js";
import { computeStats, type AuditStats } from "./audit.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyReport {
  subject: string;
  bodyMarkdown: string;
}

/**
 * Build the weekly modmail report from the last 7 days of audit entries.
 * Returns null when nothing was scanned, so quiet subs don't get empty mail.
 */
export function buildWeeklyReport(
  entries: AuditEntry[],
  rules: Rule[],
  config: { confidence_threshold: number; dry_run: boolean },
  now: Date = new Date(),
): WeeklyReport | null {
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const week = entries.filter((e) => e.ts >= since);
  if (week.length === 0) return null;

  const stats = computeStats(week);
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);

  const lines: string[] = [
    `ModSentinel scanned **${stats.total}** items in the last 7 days and ` +
      `${config.dry_run ? "would have flagged" : "flagged"} **${stats.flagged}**` +
      (stats.removed ? ` (auto-removed ${stats.removed})` : "") +
      ".",
    "",
    "| | |",
    "|---|---|",
    `| Confirmed by mods (removed) | ${stats.true_positives} |`,
    `| Overturned by mods (approved) | ${stats.false_positives} |`,
    `| Missed (mods removed, not flagged) | ${stats.false_negatives} |`,
    `| Flagged, not yet reviewed | ${stats.unrated} |`,
    `| Precision | ${pct(stats.precision)} |`,
    `| Recall | ${pct(stats.recall)} |`,
    `| Estimated API cost | $${stats.estimated_cost_usd.toFixed(2)} |`,
  ];

  const byRule = flagsByRule(week, rules);
  if (byRule.length > 0) {
    lines.push("", "**Flags by rule**", "", "| Rule | Flagged | Overturned |", "|---|---|---|");
    for (const r of byRule) lines.push(`| ${r.label} | ${r.flagged} | ${r.overturned} |`);
  }

  const overturned = week.filter((e) => e.flagged && e.mod_feedback === "false_positive").slice(0, 5);
  if (overturned.length > 0) {
    lines.push("", "**Recently overturned** (good candidates for `[CLEAN]` few-shot examples)", "");
    for (const e of overturned) {
      lines.push(`- Rule ${e.verdict.which_rule}: "${oneLine(e.content_excerpt, 120)}"`);
    }
  }

  const tips = tuningTips(stats, config);
  if (tips.length > 0) {
    lines.push("", "**Suggestions**", "");
    for (const t of tips) lines.push(`- ${t}`);
  }

  lines.push("", "_Turn this report off under ModSentinel's app settings → Weekly report._");

  return {
    subject: `ModSentinel weekly report: ${stats.flagged} flagged, precision ${pct(stats.precision)}`,
    bodyMarkdown: lines.join("\n"),
  };
}

function flagsByRule(entries: AuditEntry[], rules: Rule[]) {
  const counts = new Map<number, { flagged: number; overturned: number }>();
  for (const e of entries) {
    if (!e.flagged || e.verdict.which_rule === null) continue;
    const c = counts.get(e.verdict.which_rule) ?? { flagged: 0, overturned: 0 };
    c.flagged++;
    if (e.mod_feedback === "false_positive") c.overturned++;
    counts.set(e.verdict.which_rule, c);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].flagged - a[1].flagged)
    .map(([index, c]) => {
      const rule = rules.find((r) => r.index === index);
      return { label: rule ? `${index}. ${oneLine(rule.short_name, 60)}` : `${index}`, ...c };
    });
}

/** Plain-language tuning advice from the week's numbers. Only fires on enough data. */
export function tuningTips(
  stats: AuditStats,
  config: { confidence_threshold: number; dry_run: boolean },
): string[] {
  const tips: string[] = [];
  const reviewed = stats.true_positives + stats.false_positives;
  if (reviewed >= 5 && stats.precision !== null && stats.precision < 0.7) {
    const next = Math.min(0.95, Math.round((config.confidence_threshold + 0.05) * 100) / 100);
    tips.push(
      `Precision is low (${Math.round(stats.precision * 100)}%). Consider raising the confidence threshold ` +
        `from ${config.confidence_threshold} to ${next}, or adding overturned items as [CLEAN] examples.`,
    );
  }
  if (stats.true_positives + stats.false_negatives >= 5 && stats.recall !== null && stats.recall < 0.5) {
    tips.push(
      `ModSentinel caught under half of what mods removed (recall ${Math.round(stats.recall * 100)}%). ` +
        `Lowering the threshold or adding [VIOLATES N] examples of what it missed should help.`,
    );
  }
  if (config.dry_run && reviewed >= 10 && stats.precision !== null && stats.precision >= 0.9) {
    tips.push("Dry-run precision is above 90%. It looks ready to turn dry run off.");
  }
  return tips;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
