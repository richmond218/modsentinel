import { describe, it, expect } from "vitest";
import {
  renderRemovalMessage,
  resolveRule,
  setPendingRemoval,
  takePendingRemoval,
  type PendingStore,
} from "../src/moderation/removal.js";
import { DEFAULT_REMOVAL_TEMPLATE } from "../src/types.js";
import { SAMPLE_RULES } from "./fixtures.js";

const RULE1 = SAMPLE_RULES[0]!;

describe("renderRemovalMessage", () => {
  it("fills every placeholder in the default template", () => {
    const text = renderRemovalMessage(DEFAULT_REMOVAL_TEMPLATE, {
      author: "someone",
      kind: "comment",
      subreddit: "python",
      rule: RULE1,
      reason: "Calling another user an idiot is a personal attack.",
    });
    expect(text).toContain("Hi u/someone, your comment was removed for breaking **Rule 1: No personal attacks**.");
    expect(text).toContain("Calling another user an idiot");
    expect(text).toContain("to=r/python");
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("leaves unknown placeholders for a second pass", () => {
    const first = renderRemovalMessage(DEFAULT_REMOVAL_TEMPLATE, { author: "a", kind: "post", subreddit: "s" });
    expect(first).toContain("{rule_number}");
    expect(first).toContain("{reason}");
    const second = renderRemovalMessage(first, { rule: RULE1, reason: RULE1.description });
    expect(second).toContain("Rule 1: No personal attacks");
    expect(second).toContain("Criticize ideas, not people");
  });

  it("supports {rule_description} and ignores unknown tokens", () => {
    expect(renderRemovalMessage("{rule_description} {nope}", { rule: RULE1 })).toBe(`${RULE1.description} {nope}`);
  });
});

describe("resolveRule", () => {
  it("prefers the mod's choice, then the verdict's rule", () => {
    expect(resolveRule(SAMPLE_RULES, "3", 1)?.index).toBe(3);
    expect(resolveRule(SAMPLE_RULES, undefined, 2)?.index).toBe(2);
    expect(resolveRule(SAMPLE_RULES, "", 2)?.index).toBe(2);
    expect(resolveRule(SAMPLE_RULES, undefined, null)).toBeUndefined();
    expect(resolveRule(SAMPLE_RULES, "99", 1)).toBeUndefined();
  });
});

describe("pending removal", () => {
  function store(): PendingStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      set: async (k, v) => data.set(k, v),
      get: async (k) => data.get(k),
      del: async (k) => data.delete(k),
      expire: async () => true,
    };
  }

  it("is keyed per moderator and read only once", async () => {
    const s = store();
    await setPendingRemoval(s, "t2_modA", "t3_one");
    await setPendingRemoval(s, "t2_modB", "t1_two");
    expect(await takePendingRemoval(s, "t2_modA")).toBe("t3_one");
    expect(await takePendingRemoval(s, "t2_modA")).toBeUndefined();
    expect(await takePendingRemoval(s, "t2_modB")).toBe("t1_two");
  });
});
