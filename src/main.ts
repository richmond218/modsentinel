/**
 * ModSentinel — Devvit app entry point.
 *
 * Registers PostSubmit + CommentSubmit triggers that run the Claude classifier
 * and (optionally) flag rule violations to the mod queue, a ModAction trigger
 * that turns mod approve/remove decisions into accuracy feedback, PostUpdate +
 * CommentUpdate triggers that re-scan edits, a weekly modmail report job, and
 * mod-only menu actions (scan now, why flagged, remove with reason, stats).
 *
 * Settings are configured per-installation by the moderator (see `settings.ts`
 * and `Devvit.addSettings(...)` below).
 */
import { Devvit, type TriggerContext } from "@devvit/public-api";

import { ClaudeClassifier } from "./classifier/claude.js";
import { extractImageUrls, type PostMediaFields } from "./content/images.js";
import {
  auditStats,
  formatStats,
  getDecision,
  recentDecisions,
  recordFeedbackFromModAction,
  type KVStore,
} from "./moderation/audit.js";
import { callsToday, tryConsumeCall, type CounterStore } from "./moderation/budget.js";
import { buildReportReason } from "./moderation/flag.js";
import {
  renderRemovalMessage,
  resolveRule,
  setPendingRemoval,
  takePendingRemoval,
  type PendingStore,
} from "./moderation/removal.js";
import { buildWeeklyReport } from "./moderation/report.js";
import {
  normalizeRulesFromDevvit,
  parseExamplesFromPlainText,
  parseRulesFromPlainText,
  truncateRules,
} from "./rules/normalize.js";
import { scanContent, type ScanDeps, type ScanOptions, type ScanOutcome } from "./scan.js";
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

