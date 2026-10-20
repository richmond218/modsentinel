/**
 * The scan pipeline: config → skip checks → budget → classify → flag → audit.
 *
 * Devvit-agnostic so the whole flow can be unit tested; `main.ts` wires the
 * Devvit context into these adapters.
 */
import type { ClassifyParams, ClassifyResult } from "./classifier/claude.js";
import { rulesForKind } from "./classifier/prompt.js";
import { getDecision, recordDecision, type KVStore } from "./moderation/audit.js";
import { tryConsumeCall, type CounterStore } from "./moderation/budget.js";
import { skipReason, type SkipCheckDeps } from "./moderation/filters.js";
import { maybeFlag, type RedditModAdapter } from "./moderation/flag.js";
import type { ContentItem, ModelId, SubredditConfig, Verdict } from "./types.js";

export interface ScanDeps extends SkipCheckDeps {
  loadConfig(): Promise<SubredditConfig | null>;
  classifier(model: ModelId): { classifyWithUsage(params: ClassifyParams): Promise<ClassifyResult> };
  reddit: RedditModAdapter;
  kv: KVStore;
  counters: CounterStore;
  log?: (message: string) => void;
}

export interface ScanOptions {
  /** Manual scan from the mod menu: re-scan even if already seen, ignore
   * the posts/comments toggles and the author skip list. Budget still applies. */
  force?: boolean;
}

export type ScanOutcome =
  | { status: "skipped"; reason: string }
  | { status: "classified"; verdict: Verdict; flagged: boolean; dryRun: boolean }
  | { status: "error"; error: string };

export async function scanContent(
  deps: ScanDeps,
  content: ContentItem,
  options: ScanOptions = {},
): Promise<ScanOutcome> {
  const log = deps.log ?? (() => {});
  const skip = (reason: string): ScanOutcome => {
    log(`[ModSentinel] ${content.kind} ${content.id} skipped: ${reason}`);
    return { status: "skipped", reason };
  };

  const config = await deps.loadConfig();
  if (!config) return skip("setup incomplete — add a Claude API key and rules in app settings");

  if (!options.force) {
    if (content.kind === "post" && !config.scan_posts) return skip("post scanning is off");
    if (content.kind === "comment" && !config.scan_comments) return skip("comment scanning is off");
    // Triggers can be delivered more than once; never pay for the same item twice.
    if (await getDecision(deps.kv, content.id)) return skip("already scanned");
    const reason = await skipReason(content, config, deps);
    if (reason) return skip(reason);
  }

  if (rulesForKind(config.rules, content.kind).length === 0) {
    return skip(`no rules apply to ${content.kind}s`);
  }

  if (!(await tryConsumeCall(deps.counters, config.daily_call_limit))) {
    return skip(`daily scan limit (${config.daily_call_limit}) reached`);
  }

  let result: ClassifyResult;
  try {
    result = await deps.classifier(config.llm_model).classifyWithUsage({
      rules: config.rules,
      examples: config.examples,
      content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[ModSentinel] classifier failed for ${content.id}: ${message}`);
    return { status: "error", error: message };
  }
  const { verdict, usage } = result;

  let flagged = false;
  try {
    flagged = await maybeFlag(deps.reddit, content, verdict, {
      threshold: config.confidence_threshold,
      dryRun: config.dry_run,
    });
  } catch (err) {
    // Still record the verdict so the paid-for classification isn't lost.
    log(`[ModSentinel] report failed for ${content.id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  await recordDecision(deps.kv, content, verdict, flagged, { model: config.llm_model, usage });

  log(
    `[ModSentinel] ${content.kind} ${content.id} → violates=${verdict.violates} rule=${verdict.which_rule} ` +
      `conf=${verdict.confidence.toFixed(2)} flagged=${flagged}${config.dry_run ? " (dry run)" : ""}`,
  );
  return { status: "classified", verdict, flagged, dryRun: config.dry_run };
}
