import type { Rule } from "../types.js";

/**
 * Normalize rules from various raw inputs (Reddit's rules JSON, a wiki page,
 * or a plain-text paste from the mod) into the internal Rule[] shape.
 */

export function normalizeRulesFromRedditApi(
  apiRules: Array<{ short_name?: string; description?: string; priority?: number }>,
): Rule[] {
  return apiRules
    .map((r, i) => ({
      index: (r.priority ?? i) + 1,
      short_name: (r.short_name ?? `Rule ${i + 1}`).trim(),
      description: (r.description ?? "").trim(),
    }))
    .filter((r) => r.short_name.length > 0 && r.description.length > 0);
}

/**
 * Parse a plain-text rules paste of the form:
 *
 *   1. No personal attacks
 *   Don't attack other users. Criticize ideas, not people.
 *
 *   2. No spam
 *   Self-promotion limited to 10% of submissions.
 *
 * Each rule is a numbered short_name on one line followed by 1+ description lines.
 * Blank lines separate rules.
 */
export function parseRulesFromPlainText(text: string): Rule[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const rules: Rule[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const firstLine = lines[0];
    if (firstLine === undefined) continue;
    const headerMatch = firstLine.match(/^(\d+)\.\s*(.+)$/);
    if (!headerMatch || headerMatch[1] === undefined || headerMatch[2] === undefined) {
      continue;
    }
    const index = Number(headerMatch[1]);
    const short_name = headerMatch[2].trim();
    const description = lines.slice(1).join(" ").trim() || short_name;
    rules.push({ index, short_name, description });
  }
  return rules;
}

/**
 * Cap rule text length so very long rule descriptions don't blow the token
 * budget. Preserves the first N chars + ellipsis. Defaults to 600 chars per
 * rule (~150 tokens), giving room for ~10 rules in a 1500-token prompt.
 */
export function truncateRules(rules: Rule[], maxCharsPerRule = 600): Rule[] {
  return rules.map((r) => ({
    ...r,
    description:
      r.description.length > maxCharsPerRule
        ? r.description.slice(0, maxCharsPerRule - 3) + "..."
        : r.description,
  }));
}
