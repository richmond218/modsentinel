import { describe, it, expect, vi } from "vitest";
import { parseUserList, skipReason, type SkipCheckDeps } from "../src/moderation/filters.js";
import type { ContentItem } from "../src/types.js";

const CONFIG = { skip_moderators: true, skip_approved_users: true, exempt_users: ["trustedbot"], min_content_chars: 3 };
const POST: ContentItem = { id: "t3_a", kind: "post", author: "someone", title: "Hello", body: "world" };

function lookups(over: Partial<SkipCheckDeps> = {}): SkipCheckDeps {
  return { isModerator: vi.fn(async () => false), isApprovedUser: vi.fn(async () => false), ...over };
}

describe("skipReason", () => {
  it("scans ordinary users", async () => {
    expect(await skipReason(POST, CONFIG, lookups())).toBeNull();
  });

  it("always skips AutoModerator without a Reddit lookup", async () => {
    const l = lookups();
    expect(await skipReason({ ...POST, author: "AutoModerator" }, CONFIG, l)).toMatch(/exempt/);
    expect(l.isModerator).not.toHaveBeenCalled();
  });

  it("skips the app's own account", async () => {
    expect(await skipReason({ ...POST, author: "ModSentinels" }, CONFIG, lookups({ appUsername: "modsentinels" }))).toBe(
      "own content",
    );
  });

  it("skips exempt users case-insensitively", async () => {
    expect(await skipReason({ ...POST, author: "TrustedBot" }, CONFIG, lookups())).toMatch(/exempt list/);
  });

  it("skips near-empty content", async () => {
    expect(await skipReason({ ...POST, title: "", body: " a " }, CONFIG, lookups())).toBe("content too short");
  });

  it("skips moderators and approved users only when enabled", async () => {
    const mod = lookups({ isModerator: async () => true });
    expect(await skipReason(POST, CONFIG, mod)).toMatch(/moderator/);
    expect(await skipReason(POST, { ...CONFIG, skip_moderators: false }, mod)).toBeNull();

    const approved = lookups({ isApprovedUser: async () => true });
    expect(await skipReason(POST, CONFIG, approved)).toMatch(/approved/);
    expect(await skipReason(POST, { ...CONFIG, skip_approved_users: false }, approved)).toBeNull();
  });
});

describe("parseUserList", () => {
  it("splits on commas and whitespace, strips u/ prefixes, lowercases", () => {
    expect(parseUserList("u/Alice, /u/BOB\ncarol  dave,,")).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("handles empty input", () => {
    expect(parseUserList(undefined)).toEqual([]);
    expect(parseUserList("   ")).toEqual([]);
  });
});
