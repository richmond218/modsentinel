import type { ContentItem, Example, ModelId, Rule, Verdict } from "../types.js";
import { buildContentPrompt, buildPolicyPrompt, rulesForKind, SYSTEM_PROMPT } from "./prompt.js";
import { parseVerdict } from "./parser.js";

export interface ClaudeClassifierOptions {
  apiKey: string;
  model: ModelId;
  /** Override fetch (useful for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the Anthropic API base URL (useful for proxies / tests). */
  baseUrl?: string;
  /** Max retries on 429/5xx. Default 2. */
  maxRetries?: number;
}

export interface ClassifyParams {
  rules: Rule[];
  examples: Example[];
  content: ContentItem;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClassifyResult {
  verdict: Verdict;
  usage: TokenUsage;
}

interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: TokenUsage;
}

/**
 * JSON schema the API constrains the response to (structured outputs), so the
 * verdict comes back as valid JSON instead of prose we have to scrape.
 * Range checks (confidence 0..1) aren't expressible here and stay in Zod.
 */
const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    violates: { type: "boolean" },
    which_rule: { anyOf: [{ type: "integer" }, { type: "null" }] },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["violates", "which_rule", "confidence", "reasoning"],
  additionalProperties: false,
} as const;

/**
 * Claude-backed verdict classifier.
 *
 * Uses the Anthropic Messages API directly via fetch (no SDK dependency)
 * so it runs inside Devvit's restricted Node runtime without bundling
 * issues.
 */
export class ClaudeClassifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;

  constructor(opts: ClaudeClassifierOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async classify(params: ClassifyParams): Promise<Verdict> {
    return (await this.classifyWithUsage(params)).verdict;
  }

  async classifyWithUsage(params: ClassifyParams): Promise<ClassifyResult> {
    const rules = rulesForKind(params.rules, params.content.kind);

    const body = {
      model: this.model,
      // Headroom for brief thinking before the ~100-token verdict; billed on use.
      max_tokens: 2048,
      // Classification is a short, routine judgement: low effort keeps
      // thinking (and its cost) small without hurting verdict quality.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: VERDICT_JSON_SCHEMA },
      },
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        {
          type: "text",
          text: buildPolicyPrompt(rules, params.examples),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user" as const, content: buildContentPrompt(params.content) }],
    };

    const response = await this.callWithRetry(body);
    if (response.stop_reason === "refusal") {
      throw new ClaudeApiError("Claude declined to classify this content (refusal)");
    }
    const text = response.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");

    const verdict = parseVerdict(text);
    if (verdict.violates && verdict.which_rule !== null && !rules.some((r) => r.index === verdict.which_rule)) {
      // The model cited a rule that doesn't exist (or doesn't apply to this
      // kind of content). Don't let that reach the mod queue.
      return {
        verdict: {
          violates: false,
          which_rule: null,
          confidence: 0,
          reasoning: `Discarded: model cited unknown rule ${verdict.which_rule}. ${verdict.reasoning}`,
        },
        usage: response.usage,
      };
    }
    return { verdict, usage: response.usage };
  }

  private async callWithRetry(body: object): Promise<AnthropicMessagesResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429 || res.status >= 500) {
          // Retryable
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          if (attempt < this.maxRetries) {
            await sleep(retryAfter ?? exponentialBackoff(attempt));
            continue;
          }
          throw new ClaudeApiError(`Claude API ${res.status} after ${attempt + 1} attempts`, res.status);
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new ClaudeApiError(`Claude API ${res.status}: ${errText.slice(0, 200)}`, res.status);
        }

        return (await res.json()) as AnthropicMessagesResponse;
      } catch (err) {
        lastError = err as Error;
        if (err instanceof ClaudeApiError && err.status !== undefined && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt >= this.maxRetries) {
          throw lastError;
        }
        await sleep(exponentialBackoff(attempt));
      }
    }
    throw lastError ?? new Error("Unreachable retry loop");
  }
}

export class ClaudeApiError extends Error {
  override name = "ClaudeApiError";
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exponentialBackoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  return null;
}
