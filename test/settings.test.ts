import { describe, it, expect } from "vitest";
import {
  loadConfig,
  SETTING_DEFINITIONS,
  validateAutoRemoveThreshold,
  validateDailyLimit,
  validateThreshold,
  type SettingsKey,
} from "../src/settings.js";
import { MODEL_IDS, resolveModelId } from "../src/types.js";
import { parseExamplesFromPlainText, parseRulesFromPlainText } from "../src/rules/normalize.js";
import { SAMPLE_RULES } from "./fixtures.js";

function settings(values: Partial<Record<SettingsKey, unknown>>) {
  return { get: async <T,>(key: SettingsKey) => values[key] as T | undefined };
}

const RULES_TEXT = "1. Be civil\nNo insults.\n\n2. No spam\nNo link drops.";

describe("loadConfig", () => {
  it("returns null without an API key", async () => {
    expect(await loadConfig(settings({ rules_text: RULES_TEXT }), "s", parseRulesFromPlainText, parseExamplesFromPlainText)).toBeNull();
  });

  it("applies defaults for unset options", async () => {
    const config = await loadConfig(
      settings({ claude_api_key: "k", rules_text: RULES_TEXT }),
      "s",
      parseRulesFromPlainText,
      parseExamplesFromPlainText,
    );
    expect(config).toMatchObject({
      confidence_threshold: 0.85,
      dry_run: true,
      scan_posts: true,
      scan_comments: false,
      llm_model: "claude-haiku-5-5",
      daily_call_limit: 500,
      skip_moderators: true,
      skip_approved_users: true,
      exempt_users: [],
      auto_remove_threshold: 0,
      add_mod_notes: false,
      rescan_edits: true,
      weekly_report: true,
    });
    expect(config?.rules).toHaveLength(2);
  });

  it("falls back to the subreddit's own rules when the rules box is empty", async () => {
    const config = await loadConfig(
      settings({ claude_api_key: "k", rules_text: "  " }),
      "s",
      parseRulesFromPlainText,
      parseExamplesFromPlainText,
      async () => SAMPLE_RULES,
    );
    expect(config?.rules).toBe(SAMPLE_RULES);
  });

  it("returns null when there are no rules anywhere", async () => {
    const config = await loadConfig(
      settings({ claude_api_key: "k" }),
      "s",
      parseRulesFromPlainText,
      parseExamplesFromPlainText,
      async () => [],
    );
    expect(config).toBeNull();
  });

  it("ignores out-of-range numbers and parses the exempt list", async () => {
    const config = await loadConfig(
      settings({
        claude_api_key: "k",
        rules_text: RULES_TEXT,
        confidence_threshold: 85,
        daily_call_limit: -3,
        exempt_users: "u/Bot1, bot2",
        llm_model: ["claude-sonnet-5-5"],
      }),
      "s",
      parseRulesFromPlainText,
      parseExamplesFromPlainText,
    );
    expect(config?.confidence_threshold).toBe(0.85);
    expect(config?.daily_call_limit).toBe(500);
    expect(config?.exempt_users).toEqual(["bot1", "bot2"]);
    expect(config?.llm_model).toBe("claude-sonnet-5-5");
  });
});

describe("resolveModelId", () => {
  it("upgrades model ids saved by older installs", () => {
    expect(resolveModelId("claude-haiku-4-5")).toBe("claude-haiku-5-5");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("claude-sonnet-5-5");
    expect(resolveModelId("claude-opus-4-7")).toBe("claude-opus-5-5");
    expect(resolveModelId(undefined)).toBe("claude-haiku-5-5");
  });
});

describe("SETTING_DEFINITIONS", () => {
  it("offers exactly the supported models", () => {
    const model = SETTING_DEFINITIONS.find((d) => d.name === "llm_model") as { options: Array<{ value: string }> };
    expect(model.options.map((o) => o.value)).toEqual([...MODEL_IDS]);
  });

  it("keeps the API key secret and app-scoped", () => {
    const key = SETTING_DEFINITIONS.find((d) => d.name === "claude_api_key") as { isSecret?: boolean };
    expect(key.isSecret).toBe(true);
  });
});

describe("validators", () => {
  it("validate threshold and daily limit", () => {
    expect(validateThreshold(0.9)).toBeUndefined();
    expect(validateThreshold(90)).toMatch(/between 0 and 1/);
    expect(validateDailyLimit(0)).toBeUndefined();
    expect(validateDailyLimit(2.5)).toMatch(/whole number/);
  });
});

describe("auto-remove threshold", () => {
  async function load(value: unknown) {
    const config = await loadConfig(
      settings({ claude_api_key: "k", rules_text: RULES_TEXT, auto_remove_threshold: value }),
      "s",
      parseRulesFromPlainText,
      parseExamplesFromPlainText,
    );
    return config?.auto_remove_threshold;
  }

  it("accepts values from 0.9 to 1 and fails closed on anything else", async () => {
    expect(await load(0.97)).toBe(0.97);
    expect(await load(0.5)).toBe(0);
    expect(await load(9.7)).toBe(0);
    expect(await load(undefined)).toBe(0);
  });

  it("validates the form input", () => {
    expect(validateAutoRemoveThreshold(0)).toBeUndefined();
    expect(validateAutoRemoveThreshold(0.97)).toBeUndefined();
    expect(validateAutoRemoveThreshold(0.5)).toMatch(/0.9 to 1/);
  });
});
