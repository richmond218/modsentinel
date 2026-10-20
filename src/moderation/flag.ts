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
  /** Remove a post or comment (not as spam). Needed only for auto-remove. */
  remove?(target: { id: string; kind: "post" | "comment" }): Promise<void>;
  /** Leave a mod note on a user, linked to the item. */
  addModNote?(options: { user: string; note: string; redditId: string }): Promise<void>;
}

export interface FlagOptions {
  threshold: number;
  dryRun: boolean;
  /** Remove instead of report at or above this confidence. 0 or unset = never remove. */
  autoRemoveThreshold?: number;
  /** Leave a mod note on the author when flagging. Always done for removals. */
  addModNote?: boolean;
}

export type FlagAction = "none" | "reported" | "removed" | "would_report" | "would_remove";

export interface FlagResult {
  /** True when the item was (or in dry run, would have been) reported or removed. */
  flagged: boolean;
  action: FlagAction;
}

/**
 * Decide what to do with a piece of content based on its verdict and config,
 * and (if not dry-running) do it: report it to the mod queue, or, for
 * opted-in very-high-confidence verdicts, remove it.
 *
 * Callers should pass the result to the audit log so dry-run decisions are
 * still tracked.
 */
export async function actOnVerdict(
  reddit: RedditModAdapter,
  content: ContentItem,
  verdict: Verdict,
  options: FlagOptions,
): Promise<FlagResult> {
  const wouldFlag = verdict.violates && verdict.confidence >= options.threshold;
  if (!wouldFlag) return { flagged: false, action: "none" };

  const autoRemove =
    !!options.autoRemoveThreshold &&
    options.autoRemoveThreshold > 0 &&
    verdict.confidence >= options.autoRemoveThreshold &&
    !!reddit.remove;

  if (options.dryRun) {
    // Don't touch mod queue; caller will still log to audit.
    return { flagged: true, action: autoRemove ? "would_remove" : "would_report" };
  }

  const target = { id: content.id, kind: content.kind };
  let action: FlagAction;
  if (autoRemove && reddit.remove) {
    await reddit.remove(target);
    action = "removed";
  } else {
    await reddit.report(target, { reason: buildReportReason(verdict) });
    action = "reported";
  }

  if ((options.addModNote || action === "removed") && reddit.addModNote) {
    try {
      await reddit.addModNote({ user: content.author, note: buildModNote(verdict, action), redditId: content.id });
    } catch {
      // A missing note must not undo or hide the moderation action itself.
    }
  }
  return { flagged: true, action };
}

/** Backwards-compatible boolean form of {@link actOnVerdict}. */
export async function maybeFlag(
  reddit: RedditModAdapter,
  content: ContentItem,
  verdict: Verdict,
  options: FlagOptions,
): Promise<boolean> {
  return (await actOnVerdict(reddit, content, verdict, options)).flagged;
}

/** Reddit caps mod notes at 250 characters. */
export const MAX_MOD_NOTE_CHARS = 250;

/** Mod note text for the author's mod-notes history. */
export function buildModNote(verdict: Verdict, action: "reported" | "removed"): string {
  const conf = Math.round(verdict.confidence * 100);
  const prefix = `ModSentinel ${action === "removed" ? "auto-removed" : "flagged"} (Rule ${verdict.which_rule ?? "?"}, ${conf}%): `;
  const reasoning = verdict.reasoning.replace(/\s+/g, " ").trim();
  const remaining = MAX_MOD_NOTE_CHARS - prefix.length;
  return prefix + (reasoning.length > remaining ? reasoning.slice(0, remaining - 1).trimEnd() + "…" : reasoning);
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
