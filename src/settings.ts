/**
 * Devvit settings schema for ModSentinel.
 *
 * Settings are configured per-installation by the moderator and accessed at
 * runtime via `context.settings.get(<key>)` inside event handlers.
 *
 * The Devvit `Devvit.addSettings(...)` call lives in `main.ts`. This module
 * exports the typed settings keys + a helper to read all settings into a
 * single shape.
 */

import { SettingScope } from "@devvit/public-api";
import { parseUserList } from "./moderation/filters.js";
import { DEFAULT_MODEL, resolveModelId, type SubredditConfig } from "./types.js";

export type SettingsKey =
  | "claude_api_key"
  | "rules_text"
  | "examples_text"
  | "confidence_threshold"
  | "dry_run"
  | "scan_posts"
  | "scan_comments"
  | "llm_model"
  | "daily_call_limit"
  | "skip_moderators"
  | "skip_approved_users"
  | "exempt_users"
  | "auto_remove_threshold"
  | "add_mod_notes"
  | "rescan_edits"
  | "weekly_report";

export interface DevvitSettingsAdapter {
  get<T = unknown>(key: SettingsKey): Promise<T | undefined>;
}

/**
 * Reads all ModSentinel settings into a typed SubredditConfig for the active
 * subreddit. Returns null when any required setting is missing so the
 * handler can no-op cleanly during initial onboarding.
 *
 * When the mod leaves the rules box empty, `fetchRules` (if given) is used
 * to pull the subreddit's own rules from Reddit.
 */
export async function loadConfig(
  settings: DevvitSettingsAdapter,
  subreddit: string,
  parseRules: (text: string) => SubredditConfig["rules"],
  parseExamples: (text: string) => SubredditConfig["examples"],
  fetchRules?: () => Promise<SubredditConfig["rules"]>,
): Promise<SubredditConfig | null> {
  const [
    claudeKey,
    rulesText,
    examplesText,
    threshold,
    dryRun,
    scanPosts,
    scanComments,
    model,
    dailyLimit,
    skipModerators,
    skipApproved,
    exemptUsers,
    autoRemove,
    addModNotes,
    rescanEdits,
    weeklyReport,
  ] = await Promise.all([
    settings.get<string>("claude_api_key"),
    settings.get<string>("rules_text"),
    settings.get<string>("examples_text"),
    settings.get<number>("confidence_threshold"),
    settings.get<boolean>("dry_run"),
    settings.get<boolean>("scan_posts"),
    settings.get<boolean>("scan_comments"),
    settings.get<string | string[]>("llm_model"),
    settings.get<number>("daily_call_limit"),
    settings.get<boolean>("skip_moderators"),
    settings.get<boolean>("skip_approved_users"),
    settings.get<string>("exempt_users"),
    settings.get<number>("auto_remove_threshold"),
    settings.get<boolean>("add_mod_notes"),
    settings.get<boolean>("rescan_edits"),
    settings.get<boolean>("weekly_report"),
  ]);

  if (!claudeKey) return null;

  let rules = rulesText?.trim() ? parseRules(rulesText) : [];
  if (rules.length === 0 && fetchRules) {
    rules = await fetchRules();
  }
  if (rules.length === 0) return null;

  // Devvit select-fields return string[] even when multiSelect is false.
  const modelValue = Array.isArray(model) ? model[0] : model;

  return {
    subreddit,
    rules,
    examples: examplesText ? parseExamples(examplesText) : [],
    confidence_threshold: isUnitInterval(threshold) ? threshold : 0.85,
    dry_run: dryRun ?? true,
    scan_posts: scanPosts ?? true,
    scan_comments: scanComments ?? false,
    llm_model: resolveModelId(modelValue),
    daily_call_limit:
      typeof dailyLimit === "number" && Number.isFinite(dailyLimit) && dailyLimit >= 0
        ? Math.floor(dailyLimit)
        : 500,
    skip_moderators: skipModerators ?? true,
    skip_approved_users: skipApproved ?? true,
    exempt_users: parseUserList(exemptUsers),
    min_content_chars: 3,
    // Anything outside the allowed band (including a typo like 9.5) disables
    // removal rather than guessing: removing content is the one irreversible-
    // looking thing ModSentinel can do, so it fails closed.
    auto_remove_threshold:
      typeof autoRemove === "number" && autoRemove >= MIN_AUTO_REMOVE_THRESHOLD && autoRemove <= 1 ? autoRemove : 0,
    add_mod_notes: addModNotes ?? false,
    rescan_edits: rescanEdits ?? true,
    weekly_report: weeklyReport ?? true,
  };
}

/** Auto-remove is only allowed for near-certain verdicts. */
export const MIN_AUTO_REMOVE_THRESHOLD = 0.9;

/** Settings-form validator for the auto-remove threshold. */
export function validateAutoRemoveThreshold(value: number | undefined): string | undefined {
  if (value === undefined || value === 0) return undefined;
  return value >= MIN_AUTO_REMOVE_THRESHOLD && value <= 1
    ? undefined
    : `Enter 0 (off) or a number from ${MIN_AUTO_REMOVE_THRESHOLD} to 1, e.g. 0.97`;
}

