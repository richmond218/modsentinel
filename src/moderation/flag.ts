import type { ContentItem, Verdict } from "../types.js";

/**
 * Minimal Reddit moderation interface that Devvit's `context.reddit` satisfies.
 * Extracted to keep this module Devvit-agnostic for unit testing.
 */
export interface RedditModAdapter {
  /** Report a post or comment to mod queue with a reason. */
  report(
    target: { id: string; kind: "post" | "comment" },
    options: { reason: string },
  ): Promise<void>;
  /** Send a modmail to ourselves describing the action (audit trail). */
  sendModmail?(options: { subject: string; body: string }): Promise<void>;
}

export interface FlagOptions {
  threshold: number;
  dryRun: boolean;
}

/**
 * Decide whether to flag a piece of content based on its verdict and config,
 * and (if not dry-running) actually report it.
 *
 * Returns true when the item was (or would have been) flagged. Callers
 * should pass this to the audit log so dry-run decisions are still tracked.
 */
export async function maybeFlag(
  reddit: RedditModAdapter,
  content: ContentItem,
  verdict: Verdict,
  options: FlagOptions,
): Promise<boolean> {
  const wouldFlag = verdict.violates && verdict.confidence >= options.threshold;
  if (!wouldFlag) return false;

  if (options.dryRun) {
    // Don't touch mod queue; caller will still log to audit.
    return true;
  }

  const reason = buildReportReason(verdict);
  await reddit.report({ id: content.id, kind: content.kind }, { reason });
  return true;
}

/** Reddit rejects report reasons longer than 100 characters. */
export const MAX_REPORT_REASON_CHARS = 100;

/**
 * Build the report reason string that mods see in mod queue. Reddit caps
 * report reasons at 100 chars, so this is a compact headline; the full
 * reasoning is kept in the audit log and shown by the "Why flagged?" menu
 * action.
 */
export function buildReportReason(verdict: Verdict): string {
  const conf = Math.round(verdict.confidence * 100);
  const prefix = `ModSentinel R${verdict.which_rule ?? "?"} ${conf}%: `;
  const reasoning = verdict.reasoning.replace(/\s+/g, " ").trim();
  const remaining = MAX_REPORT_REASON_CHARS - prefix.length;
  const trimmed = reasoning.length > remaining
    ? reasoning.slice(0, remaining - 1).trimEnd() + "…"
    : reasoning;
  return prefix + trimmed;
}
