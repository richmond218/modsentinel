import { describe, it, expect } from "vitest";
import {
  normalizeRulesFromRedditApi,
  parseRulesFromPlainText,
  truncateRules,
  parseExamplesFromPlainText,
  normalizeRulesFromDevvit,
} from "../src/rules/normalize.js";

describe("normalizeRulesFromRedditApi", () => {
  it("converts Reddit's rules JSON to Rule[]", () => {
    const input = [
      { short_name: "No personal attacks", description: "Don't insult others.", priority: 0 },
      { short_name: "No spam", description: "Self-promo limited to 10%.", priority: 1 },
    ];
    const rules = normalizeRulesFromRedditApi(input);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.index).toBe(1);
    expect(rules[0]?.short_name).toBe("No personal attacks");
    expect(rules[1]?.index).toBe(2);
  });

  it("filters out rules with empty short_name or description", () => {
    const input = [
      { short_name: "Valid", description: "Some text.", priority: 0 },
      { short_name: "", description: "Has desc but no name", priority: 1 },
      { short_name: "Has name but no desc", description: "", priority: 2 },
    ];
    const rules = normalizeRulesFromRedditApi(input);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.short_name).toBe("Valid");
  });

  it("falls back to array index when priority missing", () => {
    const input = [
      { short_name: "First", description: "A" },
      { short_name: "Second", description: "B" },
    ];
    const rules = normalizeRulesFromRedditApi(input);
    expect(rules[0]?.index).toBe(1);
    expect(rules[1]?.index).toBe(2);
  });
});

describe("parseRulesFromPlainText", () => {
  it("parses a multi-line numbered rules paste", () => {
    const text = `1. No personal attacks
Don't insult or demean other users. Criticize ideas, not people.

2. No spam
Self-promotion limited to 10% of submissions. Pure link drops are removed.

3. Must be on topic
This sub is for Python.`;
    const rules = parseRulesFromPlainText(text);
    expect(rules).toHaveLength(3);
    expect(rules[0]?.short_name).toBe("No personal attacks");
    expect(rules[0]?.description).toContain("Criticize ideas");
    expect(rules[1]?.index).toBe(2);
    expect(rules[2]?.description).toBe("This sub is for Python.");
  });

  it("ignores blocks without numbered header", () => {
    const text = `Random preamble line that doesn't start with a number.

1. Real rule
With a real description.`;
    const rules = parseRulesFromPlainText(text);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.short_name).toBe("Real rule");
  });

  it("handles rule with header only (no description)", () => {
    const text = `1. Title-only rule`;
    const rules = parseRulesFromPlainText(text);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.description).toBe("Title-only rule");
  });
});

describe("truncateRules", () => {
  it("does not modify short rules", () => {
    const rules = [
      { index: 1, short_name: "A", description: "Short description." },
    ];
    expect(truncateRules(rules, 100)[0]?.description).toBe("Short description.");
  });

  it("truncates long descriptions with ellipsis", () => {
    const rules = [
      { index: 1, short_name: "A", description: "x".repeat(800) },
    ];
    const out = truncateRules(rules, 600);
    expect(out[0]?.description).toHaveLength(600);
    expect(out[0]?.description.endsWith("...")).toBe(true);
  });
});

describe("parseExamplesFromPlainText", () => {
  it("parses VIOLATES and CLEAN blocks with reasoning", () => {
    const text = `[VIOLATES 1] You're all idiots.
Direct insult.

[CLEAN] How do I use asyncio.gather?
On-topic question.

[violates rule 2] Buy my course!!! link.example`;
    const examples = parseExamplesFromPlainText(text);
    expect(examples).toEqual([
      { violates_rule: 1, content: "You're all idiots.", reasoning: "Direct insult." },
      { violates_rule: null, content: "How do I use asyncio.gather?", reasoning: "On-topic question." },
      { violates_rule: 2, content: "Buy my course!!! link.example", reasoning: "Example violation." },
    ]);
  });

  it("ignores untagged or empty blocks", () => {
    expect(parseExamplesFromPlainText("just some notes\n\n[CLEAN]\nno body")).toEqual([]);
  });
});

describe("normalizeRulesFromDevvit", () => {
  it("numbers rules by sidebar priority and maps rule kinds", () => {
    const rules = normalizeRulesFromDevvit([
      { shortName: "No spam", description: "No link drops.", kind: "link", priority: 1 },
      { shortName: "Be civil", description: "", kind: "all", priority: 0 },
      { shortName: "No low-effort replies", description: "Add something.", kind: "comment", priority: 2 },
    ]);
    expect(rules).toEqual([
      { index: 1, short_name: "Be civil", description: "Be civil", applies_to: "all" },
      { index: 2, short_name: "No spam", description: "No link drops.", applies_to: "post" },
      { index: 3, short_name: "No low-effort replies", description: "Add something.", applies_to: "comment" },
    ]);
  });
});
