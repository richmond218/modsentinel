/**
 * ModSentinel — Devvit app entry point.
 *
 * Registers PostSubmit + CommentSubmit triggers that run the Claude classifier
 * and (optionally) flag rule violations to the mod queue, a ModAction trigger
 * that turns mod approve/remove decisions into accuracy feedback, and mod-only
 * menu actions (scan now, why flagged, stats).
 *
 * Settings are configured per-installation by the moderator (see `settings.ts`
 * and `Devvit.addSettings(...)` below).
 */
import { Devvit, type TriggerContext } from "@devvit/public-api";

import { ClaudeClassifier } from "./classifier/claude.js";
import { auditStats, formatStats, getDecision, recordFeedbackFromModAction, type KVStore } from "./moderation/audit.js";
import { callsToday, type CounterStore } from "./moderation/budget.js";
import { buildReportReason } from "./moderation/flag.js";
import {
  normalizeRulesFromDevvit,
  parseExamplesFromPlainText,
  parseRulesFromPlainText,
  truncateRules,
} from "./rules/normalize.js";
import { scanContent, type ScanDeps, type ScanOutcome } from "./scan.js";
import { loadConfig, SETTING_DEFINITIONS } from "./settings.js";
import type { ContentItem } from "./types.js";

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: { domains: ["api.anthropic.com"] },
});

Devvit.addSettings(SETTING_DEFINITIONS);

function kvStore(ctx: TriggerContext): KVStore {
  return {
    hSet: (k, fields) => ctx.redis.hSet(k, fields).then((n) => Number(n)),
    hGet: (k, f) => ctx.redis.hGet(k, f),
    hGetAll: (k) => ctx.redis.hGetAll(k),
    hKeys: (k) => ctx.redis.hKeys(k),
    hDel: (k, fields) => ctx.redis.hDel(k, fields).then((n) => Number(n)),
    expire: (k, s) => ctx.redis.expire(k, s).then(() => true),
  };
}

function counterStore(ctx: TriggerContext): CounterStore {
  return {
    incrBy: (k, n) => ctx.redis.incrBy(k, n).then((v) => Number(v)),
    get: (k) => ctx.redis.get(k),
    expire: (k, s) => ctx.redis.expire(k, s).then(() => true),
  };
}

async function scanDeps(ctx: TriggerContext): Promise<ScanDeps> {
  const subreddit = await ctx.reddit.getCurrentSubredditName();
  const apiKey = (await ctx.settings.get<string>("claude_api_key")) ?? "";
  const appUser = await ctx.reddit.getAppUser().catch(() => undefined);

  return {
    loadConfig: () =>
      loadConfig(
        { get: <T = unknown>(key: string) => ctx.settings.get<T>(key) },
        subreddit,
        (text) => truncateRules(parseRulesFromPlainText(text)),
        parseExamplesFromPlainText,
        async () => {
          try {
            return truncateRules(normalizeRulesFromDevvit(await ctx.reddit.getRules(subreddit)));
          } catch (err) {
            console.error("[ModSentinel] could not fetch subreddit rules:", err);
            return [];
          }
        },
      ),
    classifier: (model) => new ClaudeClassifier({ apiKey, model }),
    reddit: {
      report: async (target, opts) => {
        const thing =
          target.kind === "post"
            ? await ctx.reddit.getPostById(target.id)
            : await ctx.reddit.getCommentById(target.id);
        await ctx.reddit.report(thing, { reason: opts.reason });
      },
    },
    kv: kvStore(ctx),
    counters: counterStore(ctx),
    appUsername: appUser?.username,
    isModerator: async (username) =>
      (await ctx.reddit.getModerators({ subredditName: subreddit, username }).all()).length > 0,
    isApprovedUser: async (username) =>
      (await ctx.reddit.getApprovedUsers({ subredditName: subreddit, username }).all()).length > 0,
    log: (message) => console.log(message),
  };
}

async function scan(ctx: TriggerContext, content: ContentItem, force = false): Promise<ScanOutcome> {
  return scanContent(await scanDeps(ctx), content, { force });
}

