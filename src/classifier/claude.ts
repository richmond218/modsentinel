import type { ContentItem, Example, Rule, Verdict } from "../types.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { parseVerdict } from "./parser.js";

export interface ClaudeClassifierOptions {
  apiKey: string;
  model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-7";
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

interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

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
    const userPrompt = buildUserPrompt(params.rules, params.examples, params.content);

    const body = {
      model: this.model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: userPrompt }],
    };

    const response = await this.callWithRetry(body);
    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return parseVerdict(text);
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
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
