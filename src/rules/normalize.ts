import type { Example, Rule } from "../types.js";

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

/**
 * Parse the mod's few-shot examples paste. Each example is a block (blank
 * line between blocks) whose first line starts with a tag:
 *
 *   [VIOLATES 1] post body here
 *   reasoning here
 *
 *   [CLEAN] another body
 *   reasoning here
 *
 * "[VIOLATES rule 1]" is accepted too. Untagged blocks are ignored.
 */
export function parseExamplesFromPlainText(text: string): Example[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block): Example | null => {
      const lines = block.split("\n").map((l) => l.trim());
      const first = lines[0] ?? "";
      const reasoning = lines.slice(1).join(" ").trim();
      const violatesMatch = first.match(/^\[VIOLATES\s+(?:rule\s+)?(\d+)\](.*)$/i);
      if (violatesMatch?.[1] && violatesMatch[2] !== undefined) {
        return {
          violates_rule: Number(violatesMatch[1]),
          content: violatesMatch[2].trim(),
          reasoning: reasoning || "Example violation.",
        };
      }
      const cleanMatch = first.match(/^\[CLEAN\](.*)$/i);
      if (cleanMatch?.[1] !== undefined) {
        return {
          violates_rule: null,
          content: cleanMatch[1].trim(),
          reasoning: reasoning || "Example clean post.",
        };
      }
      return null;
    })
    .filter((e): e is Example => e !== null && e.content.length > 0);
}

/** Map Devvit's Rule objects (from `reddit.getRules`) onto our Rule shape. */
export function normalizeRulesFromDevvit(
  rules: Array<{ shortName: string; description: string; kind: "all" | "link" | "comment"; priority?: number }>,
): Rule[] {
  // Number rules the way the sidebar shows them: by priority (0 = top).
  return [...rules]
    .map((r, i) => ({ r, order: r.priority ?? i }))
    .sort((a, b) => a.order - b.order)
    .map(({ r }, i) => ({
      index: i + 1,
      short_name: r.shortName.trim(),
      description: (r.description || r.shortName).trim(),
      applies_to: r.kind === "link" ? ("post" as const) : r.kind === "comment" ? ("comment" as const) : ("all" as const),
    }))
    .filter((r) => r.short_name.length > 0);
}
