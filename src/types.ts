import { z } from "zod";

/** A single subreddit rule as configured by the moderator. */
export const RuleSchema = z.object({
  index: z.number().int().min(1).describe("1-based rule number as displayed on the sub"),
  short_name: z.string().describe("Short rule name, e.g. 'No personal attacks'"),
  description: z.string().describe("Full rule description as written on the sub's rules page"),
  applies_to: z
    .enum(["all", "post", "comment"])
    .optional()
    .describe("Which content kinds this rule covers. Omitted means all."),
});
export type Rule = z.infer<typeof RuleSchema>;

/** A few-shot example provided by the mod during configuration. */
export const ExampleSchema = z.object({
  content: z.string().describe("The example post or comment body"),
  violates_rule: z.number().int().min(1).nullable().describe("Rule index that this example violates, or null if it's a non-violation"),
  reasoning: z.string().describe("Why this is or isn't a violation"),
});
export type Example = z.infer<typeof ExampleSchema>;

/** What the classifier returns for a single piece of content. */
export const VerdictSchema = z.object({
  violates: z.boolean().describe("Whether the content violates any configured rule"),
  which_rule: z.number().int().min(1).nullable().describe("Rule index that's violated, or null"),
  confidence: z.number().min(0).max(1).describe("Classifier confidence 0..1"),
  reasoning: z.string().describe("Short human-readable explanation aimed at a mod"),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Claude models a mod can pick. Haiku is the default: classification is a
 * short, high-volume task where the smallest model holds up well. */
export const MODEL_IDS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
export type ModelId = (typeof MODEL_IDS)[number];
export const DEFAULT_MODEL: ModelId = "claude-haiku-5-5";

/** Map a stored setting value (including retired model ids from older
 * installs) onto a current model id. */
export function resolveModelId(value: unknown): ModelId {
  if (typeof value !== "string") return DEFAULT_MODEL;
  if ((MODEL_IDS as readonly string[]).includes(value)) return value as ModelId;
  if (value.startsWith("claude-sonnet")) return "claude-sonnet-5-5";
  if (value.startsWith("claude-opus")) return "claude-opus-5-5";
  return DEFAULT_MODEL;
}

/** The full configuration a mod provides when installing ModSentinel. */
export const SubredditConfigSchema = z.object({
  subreddit: z.string().describe("Subreddit name (without r/)"),
  rules: z.array(RuleSchema).min(1).describe("All rules to enforce against"),
  examples: z.array(ExampleSchema).default([]).describe("Optional few-shot examples to anchor the classifier"),
  confidence_threshold: z.number().min(0).max(1).default(0.85).describe("Minimum confidence required to flag to mod queue"),
  dry_run: z.boolean().default(true).describe("When true, log decisions but never report to mod queue"),
  scan_posts: z.boolean().default(true),
  scan_comments: z.boolean().default(false).describe("Comment scanning is more expensive — opt-in"),
  llm_model: z.enum(MODEL_IDS).default(DEFAULT_MODEL),
  daily_call_limit: z.number().int().min(0).default(500).describe("Max Claude calls per UTC day. 0 = unlimited"),
  skip_moderators: z.boolean().default(true),
  skip_approved_users: z.boolean().default(true),
  exempt_users: z.array(z.string()).default([]).describe("Lowercase usernames that are never scanned"),
  min_content_chars: z.number().int().min(0).default(3),
});
export type SubredditConfig = z.infer<typeof SubredditConfigSchema>;

/** A single audit record persisted to the per-installation KV store. */
export const AuditEntrySchema = z.object({
  ts: z.string().describe("ISO timestamp"),
  content_id: z.string().describe("Reddit post/comment id (t3_xxx or t1_xxx)"),
  content_kind: z.enum(["post", "comment"]),
  author: z.string().optional(),
  content_excerpt: z.string().max(280),
  verdict: VerdictSchema,
  flagged: z.boolean().describe("Whether ModSentinel actually flagged it (false when below threshold or dry_run)"),
  mod_feedback: z.enum(["true_positive", "false_positive", "true_negative", "false_negative"]).nullable().default(null),
  model: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional()
    .describe("Token usage of the classification call, for cost tracking"),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Content to be classified — either a post or a comment, in a shape that's source-agnostic. */
export interface ContentItem {
  id: string;
  kind: "post" | "comment";
  author: string;
  title?: string;
  body: string;
  /** Link URL for link posts. Shown to the classifier so link-drop spam is visible. */
  url?: string;
}
