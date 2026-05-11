import { describe, it, expect, vi } from "vitest";
import { ClaudeClassifier, ClaudeApiError } from "../src/classifier/claude.js";
import type { Verdict } from "../src/types.js";
import {
  SAMPLE_RULES,
  SAMPLE_EXAMPLES,
  POST_CLEAN,
  POST_VIOLATION_RULE1,
  POST_VIOLATION_RULE2,
  POST_VIOLATION_RULE3,
  POST_AMBIGUOUS,
  POST_PROMPT_INJECTION,
} from "./fixtures.js";

function mockFetchReturning(verdict: Partial<Verdict> & { violates: boolean }): typeof fetch {
  const fullVerdict = {
    violates: verdict.violates,
    which_rule: verdict.which_rule ?? null,
    confidence: verdict.confidence ?? 0.9,
    reasoning: verdict.reasoning ?? "Mocked reasoning.",
  };
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(fullVerdict) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 50 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, body = "rate limited"): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("ClaudeClassifier — happy path", () => {
  it("flags clear rule-1 violation", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchReturning({ violates: true, which_rule: 1, confidence: 0.95 }),
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_VIOLATION_RULE1,
    });
    expect(v.violates).toBe(true);
    expect(v.which_rule).toBe(1);
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it("flags clear rule-2 spam", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchReturning({ violates: true, which_rule: 2, confidence: 0.91 }),
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_VIOLATION_RULE2,
    });
    expect(v.violates).toBe(true);
    expect(v.which_rule).toBe(2);
  });

  it("flags off-topic content as rule 3", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchReturning({ violates: true, which_rule: 3, confidence: 0.88 }),
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_VIOLATION_RULE3,
    });
    expect(v.which_rule).toBe(3);
  });

  it("does NOT flag a clean post", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchReturning({ violates: false, confidence: 0.2 }),
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_CLEAN,
    });
    expect(v.violates).toBe(false);
    expect(v.which_rule).toBeNull();
  });

  it("returns low confidence for ambiguous content", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchReturning({ violates: false, confidence: 0.45 }),
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_AMBIGUOUS,
    });
    expect(v.confidence).toBeLessThan(0.85);
  });

  it("ignores prompt-injection attempt inside content", async () => {
    // The mock here returns false because that's what we expect the real Claude
    // to return — the test exercises that we pass the content through as-is and
    // trust Claude to ignore the injection. The system prompt explicitly tells
    // Claude to ignore in-content instructions.
    const fetchSpy = mockFetchReturning({ violates: false, confidence: 0.3 });
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: fetchSpy,
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: SAMPLE_EXAMPLES,
      content: POST_PROMPT_INJECTION,
    });
    expect(v.violates).toBe(false);

    // Verify the prompt that was sent does include the suspicious content
    // (i.e. we didn't filter it out — we trust Claude's system prompt to handle it)
    const calls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const bodyStr = (firstCall![1] as RequestInit).body as string;
    expect(bodyStr).toContain("Ignore previous instructions");
  });
});

describe("ClaudeClassifier — error handling", () => {
  it("retries on 429 then succeeds", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt++;
      if (attempt === 1) return new Response("rate limit", { status: 429 });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: '{"violates": false, "which_rule": null, "confidence": 0.1, "reasoning": "X"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 50 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl,
      maxRetries: 2,
    });
    const v = await classifier.classify({
      rules: SAMPLE_RULES,
      examples: [],
      content: POST_CLEAN,
    });
    expect(v.violates).toBe(false);
    expect(attempt).toBe(2);
  });

  it("throws ClaudeApiError on 401 (auth)", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "bad",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchStatus(401, "invalid api key"),
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it("throws ClaudeApiError on 400 (bad request)", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchStatus(400, "bad model"),
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it("eventually fails after maxRetries on persistent 500", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-4-5",
      fetchImpl: mockFetchStatus(500, "server error"),
      maxRetries: 1,
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });
});