/** Build the classifier's view of a post from trigger-event or Post-model fields. */
function postContent(
  post: PostMediaFields & { id: string; title: string; selftext?: string; permalink: string },
  author: string,
): ContentItem {
  const imageUrls = extractImageUrls(post);
  // Self posts' url is their own permalink, and an image post's url is the
  // image itself; only a genuine outbound link is worth showing as a URL.
  const link = post.url && !post.url.includes(post.permalink) && !imageUrls.includes(post.url) ? post.url : undefined;
  return {
    id: post.id,
    kind: "post",
    author,
    title: post.title,
    body: post.selftext ?? "",
    ...(link ? { url: link } : {}),
    ...(imageUrls.length ? { imageUrls } : {}),
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
      remove: (target) => ctx.reddit.remove(target.id, false),
      addModNote: async ({ user, note, redditId }) => {
        await ctx.reddit.addModNote({
          subreddit,
          user,
          note,
          redditId: redditId as `t1_${string}` | `t3_${string}`,
        });
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

async function scan(ctx: TriggerContext, content: ContentItem, options: ScanOptions = {}): Promise<ScanOutcome> {
  return scanContent(await scanDeps(ctx), content, options);
}

Devvit.addTrigger({
  event: "PostSubmit",
  onEvent: async (event, ctx) => {
    if (!event.post || !event.author) return;
    if (event.post.spam || event.post.deleted) return;
    await scan(ctx, postContent(event.post, event.author.name));
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

/** Re-scan edited posts: a clean post can be edited into spam after it passes. */
Devvit.addTrigger({
  event: "PostUpdate",
  onEvent: async (event, ctx) => {
    if (!event.post || !event.author) return;
    if (event.post.spam || event.post.deleted) return;
    if ((event.post.selftext ?? "") === event.previousBody) return;
    await scan(ctx, postContent(event.post, event.author.name), { edited: true });
  },
});

Devvit.addTrigger({
  event: "CommentUpdate",
  onEvent: async (event, ctx) => {
    if (!event.comment || !event.author) return;
    if (event.comment.spam || event.comment.deleted) return;
    if ((event.comment.body ?? "") === event.previousBody) return;
    await scan(
      ctx,
      { id: event.comment.id, kind: "comment", author: event.author.name, body: event.comment.body ?? "" },
      { edited: true },
    );
  },
});

/** Learn from what mods actually do with items ModSentinel has seen. */
Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event, ctx) => {
    const action = event.action ?? "";
    const targetId = action.endsWith("comment") ? event.targetComment?.id : event.targetPost?.id;
    if (!targetId) return;
    // ModSentinel's own auto-removals fire this trigger too; only humans count as feedback.
    const appUser = await ctx.reddit.getAppUser().catch(() => undefined);
    if (appUser && event.moderator?.name?.toLowerCase() === appUser.username.toLowerCase()) return;
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
  return postContent(
    {
      id: post.id,
      title: post.title,
      selftext: post.body ?? "",
      url: post.url,
      permalink: post.permalink,
      galleryImages: post.gallery.map((g) => g.url),
    },
    post.authorName,
  );
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
      const label: Record<typeof outcome.action, string> = {
        none: "Below threshold",
        reported: "Reported",
        removed: "Removed",
        would_report: "Would report (dry run)",
        would_remove: "Would remove (dry run)",
      };
      return `${label[outcome.action]} — ${buildReportReason(v)}`;
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
      ctx.ui.showToast(describeOutcome(await scan(ctx, content, { force: true })));
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
      ? `Rule ${v.which_rule}, ${Math.round(v.confidence * 100)}% conf${entry.action === "removed" ? ", auto-removed" : entry.flagged ? "" : " (not flagged)"}`
      : `Clean, ${Math.round(v.confidence * 100)}% conf`;
    ctx.ui.showToast(`${head}: ${v.reasoning}`);
  },
});

function pendingStore(ctx: TriggerContext): PendingStore {
  return {
    set: (k, v) => ctx.redis.set(k, v),
    get: (k) => ctx.redis.get(k),
    del: (k) => ctx.redis.del(k),
    expire: (k, s) => ctx.redis.expire(k, s).then(() => true),
  };
}

const removalForm = Devvit.createForm(
  (data) => ({
    title: "Remove with reason",
    description: data.description as string,
    acceptLabel: "Remove and reply",
    fields: [
      {
        type: "select" as const,
        name: "rule",
        label: "Rule broken",
        options: data.ruleOptions as Array<{ label: string; value: string }>,
        defaultValue: data.defaultRule ? [data.defaultRule as string] : [],
        required: true,
      },
      {
        type: "paragraph" as const,
        name: "message",
        label: "Message to the author (posted as a distinguished mod reply)",
        defaultValue: data.message as string,
        required: true,
      },
      { type: "boolean" as const, name: "lock_reply", label: "Lock the reply", defaultValue: true },
    ],
  }),
  async (event, ctx) => {
    const values = event.values as { rule?: string[]; message?: string; lock_reply?: boolean };
    const targetId = ctx.userId ? await takePendingRemoval(pendingStore(ctx), ctx.userId) : undefined;
    if (!targetId) {
      ctx.ui.showToast("That removal form expired. Open it again from the menu.");
      return;
    }
    const deps = await scanDeps(ctx);
    const config = await deps.loadConfig();
    const entry = await getDecision(deps.kv, targetId);
    const rule = resolveRule(config?.rules ?? [], values.rule?.[0], entry?.verdict.which_rule);
    // Fill anything left as a placeholder when the form opened (the rule, and
    // the explanation if there was no verdict to draft one from).
    const text = renderRemovalMessage(values.message ?? "", { ...(rule ? { rule, reason: rule.description } : {}) });

    const isPost = targetId.startsWith("t3_");
    try {
      await ctx.reddit.remove(targetId, false);
      const reply = await ctx.reddit.submitComment({ id: targetId, text });
      await reply.distinguish(isPost);
      if (values.lock_reply) await reply.lock();
    } catch (err) {
      ctx.ui.showToast(`Removal failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // The app account did the removal, which the ModAction trigger ignores,
    // so record the mod's decision here.
    await recordFeedbackFromModAction(deps.kv, targetId, isPost ? "removelink" : "removecomment");
    ctx.ui.showToast("Removed and replied.");
  },
);

Devvit.addMenuItem({
  label: "ModSentinel: remove with reason",
  description: "Remove this item and reply with a drafted removal message you can edit first",
  location: ["post", "comment"],
  forUserType: "moderator",
  onPress: async (event, ctx) => {
    if (!ctx.userId) return;
    const deps = await scanDeps(ctx);
    const config = await deps.loadConfig();
    if (!config) {
      ctx.ui.showToast("Finish ModSentinel setup first (API key and rules in app settings).");
      return;
    }
    const content = await contentFromTarget(ctx, event.targetId);
    const entry = await getDecision(deps.kv, event.targetId);
    const rule = entry?.verdict.violates ? resolveRule(config.rules, undefined, entry.verdict.which_rule) : undefined;

    // Draft the explanation with Claude when there's a verdict to go on;
    // fall back to the rule text if that fails or the daily limit is used up.
    let reason: string | undefined;
    if (rule) {
      reason = rule.description;
      if (await tryConsumeCall(deps.counters, config.daily_call_limit)) {
        try {
          reason = await new ClaudeClassifier({
            apiKey: (await ctx.settings.get<string>("claude_api_key")) ?? "",
            model: config.llm_model,
          }).draftRemovalReason({ rule, content, modNote: entry?.verdict.reasoning ?? "" });
        } catch (err) {
          console.error("[ModSentinel] removal draft failed:", err);
        }
      }
    }

    const message = renderRemovalMessage(config.removal_message_template, {
      author: content.author,
      kind: content.kind,
      subreddit: config.subreddit,
      ...(rule ? { rule } : {}),
      ...(reason ? { reason } : {}),
    });

    await setPendingRemoval(pendingStore(ctx), ctx.userId, event.targetId);
    ctx.ui.showForm(removalForm, {
      description: entry?.verdict.violates
        ? `ModSentinel: Rule ${entry.verdict.which_rule}, ${Math.round(entry.verdict.confidence * 100)}% — ${entry.verdict.reasoning}`.slice(0, 300)
        : "ModSentinel didn't flag this item. Pick the rule it broke; the rule text fills any {reason}.",
      ruleOptions: config.rules.map((r) => ({ label: `${r.index}. ${r.short_name}`.slice(0, 100), value: String(r.index) })),
      defaultRule: rule ? String(rule.index) : "",
      message,
    });
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

const WEEKLY_REPORT_JOB = "modsentinel_weekly_report";

Devvit.addSchedulerJob({
  name: WEEKLY_REPORT_JOB,
  onRun: async (_event, ctx) => {
    const deps = await scanDeps(ctx);
    const config = await deps.loadConfig();
    if (!config?.weekly_report) return;
    const report = buildWeeklyReport(await recentDecisions(deps.kv, 500), config.rules, config);
    if (!report) return;
    await ctx.reddit.modMail.createModNotification({
      subject: report.subject.slice(0, 100),
      bodyMarkdown: report.bodyMarkdown,
      subredditId: ctx.subredditId,
    });
  },
});

/** (Re)schedule the weekly report: Mondays 14:00 UTC. Idempotent across upgrades. */
async function scheduleWeeklyReport(ctx: TriggerContext): Promise<void> {
  for (const job of await ctx.scheduler.listJobs()) {
    if (job.name === WEEKLY_REPORT_JOB) await ctx.scheduler.cancelJob(job.id);
  }
  await ctx.scheduler.runJob({ name: WEEKLY_REPORT_JOB, cron: "0 14 * * 1" });
}

Devvit.addTrigger({ event: "AppInstall", onEvent: (_event, ctx) => scheduleWeeklyReport(ctx) });
Devvit.addTrigger({ event: "AppUpgrade", onEvent: (_event, ctx) => scheduleWeeklyReport(ctx) });

export default Devvit;
