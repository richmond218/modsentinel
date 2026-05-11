import { describe, it, expect } from "vitest";
import { parseVerdict, VerdictParseError } from "../src/classifier/parser.js";

describe("parseVerdict", () => {
  it("parses clean JSON", () => {
    const raw = `{"violates": true, "which_rule": 1, "confidence": 0.92, "reasoning": "Personal attack."}`;
    const v = parseVerdict(raw);
    expect(v.violates).toBe(true);
    expect(v.which_rule).toBe(1);
    expect(v.confidence).toBeCloseTo(0.92);
  });

  it("strips ```json code fences", () => {
    const raw = "```json\n" + JSON.stringify({
      violates: false,
      which_rule: null,
      confidence: 0.4,
      reasoning: "Ambiguous",
    }) + "\n```";
    const v = parseVerdict(raw);
    expect(v.violates).toBe(false);
    expect(v.which_rule).toBeNull();
  });

  it("strips preamble before JSON", () => {
    const raw = `Here is the JSON: {"violates": true, "which_rule": 2, "confidence": 0.88, "reasoning": "Spam"}`;
    const v = parseVerdict(raw);
    expect(v.violates).toBe(true);
    expect(v.which_rule).toBe(2);
  });

  it("coerces alternative field names (rule_number → which_rule)", () => {
    const raw = `{"violates": true, "rule_number": 3, "confidence": 0.7, "reasoning": "Off-topic"}`;
    const v = parseVerdict(raw);
    expect(v.which_rule).toBe(3);
  });

  it("coerces percent-form confidence (85 → 0.85)", () => {
    const raw = `{"violates": true, "which_rule": 1, "confidence": 85, "reasoning": "X"}`;
    const v = parseVerdict(raw);
    expect(v.confidence).toBeCloseTo(0.85);
  });

  it("coerces percent string confidence ('85%' → 0.85)", () => {
    const raw = `{"violates": true, "which_rule": 1, "confidence": "85%", "reasoning": "X"}`;
    const v = parseVerdict(raw);
    expect(v.confidence).toBeCloseTo(0.85);
  });

  it("coerces string booleans", () => {
    const raw = `{"violates": "true", "which_rule": 1, "confidence": 0.9, "reasoning": "X"}`;
    const v = parseVerdict(raw);
    expect(v.violates).toBe(true);
  });

  it("clears which_rule when violates=false", () => {
    const raw = `{"violates": false, "which_rule": 5, "confidence": 0.2, "reasoning": "Clean"}`;
    const v = parseVerdict(raw);
    expect(v.which_rule).toBeNull();
  });

  it("rejects violates=true with which_rule=null", () => {
    const raw = `{"violates": true, "which_rule": null, "confidence": 0.9, "reasoning": "X"}`;
    expect(() => parseVerdict(raw)).toThrow(VerdictParseError);
  });

  it("rejects invalid JSON", () => {
    const raw = "not json";
    expect(() => parseVerdict(raw)).toThrow(VerdictParseError);
  });

  it("rejects confidence out of range", () => {
    const raw = `{"violates": false, "which_rule": null, "confidence": 1.5, "reasoning": "X"}`;
    expect(() => parseVerdict(raw)).toThrow(VerdictParseError);
  });

  it("preserves VerdictParseError.rawText", () => {
    try {
      parseVerdict("not json");
    } catch (err) {
      expect(err).toBeInstanceOf(VerdictParseError);
      expect((err as VerdictParseError).rawText).toBe("not json");
    }
  });
});
