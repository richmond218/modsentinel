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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
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
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchStatus(401, "invalid api key"),
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it("throws ClaudeApiError on 400 (bad request)", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchStatus(400, "bad model"),
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });

  it("eventually fails after maxRetries on persistent 500", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "test",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchStatus(500, "server error"),
      maxRetries: 1,
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toBeInstanceOf(ClaudeApiError);
  });
});

function mockFetchRaw(responseBody: object): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function messageWith(verdict: object, extra: object = {}): object {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(verdict) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 600 },
    ...extra,
  };
}

describe("ClaudeClassifier — request shape", () => {
  it("asks for schema-constrained JSON at low effort with the policy block cached", async () => {
    const fetchImpl = mockFetchRaw(messageWith({ violates: false, which_rule: null, confidence: 0.9, reasoning: "ok" }));
    const classifier = new ClaudeClassifier({
      apiKey: "sk-test",
      model: "claude-sonnet-5-5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await classifier.classify({ rules: SAMPLE_RULES, examples: SAMPLE_EXAMPLES, content: POST_CLEAN });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual(["violates", "which_rule", "confidence", "reasoning"]);
    expect(body.system).toHaveLength(2);
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1].text).toContain("No personal attacks");
    // The untrusted content only appears in the user turn, never in the cached system blocks.
    expect(JSON.stringify(body.system)).not.toContain(POST_CLEAN.body);
    expect(body.messages[0].content).toContain(POST_CLEAN.body);
    expect(body).not.toHaveProperty("thinking");
  });

  it("only sends rules that apply to the content kind", async () => {
    const fetchImpl = mockFetchRaw(messageWith({ violates: false, which_rule: null, confidence: 0.9, reasoning: "ok" }));
    const classifier = new ClaudeClassifier({
      apiKey: "k",
      model: "claude-haiku-5-5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await classifier.classify({
      rules: [
        { index: 1, short_name: "Posts need a flair", description: "x", applies_to: "post" },
        { index: 2, short_name: "Be civil", description: "y", applies_to: "all" },
      ],
      examples: [],
      content: { id: "t1_c", kind: "comment", author: "a", body: "hello" },
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.system[1].text).not.toContain("Posts need a flair");
    expect(body.system[1].text).toContain("Be civil");
  });
});

describe("ClaudeClassifier — response handling", () => {
  it("returns token usage alongside the verdict", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "k",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchRaw(
        messageWith({ violates: true, which_rule: 1, confidence: 0.93, reasoning: "Insult." }),
      ) as unknown as typeof fetch,
    });
    const { verdict, usage } = await classifier.classifyWithUsage({
      rules: SAMPLE_RULES,
      examples: [],
      content: POST_VIOLATION_RULE1,
    });
    expect(verdict.which_rule).toBe(1);
    expect(usage).toEqual({ input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 600 });
  });

  it("ignores thinking blocks and reads only the text block", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "k",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchRaw({
        ...messageWith({}),
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: JSON.stringify({ violates: false, which_rule: null, confidence: 0.8, reasoning: "Fine." }) },
        ],
      }) as unknown as typeof fetch,
    });
    const v = await classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN });
    expect(v.violates).toBe(false);
  });

  it("throws on a refusal instead of guessing a verdict", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "k",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchRaw({ ...messageWith({}), content: [], stop_reason: "refusal" }) as unknown as typeof fetch,
    });
    await expect(
      classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN }),
    ).rejects.toThrow(/refusal/);
  });

  it("discards a violation that cites a rule that doesn't exist", async () => {
    const classifier = new ClaudeClassifier({
      apiKey: "k",
      model: "claude-haiku-5-5",
      fetchImpl: mockFetchRaw(
        messageWith({ violates: true, which_rule: 9, confidence: 0.99, reasoning: "Made-up rule." }),
      ) as unknown as typeof fetch,
    });
    const v = await classifier.classify({ rules: SAMPLE_RULES, examples: [], content: POST_CLEAN });
    expect(v.violates).toBe(false);
    expect(v.which_rule).toBeNull();
    expect(v.reasoning).toContain("unknown rule 9");
  });
});
