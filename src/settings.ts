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
import type { SubredditConfig } from "./types.js";

export type SettingsKey =
  | "claude_api_key"
  | "rules_text"
  | "examples_text"
  | "confidence_threshold"
  | "dry_run"
  | "scan_posts"
  | "scan_comments"
  | "llm_model";

export interface DevvitSettingsAdapter {
  get<T = unknown>(key: SettingsKey): Promise<T | undefined>;
}

/**
 * Reads all ModSentinel settings into a typed SubredditConfig for the active
 * subreddit. Returns null when any required setting is missing so the
 * handler can no-op cleanly during initial onboarding.
 */
export async function loadConfig(
  settings: DevvitSettingsAdapter,
  subreddit: string,
  parseRules: (text: string) => SubredditConfig["rules"],
  parseExamples: (text: string) => SubredditConfig["examples"],
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
  ] = await Promise.all([
    settings.get<string>("claude_api_key"),
    settings.get<string>("rules_text"),
    settings.get<string>("examples_text"),
    settings.get<number>("confidence_threshold"),
    settings.get<boolean>("dry_run"),
    settings.get<boolean>("scan_posts"),
    settings.get<boolean>("scan_comments"),
    settings.get<string | string[]>("llm_model"),
  ]);

  if (!claudeKey || !rulesText) return null;

  const rules = parseRules(rulesText);
  if (rules.length === 0) return null;

  // Devvit select-fields return string[] even when multiSelect is false.
  const modelValue = Array.isArray(model) ? model[0] : model;

  return {
    subreddit,
    rules,
    examples: examplesText ? parseExamples(examplesText) : [],
    confidence_threshold: typeof threshold === "number" ? threshold : 0.85,
    dry_run: dryRun ?? true,
    scan_posts: scanPosts ?? true,
    scan_comments: scanComments ?? false,
    llm_model:
      modelValue === "claude-haiku-4-5" ||
      modelValue === "claude-sonnet-4-6" ||
      modelValue === "claude-opus-4-7"
        ? modelValue
        : "claude-haiku-4-5",
  };
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
    label: "Subreddit rules",
    type: "paragraph" as const,
    required: true,
    helpText:
      'Paste your sub\'s numbered rules. Format:\n1. Short name\nFull description on next lines.\n\n2. Next rule\nDescription.',
  },
  {
    name: "examples_text" as const,
    label: "Few-shot examples (optional)",
    type: "paragraph" as const,
    required: false,
    helpText:
      "Optional. 3-5 example posts with [VIOLATES rule N] or [CLEAN] tags. Improves accuracy for your sub's specific style.",
  },
  {
    name: "confidence_threshold" as const,
    label: "Confidence threshold (0.0-1.0)",
    type: "number" as const,
    defaultValue: 0.85,
    helpText: "Minimum classifier confidence required to flag to mod queue. Default 0.85.",
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
      { label: "Haiku 4.5 — fastest, cheapest (recommended)", value: "claude-haiku-4-5" },
      { label: "Sonnet 4.6 — slower, higher accuracy", value: "claude-sonnet-4-6" },
      { label: "Opus 4.7 — slowest, highest accuracy", value: "claude-opus-4-7" },
    ],
    defaultValue: ["claude-haiku-4-5"],
    multiSelect: false,
  },
];