Devvit.addTrigger({
  event: "PostSubmit",
  onEvent: async (event, ctx) => {
    if (!event.post || !event.author) return;
    if (event.post.spam || event.post.deleted) return;
    const url = event.post.url && !event.post.url.includes(event.post.permalink) ? event.post.url : undefined;
    await scan(ctx, {
      id: event.post.id,
      kind: "post",
      author: event.author.name,
      title: event.post.title,
      body: event.post.selftext ?? "",
      ...(url ? { url } : {}),
    });
  },
});

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: async (event, ctx) => {
    if (!event.comment || !event.author) return;
    if (event.comment.spam || event.comment.deleted) return;
    await scan(ctx, {
      id: event.comment.id,
      kind: "comment",
      author: event.author.name,
      body: event.comment.body ?? "",
    });
  },
});

/** Learn from what mods actually do with items ModSentinel has seen. */
Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event, ctx) => {
    const action = event.action ?? "";
    const targetId = action.endsWith("comment") ? event.targetComment?.id : event.targetPost?.id;
    if (!targetId) return;
    const feedback = await recordFeedbackFromModAction(kvStore(ctx), targetId, action);
    if (feedback) console.log(`[ModSentinel] ${targetId} ${action} → ${feedback}`);
  },
});

async function contentFromTarget(ctx: Devvit.Context, targetId: string): Promise<ContentItem> {
  if (targetId.startsWith("t1_")) {
    const comment = await ctx.reddit.getCommentById(targetId);
    return { id: comment.id, kind: "comment", author: comment.authorName, body: comment.body };
  }
  const post = await ctx.reddit.getPostById(targetId);
  const isLink = post.url && !post.url.includes(post.permalink);
  return {
    id: post.id,
    kind: "post",
    author: post.authorName,
    title: post.title,
    body: post.body ?? "",
    ...(isLink ? { url: post.url } : {}),
  };
}

function describeOutcome(outcome: ScanOutcome): string {
  switch (outcome.status) {
    case "skipped":
      return `Not scanned: ${outcome.reason}`;
    case "error":
      return `Scan failed: ${outcome.error.slice(0, 120)}`;
    case "classified": {
      const v = outcome.verdict;
      if (!v.violates) return `Clean (${Math.round(v.confidence * 100)}% conf): ${v.reasoning}`;
      const action = outcome.flagged ? (outcome.dryRun ? "Would flag (dry run)" : "Flagged") : "Below threshold";
      return `${action} — ${buildReportReason(v)}`;
    }
  }
}

Devvit.addMenuItem({
  label: "ModSentinel: scan now",
  description: "Classify this item against your rules right away",
  location: ["post", "comment"],
  forUserType: "moderator",
  onPress: async (event, ctx) => {
    try {
      const content = await contentFromTarget(ctx, event.targetId);
      ctx.ui.showToast(describeOutcome(await scan(ctx, content, true)));
    } catch (err) {
      ctx.ui.showToast(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

Devvit.addMenuItem({
  label: "ModSentinel: why flagged?",
  description: "Show ModSentinel's verdict and full reasoning for this item",
  location: ["post", "comment"],
  forUserType: "moderator",
  onPress: async (event, ctx) => {
    const entry = await getDecision(kvStore(ctx), event.targetId);
    if (!entry) {
      ctx.ui.showToast("ModSentinel hasn't scanned this item. Use \"ModSentinel: scan now\".");
      return;
    }
    const v = entry.verdict;
    const head = v.violates
      ? `Rule ${v.which_rule}, ${Math.round(v.confidence * 100)}% conf${entry.flagged ? "" : " (not flagged)"}`
      : `Clean, ${Math.round(v.confidence * 100)}% conf`;
    ctx.ui.showToast(`${head}: ${v.reasoning}`);
  },
});

Devvit.addMenuItem({
  label: "ModSentinel: stats",
  description: "Accuracy, volume and estimated cost over the last 14 days",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, ctx) => {
    const [stats, today] = await Promise.all([auditStats(kvStore(ctx)), callsToday(counterStore(ctx))]);
    ctx.ui.showToast(`${formatStats(stats)} ${today} calls today.`);
  },
});

export default Devvit;