function isUnitInterval(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Settings-form validator for the confidence threshold. */
export function validateThreshold(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isUnitInterval(value) ? undefined : "Enter a number between 0 and 1, e.g. 0.85";
}

/** Settings-form validator for the daily call limit. */
export function validateDailyLimit(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 ? undefined : "Enter a whole number (0 = unlimited)";
}

/**
 * Public-API friendly setting definitions consumed by `Devvit.addSettings(...)`.
 * Kept as plain data here so tests can verify the schema without a Devvit
 * runtime in scope.
 */
export const SETTING_DEFINITIONS = [
  {
    name: "claude_api_key" as const,
    label: "Claude API key",
    type: "string" as const,
    isSecret: true,
    scope: SettingScope.App,
    required: true,
    helpText:
      "Anthropic API key (starts with sk-ant-...). ModSentinel uses this to classify content against your rules.",
  },
  {
    name: "rules_text" as const,
    label: "Subreddit rules (leave empty to use your sub's rules)",
    type: "paragraph" as const,
    required: false,
    helpText:
      "Optional. Leave empty and ModSentinel reads your subreddit's rules from Reddit. Or paste numbered rules to override:\n1. Short name\nFull description on next lines.\n\n2. Next rule\nDescription.",
  },
  {
    name: "examples_text" as const,
    label: "Few-shot examples (optional)",
    type: "paragraph" as const,
    required: false,
    helpText:
      "Optional. 3-5 example posts, each starting with [VIOLATES N] or [CLEAN], reasoning on the next line, blank line between examples. Improves accuracy for your sub's style.",
  },
  {
    name: "confidence_threshold" as const,
    label: "Confidence threshold (0.0-1.0)",
    type: "number" as const,
    defaultValue: 0.85,
    helpText: "Minimum classifier confidence required to flag to mod queue. Default 0.85.",
    onValidate: ({ value }: { value?: number | undefined }) => validateThreshold(value),
  },
  {
    name: "dry_run" as const,
    label: "Dry run (log only, don't flag)",
    type: "boolean" as const,
    defaultValue: true,
    helpText:
      "When ON, ModSentinel logs decisions but never reports to mod queue. Recommended for the first 24 hours after install.",
  },
  {
    name: "scan_posts" as const,
    label: "Scan new posts",
    type: "boolean" as const,
    defaultValue: true,
  },
  {
    name: "scan_comments" as const,
    label: "Scan new comments",
    type: "boolean" as const,
    defaultValue: false,
    helpText: "Comment scanning is more expensive (more LLM calls). Opt in once posts look good.",
  },
  {
    name: "llm_model" as const,
    label: "Claude model",
    type: "select" as const,
    options: [
      { label: "Haiku 5.5 — fastest, cheapest (recommended)", value: "claude-haiku-5-5" },
      { label: "Sonnet 5.5 — slower, higher accuracy", value: "claude-sonnet-5-5" },
      { label: "Opus 5.5 — slowest, highest accuracy", value: "claude-opus-5-5" },
    ],
    defaultValue: [DEFAULT_MODEL],
    multiSelect: false,
  },
  {
    name: "daily_call_limit" as const,
    label: "Daily scan limit",
    type: "number" as const,
    defaultValue: 500,
    helpText:
      "Maximum Claude calls per day (UTC), to cap your API bill during raids or spam waves. 0 = unlimited.",
    onValidate: ({ value }: { value?: number | undefined }) => validateDailyLimit(value),
  },
  {
    name: "auto_remove_threshold" as const,
    label: "Auto-remove threshold (0 = off)",
    type: "number" as const,
    defaultValue: 0,
    helpText:
      "Off by default. When set (0.9-1.0, e.g. 0.97), verdicts at or above it are removed instead of reported, with a mod note explaining why. Approving the item restores it. Has no effect while dry run is on.",
    onValidate: ({ value }: { value?: number | undefined }) => validateAutoRemoveThreshold(value),
  },
  {
    name: "add_mod_notes" as const,
    label: "Add mod notes when flagging",
    type: "boolean" as const,
    defaultValue: false,
    helpText: "Leave a mod note on the author with the rule and reasoning, so repeat issues show up in their history.",
  },
  {
    name: "rescan_edits" as const,
    label: "Re-scan edited posts and comments",
    type: "boolean" as const,
    defaultValue: true,
    helpText: "Catches content that was edited into a violation after passing its first scan.",
  },
  {
    name: "weekly_report" as const,
    label: "Weekly report",
    type: "boolean" as const,
    defaultValue: true,
    helpText: "Send the mod team a weekly modmail with accuracy, flags by rule, and tuning tips.",
  },
  {
    name: "skip_moderators" as const,
    label: "Skip moderators' content",
    type: "boolean" as const,
    defaultValue: true,
  },
  {
    name: "skip_approved_users" as const,
    label: "Skip approved users' content",
    type: "boolean" as const,
    defaultValue: true,
  },
  {
    name: "exempt_users" as const,
    label: "Exempt users (optional)",
    type: "paragraph" as const,
    required: false,
    helpText: "Usernames that are never scanned, separated by commas or new lines (e.g. trusted bots).",
  },
];
