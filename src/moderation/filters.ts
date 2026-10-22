import type { ContentItem, SubredditConfig } from "../types.js";

/** Accounts whose content is never worth classifying. */
const ALWAYS_SKIP_AUTHORS = new Set(["automoderator", "[deleted]"]);

export interface SkipCheckDeps {
  /** The app's own account name, so ModSentinel never scans itself. */
  appUsername?: string | undefined;
  isModerator(username: string): Promise<boolean>;
  isApprovedUser(username: string): Promise<boolean>;
}

type SkipConfig = Pick<
  SubredditConfig,
  "skip_moderators" | "skip_approved_users" | "exempt_users" | "min_content_chars"
>;

/**
 * Decide whether a piece of content should be skipped before spending an
 * API call on it. Returns a short reason when it should, or null to scan.
 * Cheap local checks run first; Reddit lookups only when they are needed.
 */
export async function skipReason(
  content: ContentItem,
  config: SkipConfig,
  deps: SkipCheckDeps,
): Promise<string | null> {
  const author = content.author.toLowerCase();
  if (ALWAYS_SKIP_AUTHORS.has(author)) return `author ${content.author} is exempt`;
  if (deps.appUsername && author === deps.appUsername.toLowerCase()) return "own content";
  if (config.exempt_users.includes(author)) return `u/${content.author} is on the exempt list`;

  const text = `${content.title ?? ""} ${content.body} ${content.url ?? ""}`.trim();
  if (text.length < config.min_content_chars && !content.imageUrls?.length) return "content too short";

  if (config.skip_moderators && (await deps.isModerator(content.author))) {
    return `u/${content.author} is a moderator`;
  }
  if (config.skip_approved_users && (await deps.isApprovedUser(content.author))) {
    return `u/${content.author} is an approved user`;
  }
  return null;
}

/** Parse the mod's comma/newline separated exempt list into lowercase names. */
export function parseUserList(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/^\/?u\//i, "").toLowerCase())
    .filter(Boolean);
}
