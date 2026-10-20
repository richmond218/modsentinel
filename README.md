# ModSentinel

> AI rule-violation pre-screener for Reddit moderators. Built for the [Reddit Mod Tools & Migrated Apps Hackathon (May 2026)](https://mod-tools-migration.devpost.com/).

ModSentinel watches every new post (and optionally every comment) on your subreddit, runs it through Claude with your sub's rules and a few example violations, and flags suspected rule-breakers to your mod queue with a short reasoning attached — so you triage in 5 seconds instead of 30.

**It's not an auto-remover.** Mods stay in control. ModSentinel only reports to mod queue, never removes content directly. A dry-run mode (on by default) lets you watch its decisions for 24 hours before letting it touch the queue.

---

## Why it exists

Mod queue work compounds fast. A medium-sized subreddit (50k members) generates ~30 modqueue items a day, each one taking ~30 seconds to triage. That's 15 minutes a day, every day, forever. Multiply by your sub size.

AutoMod helps with patterns you can spell out in regex, but every sub has rules that don't fit regex — "no personal attacks", "must be on-topic", "no low-effort posts". ModSentinel reads each post and decides, semantically, whether it crosses one of *your* rules. The mod still makes the final call, but on a pre-flagged short list instead of every post in the queue.

## How it works

1. Mod installs ModSentinel on their subreddit via the Reddit App Directory.
2. Mod configures it in app settings:
   - Anthropic Claude API key
   - Subreddit rules — leave empty to use the sub's own rules from Reddit, or paste your own
   - 3-5 example violations (optional, improves accuracy)
   - Confidence threshold (default 0.85)
   - Dry run on/off (default ON)
   - Daily scan limit (default 500 calls/day) to cap the API bill
   - Who to skip: moderators, approved users, and an exempt-users list
   - Optional: auto-remove threshold (off by default), mod notes on flagged users, edit re-scanning (on), weekly report (on)
3. On every new post (and optional comment), ModSentinel:
   - Skips AutoModerator, its own account, mods/approved users/exempt users, near-empty content, and items it has already scanned
   - Sends the content + the rules that apply to that kind of content + examples to Claude
   - Receives a schema-constrained verdict: `{ violates, which_rule, confidence, reasoning }`
   - If `violates && confidence >= threshold && !dry_run` → reports to mod queue with a short reason
   - If auto-remove is turned on and confidence is at or above its threshold (0.9-1.0) → removes the item and leaves a mod note saying why
   - Always logs the decision (with token usage) to a per-install audit store
4. Mods see flagged items in mod queue with a one-line reason (Reddit caps report reasons at 100 characters):
   > `ModSentinel R1 92%: Calls users "morons" and dismisses anyone who agrees with them.`

### Mod tools

From the `...` menu (mods only):

| Where | Action | What it does |
|---|---|---|
| Post / comment | **ModSentinel: scan now** | Classifies the item immediately, ignoring skip rules. Handy for testing your rules. |
| Post / comment | **ModSentinel: why flagged?** | Shows the full verdict and reasoning for an item ModSentinel has scanned. |
| Subreddit | **ModSentinel: stats** | Items scanned and flagged, precision, recall, estimated API cost over 14 days, and calls today. |

### Edits, notes and the weekly report

- **Edited content is re-scanned.** A clean post edited into a spam link after its first scan gets classified again. Unchanged or already-flagged items aren't re-billed.
- **Mod notes** (optional) put the rule and reasoning in the author's mod-notes history, so repeat behaviour is visible across items. Auto-removals always get a note.
- **Weekly report** by modmail every Monday: volume, precision and recall, flags by rule, items mods overturned (good candidates for `[CLEAN]` examples), and plain-language tuning tips. For example, it suggests turning dry run off once dry-run precision stays above 90%.

### Accuracy tracking without extra clicks

ModSentinel watches mod actions. When a mod removes an item it flagged, that counts as a true positive; approving it counts as a false positive. Removing an item it *didn't* flag counts as a miss. Precision and recall in **stats** come from what mods actually do, with no rating step.

### Safety

- **Reports by default; removes only if you opt in.** Auto-remove is off unless a mod sets a threshold of 0.9 or higher. An out-of-range value turns it off rather than guessing. Dry run (on by default) overrides it. Approving an auto-removed item restores it and counts as a false positive. ModSentinel's own removals are never counted as mod feedback.
- **Prompt-injection hardening.** Post text goes inside a `<user_content>` block, and any look-alike delimiter tags in the post are escaped so a post can't close the block early and pass itself off as instructions. The model is told to ignore instructions inside user content.
- **Verdicts are checked.** Responses are schema-constrained JSON, validated again with Zod. A verdict that cites a rule number that doesn't exist is discarded. Refusals are treated as errors, never as verdicts.
- **Bounded spend.** A daily call limit, duplicate-trigger protection, and an 8,000-character cap on post bodies.

## Tech

- **TypeScript** on the [Devvit](https://developers.reddit.com) platform (runs on Reddit's servers)
- **Claude API** via `fetch` (Haiku 5.5 by default; Sonnet 5.5 / Opus 5.5 selectable), with structured outputs, `effort: "low"`, and prompt caching of the per-sub rules block
- **Zod** for schema-validated parsing
- **Vitest** with 127 unit tests (mocked Claude responses, in-memory Redis)

## Project structure

```
src/
├── main.ts                     # Devvit wiring — triggers (submit, update, ModAction, install), menu items, weekly job
├── scan.ts                     # Devvit-agnostic pipeline: config → skip → budget → classify → flag → audit
├── types.ts                    # Zod schemas + model list: Rule, Example, Verdict, SubredditConfig, AuditEntry
├── settings.ts                 # Devvit settings schema, validators, loadConfig()
├── classifier/
│   ├── claude.ts               # Claude Messages API client (structured outputs, caching, retries, refusals)
│   ├── prompt.ts               # System prompt, cached policy block, escaped content block
│   └── parser.ts               # JSON response parser + format coercion
├── rules/
│   └── normalize.ts            # Rules/examples text parsers, Reddit rules → Rule[], truncation
└── moderation/
    ├── flag.ts                 # Report / remove / mod note; ≤100-char report reason, ≤250-char note
    ├── filters.ts              # Who/what to skip before spending an API call
    ├── budget.ts               # Daily call limit (Redis counter)
    ├── audit.ts                # Audit log, edit hashes, mod-action feedback, precision/recall/cost stats
    └── report.ts               # Weekly modmail report + tuning tips
test/                           # One test file per module, plus scan.test.ts for the full pipeline
```

## Testing

```bash
npm install
npm test              # 127 tests, ~2s
npm run build         # tsc --noEmit
npm run lint
```

Tests use mocked `fetch` and an in-memory Redis stand-in, so they run with zero external dependencies. No Claude API key needed for CI. GitHub Actions runs lint, type-check and tests on every PR.

## Cost

Rough estimate per classification on Haiku 5.5 ($0.10 / $0.50 per million input/output tokens):
- Rules + examples (~600 tokens): cached after the first call, billed at a tenth of the input rate
- Post content (~200 tokens) + verdict and brief thinking at low effort (~200 output tokens)
- **Total per post: roughly $0.0001**

A sub with 1,000 posts/day comes to roughly $3/month. The **stats** menu shows the real figure from logged token usage, and the daily scan limit caps the worst case.

## Status

Shipped since the hackathon build:

- Current Claude models, structured outputs, prompt caching
- Auto-fetching the sub's rules, per-rule post/comment scoping
- Skip lists, duplicate protection, daily spend cap
- Automatic accuracy tracking from mod actions; scan-now / why-flagged / stats menu actions
- Opt-in auto-remove for near-certain verdicts, mod notes, edit re-scanning, weekly modmail report

Next up:

1. Removal-reason drafting: suggest a removal message citing the rule when a mod removes a flagged item
2. Image posts: send images to Claude so image-only rule breaks are caught
3. A dashboard custom post showing per-sub precision over time

## License

MIT — see [LICENSE](LICENSE).
