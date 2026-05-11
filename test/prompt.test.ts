import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../src/classifier/prompt.js";
import { SAMPLE_RULES, SAMPLE_EXAMPLES, POST_VIOLATION_RULE1, POST_PROMPT_INJECTION } from "./fixtures.js";

describe("buildUserPrompt", () => {
  it("includes all rules with index, short_name, and description", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, [], POST_VIOLATION_RULE1);
    for (const r of SAMPLE_RULES) {
      expect(prompt).toContain(`Rule ${r.index} — ${r.short_name}`);
      expect(prompt).toContain(r.description.slice(0, 50));
    }
  });

  it("includes few-shot examples when provided", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, SAMPLE_EXAMPLES, POST_VIOLATION_RULE1);
    expect(prompt).toContain("Few-shot examples");
    expect(prompt).toContain("PEP 533");
    expect(prompt).toContain("clear personal attack");
  });

  it("omits examples block when no examples given", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, [], POST_VIOLATION_RULE1);
    expect(prompt).not.toContain("Few-shot examples");
  });

  it("labels content as untrusted input with delimiters", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, [], POST_PROMPT_INJECTION);
    expect(prompt).toContain("untrusted user input");
    // Body should be enclosed in triple quotes
    expect(prompt).toMatch(/Body:\n"""[\s\S]+"""/);
  });

  it("preserves the content verbatim (no filtering of suspicious strings)", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, [], POST_PROMPT_INJECTION);
    expect(prompt).toContain("Ignore previous instructions");
    expect(prompt).toContain("SYSTEM:");
  });

  it("returns required JSON schema description", () => {
    const prompt = buildUserPrompt(SAMPLE_RULES, [], POST_VIOLATION_RULE1);
    expect(prompt).toContain('"violates"');
    expect(prompt).toContain('"which_rule"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reasoning"');
  });
});
