import { VerdictSchema, type Verdict } from "../types.js";

/**
 * Parse Claude's raw response text into a typed Verdict.
 *
 * Claude usually returns clean JSON when asked, but defensively strips:
 *  - ```json fenced blocks
 *  - leading/trailing whitespace
 *  - common preamble like "Here is the JSON:"
 */
export function parseVerdict(rawText: string): Verdict {
  const cleaned = stripCodeFences(rawText.trim());
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch (err) {
    throw new VerdictParseError(
      `Failed to JSON.parse Claude response: ${(err as Error).message}`,
      rawText,
    );
  }

  // Coerce common shape variations from the model
  const coerced = coerceShape(obj);

  const result = VerdictSchema.safeParse(coerced);
  if (!result.success) {
    throw new VerdictParseError(
      `Claude response failed schema validation: ${result.error.message}`,
      rawText,
    );
  }

  // Cross-field sanity: if violates is true, which_rule must be set
  if (result.data.violates && result.data.which_rule === null) {
    throw new VerdictParseError(
      "Claude said violates=true but which_rule=null. Treating as parse error.",
      rawText,
    );
  }
  if (!result.data.violates && result.data.which_rule !== null) {
    // Soft fix: clear which_rule when violates=false
    return { ...result.data, which_rule: null };
  }

  return result.data;
}

function stripCodeFences(text: string): string {
  // Match ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  // Strip "Here is the JSON:" style preamble
  const preambleStripped = text.replace(/^[^{]*?(\{)/, "$1");
  return preambleStripped.trim();
}

function coerceShape(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  const o = obj as Record<string, unknown>;

  // Some models return "rule_number" or "rule" instead of "which_rule"
  if (o.which_rule === undefined) {
    if (typeof o.rule_number === "number") o.which_rule = o.rule_number;
    else if (typeof o.rule === "number") o.which_rule = o.rule;
    else if (o.violates === false) o.which_rule = null;
  }

  // Coerce string booleans
  if (typeof o.violates === "string") {
    o.violates = o.violates.toLowerCase() === "true";
  }

  // Coerce confidence given as percent ("85%" or 85). Only coerce integer-form
  // percentages in the 2..100 range; leave malformed values (like 1.5) for the
  // schema validator to reject.
  if (typeof o.confidence === "string") {
    const stripped = o.confidence.replace("%", "").trim();
    const n = Number(stripped);
    if (!Number.isNaN(n)) {
      o.confidence = n >= 2 && n <= 100 ? n / 100 : n;
    }
  } else if (
    typeof o.confidence === "number" &&
    Number.isInteger(o.confidence) &&
    o.confidence >= 2 &&
    o.confidence <= 100
  ) {
    o.confidence = o.confidence / 100;
  }

  return o;
}

export class VerdictParseError extends Error {
  override name = "VerdictParseError";
  constructor(
    message: string,
    public readonly rawText: string,
  ) {
    super(message);
  }
}
