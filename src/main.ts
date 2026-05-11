/**
 * ModSentinel — Devvit app entry point.
 *
 * Registers PostSubmit + CommentSubmit triggers that run the Claude classifier
 * and (optionally) flag rule violations to the mod queue.
 *
 * Settings are configured per-installation by the moderator (see `settings.ts`
 * and `Devvit.addSettings(...)` below).
 */
import { Devvit, type TriggerContext } from "@devvit/public-api";

import { ClaudeClassifier } from "./classifier/claude.js";
import { maybeFlag } from "./moderation/flag.js";
import { recordDecision } from "./moderation/audit.js";
import { parseRulesFromPlainText, truncateRules } from "./rules/normalize.js";
import { loadConfig, SETTING_DEFINITIONS } from "./settings.js";
import type { ContentItem, Example } from "./types.js";

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: { domains: ["api.anthropic.com"] },
});

Devvit.addSettings(SETTING_DEFINITIONS);

function parseExamplesFromText(text: string): Example[] {
  // Format expected:
  //   [VIOLATES 1] post body here
  //   reasoning here
  //
  //   [CLEAN] another body
  //   reasoning here
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim());
      const first = lines[0] ?? "";
      const violatesMatch = first.match(/^\[VIOLATES\s+(\d+)\](.*)$/i);
      const cleanMatch = first.match(/^\[CLEAN\](.*)$/i);
      if (violatesMatch?.[1] && violatesMatch[2] !== undefined) {
        return {
          violates_rule: Number(violatesMatch[1]),
          content: violatesMatch[2].trim(),
          reasoning: lines.slice(1).join(" ").trim() || "Example violation.",
        };
      }
      if (cleanMatch?.[1] !== undefined) {
        return {
          violates_rule: null,
          content: cleanMatch[1].trim(),
          reasoning: lines.slice(1).join(" ").trim() || "Example clean post.",
        };
      }
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

async function classify(
  ctx: TriggerContext,
  content: ContentItem,
): Promise<void> {
  const subreddit = (await ctx.reddit.getCurrentSubreddit()).name;

  const config = await loadConfig(
    {
      get: async <T = unknown>(key: string) =>
        ((await ctx.settings.get(key)) as T | undefined),
    },
    subreddit,
    (text) => truncateRules(parseRulesFromPlainText(text)),
    parseExamplesFromText,
  );
  if (!config) {
    console.log("[ModSentinel] config not complete — skipping");
    return;
  }
  if (content.kind === "post" && !config.scan_posts) return;
  if (content.kind === "comment" && !config.scan_comments) return;

  const apiKey = (await ctx.settings.get("claude_api_key")) as string;
  const classifier = new ClaudeClassifier({ apiKey, model: config.llm_model });

  let verdict;
  try {
    verdict = await classifier.classify({
      rules: config.rules,
      examples: config.examples,
      content,
    });
  } catch (err) {
    console.error("[ModSentinel] classifier failed:", err);
    return;
  }

  const flagged = await maybeFlag(
    {
      report: async (target, opts) => {
        if (target.kind === "post") {
          await ctx.reddit.report(
            { id: target.id } as Parameters<typeof ctx.reddit.report>[0],
            { reason: opts.reason },
          );
        } else {
          await ctx.reddit.report(
            { id: target.id } as Parameters<typeof ctx.reddit.report>[0],
            { reason: opts.reason },
          );
        }
      },
    },
    content,
    verdict,
    { threshold: config.confidence_threshold, dryRun: config.dry_run },
  );

  await recordDecision(
    {
      hSet: (k, fields) => ctx.redis.hSet(k, fields).then((n) => Number(n)),
      hGet: (k, f) => ctx.redis.hGet(k, f),
      hGetAll: (k) => ctx.redis.hGetAll(k),
      hKeys: (k) => ctx.redis.hKeys(k),
      hDel: (k, fields) => ctx.redis.hDel(k, fields).then((n) => Number(n)),
      expire: (k, s) => ctx.redis.expire(k, s).then(() => true),
    },
    content,
    verdict,
    flagged,
  );

  console.log(
    `[ModSentinel] ${content.kind} ${content.id} → violates=${verdict.violates} rule=${verdict.which_rule} conf=${verdict.confidence.toFixed(2)} flagged=${flagged}`,
  );
}

Devvit.addTrigger({
  event: "PostSubmit",
  onEvent: async (event, ctx) => {
    if (!event.post || !event.author) return;
    await classify(ctx, {
      id: event.post.id,
      kind: "post",
      author: event.author.name,
      title: event.post.title ?? undefined,
      body: event.post.selftext ?? "",
    });
  },
});

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: async (event, ctx) => {
    if (!event.comment || !event.author) return;
    await classify(ctx, {
      id: event.comment.id,
      kind: "comment",
      author: event.author.name,
      body: event.comment.body ?? "",
    });
  },
});

export default Devvit;
