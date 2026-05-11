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
   - Subreddit rules (paste or auto-fetch)
   - 3-5 example violations (improves accuracy)
   - Confidence threshold (default 0.85)
   - Dry run on/off (default ON)
3. On every new post (and optional comment), ModSentinel:
   - Sends the content + rules + examples to Claude
   - Receives a typed verdict: `{ violates, which_rule, confidence, reasoning }`
   - If `violates && confidence >= threshold && !dry_run` → reports to mod queue with reasoning attached
   - Always logs the decision to a per-install audit store for later review
4. Mods see flagged items in mod queue with a one-line reason like:
   > `ModSentinel (Rule 1, 92% conf) — Calls users "morons" and dismisses anyone who agrees with them. Direct personal attack.`

## Tech

- **TypeScript** on the [Devvit](https://developers.reddit.com) platform (runs on Reddit's servers)
- **Claude API** (Haiku 4.5 by default, Sonnet 4.6 / Opus 4.7 selectable)
- **Zod** for schema-validated parser
- **Vitest** with 49 unit tests (mocked Claude responses)

## Project structure

```
src/
├── main.ts                     # Devvit entry — trigger registration + classify() orchestrator
├── types.ts                    # Zod schemas: Rule, Example, Verdict, SubredditConfig, AuditEntry
├── settings.ts                 # Devvit settings schema + loadConfig() reader
├── classifier/
│   ├── claude.ts               # Claude Messages API client (fetch-based, no SDK dep)
│   ├── prompt.ts               # System prompt + user prompt builder
│   └── parser.ts               # JSON response parser + format coercion
├── rules/
│   └── normalize.ts            # Rules-text → Rule[] parser; truncation
└── moderation/
    ├── flag.ts                 # Decide whether to flag; build mod queue report reason
    └── audit.ts                # Per-install audit log (Redis hash) with TP/FP feedback
test/
├── fixtures.ts                 # Realistic rules + sample posts (clean / each violation type / ambiguous / injection / off-topic)
├── parser.test.ts              # 12 tests — JSON coercion, format variants, error modes
├── classifier.test.ts          # 10 tests — happy path, retries, auth/server errors, prompt injection passthrough
├── rules.test.ts               # 8 tests — Reddit API → Rule[], plain-text parsing, truncation
├── prompt.test.ts              # 6 tests — prompt structure, content delimiting, schema presence
├── flag.test.ts                # 7 tests — threshold gating, dry-run, mod queue reason building
└── audit.test.ts               # 6 tests — record / read / mod feedback / precision stats
```

## Testing

```bash
npm install
npm run test          # 49 tests, ~2s
npm run build         # tsc --noEmit
```

Tests use mocked `fetch` so they run with zero external dependencies. No Claude API key needed for CI.

## Cost

Each classification at Haiku 4.5 rates:
- Input: ~600 tokens (rules + examples + content) → $0.0001
- Output: ~80 tokens (JSON verdict) → $0.00004
- **Total per post: ~$0.0002**

A subreddit with 30 modqueue items/day costs ~$0.006/day = $0.18/month. Even a 1M-member sub with 1000 posts/day is $6/month.

## Status

This is the hackathon submission build. After judging the plan is to:

1. Ship a `Best Ported App` port (`automodmail` migrated to use Claude as the classifier backend)
2. Add `RemoveContent` action with confidence-threshold ≥ 0.97 for the very-obvious cases (with mod-approval-required first install flow)
3. Build a public dashboard custom-post type showing per-sub precision over time

## License

MIT — see [LICENSE](LICENSE).
