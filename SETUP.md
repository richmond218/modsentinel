# ModSentinel — Setup steps (your action items)

This doc lists what **you** (Richmond) need to do to take ModSentinel from "code on GitHub" to "submitted on Devpost." Everything else is already done.

---

## Current state of the project

✅ Done:
- 6 source files, ~700 LOC of TypeScript
- 49 unit tests, all passing
- TypeScript type-check clean
- Devvit-compatible structure (drop-in once `devvit new` runs)
- README, LICENSE (MIT), .gitignore, devvit.yaml template
- Pushed to GitHub at `github.com/richmond218/modsentinel` (after our `gh repo create` runs)

🟡 Waiting on you (in order):
1. Reddit account creation (5 min)
2. `devvit login` (2 min)
3. `devvit new` to register the app with Reddit (3 min)
4. Test subreddit creation (2 min)
5. `devvit playtest <test-sub>` (5 min)
6. Live test with sample posts (15 min)
7. Demo video recording (5 min)
8. Devpost submission (10 min)

**Total your time: ~45 min, spread however you want across the next 16 days (deadline 2026-05-27 at 6 PM PDT).**

---

## Step 1 — Reddit account (skip if you already have one)

Go to https://www.reddit.com → top right "Sign Up." Use your gmail. Pick a username — could be `richmond218` to match your GitHub, but any username works. **Verify the email** (Reddit hides app capabilities until you do).

After signup, browse two or three subreddits and upvote a few posts. Reddit's anti-spam systems sometimes restrict brand-new accounts from using Devvit until they show normal activity. This is the only "real" friction step.

## Step 2 — Install Devvit CLI (already done on this machine)

We already installed it. Verify:
```bash
devvit --version
# Should show: @devvit/cli/0.12.22 linux-arm64 node-v22.22.2
```

If reinstalling on a new machine:
```bash
npm install -g devvit
```

## Step 3 — `devvit login`

```bash
cd ~/work/03-portfolio/reddit-mod-tool
devvit login
```

This opens a browser tab on reddit.com. Sign in with the account from Step 1. The CLI receives the auth token and stores it locally — you'll only need to do this once.

## Step 4 — `devvit new` (registers the app with Reddit)

```bash
cd ~/work/03-portfolio/reddit-mod-tool
devvit new --force
```

The wizard will ask:
- App name → enter `modsentinels`
- Template → choose `blank` (we already have all our code)

Important: this step renames or overwrites our `devvit.yaml`. After it finishes, **diff to make sure our permissions are still set**:
```bash
git diff devvit.yaml
```

If the new `devvit.yaml` is missing our `http.domains: [api.anthropic.com]` entry or our `mod_actions: true`, paste them back in from the template we wrote (commit `<initial>`).

## Step 5 — Test subreddit

In a browser, go to https://www.reddit.com/subreddits/create and create a new sub. Recommend:
- Name: `r/modsentinels_test` (or any unused name)
- Type: **Private** (only you can see it — perfect for testing)
- Topic: Any (Programming works)

You're the only mod, so you can post anything. **You need to be a mod** of any sub you `playtest` to.

## Step 6 — `devvit playtest`

```bash
devvit playtest modsentinels_test
```

This deploys ModSentinel to your test sub in dev mode and tails logs. Open another terminal pane to read the log stream.

Now go to https://www.reddit.com/r/modsentinel_test and:
1. Open ModSentinel settings (click your sub → "..." → "App settings")
2. Paste your **Anthropic Claude API key** (get one at console.anthropic.com — should already be set up from your DAP work)
3. Paste your **subreddit rules** in the format:
   ```
   1. No personal attacks
   Don't insult or demean other users.

   2. No spam
   No promotional link drops.
   ```
4. Leave **Dry run = ON** for the first round
5. Save settings

## Step 7 — Live test

In r/modsentinel_test, submit:
- A clean post ("How do I fix this Python bug?") → verify log shows `violates=false`
- A violation post ("u/somebody is an idiot") → verify log shows `violates=true rule=1 conf=0.9X flagged=true` (in dry-run, queue won't change but log shows it WOULD have flagged)

Toggle dry-run OFF, post another violation, verify it actually shows up in mod queue with the ModSentinel reasoning attached.

## Step 8 — Record demo video (2-3 min)

Use Loom or OBS. Script:

> **(0:00 — settings page)**
> "ModSentinel is an AI rule-violation pre-screener for Reddit moderators. Mods install it on their sub and configure these settings — Claude API key, their sub's rules, optional examples."
>
> **(0:20 — switch to live post composer)**
> "When someone posts something that breaks a rule…"
> *Submit "u/somebody is an idiot. This sub is full of clueless people."*
>
> **(0:40 — mod queue page)**
> "…ModSentinel flags it to mod queue with reasoning, in about 3 seconds. Look at this: Rule 1, 92% confidence, and the actual reason in plain English. The mod just clicks remove. Five-second triage instead of 30."
>
> **(1:10 — settings: dry run + audit)**
> "It runs in dry-run mode by default so mods can watch its decisions for a day before letting it touch their queue. There's also an audit log that tracks every decision — mods can mark true positives and false positives to measure accuracy over time."
>
> **(1:40 — closing)**
> "Open source under MIT, tested, single-file install. Repo link in the description. Thanks for watching."

Upload to YouTube as unlisted (or Loom share link works).

## Step 9 — Submit on Devpost

Go to https://mod-tools-migration.devpost.com → "Submit Project"

Fields:
- **Project name:** ModSentinel
- **Tagline:** AI rule-violation pre-screener for Reddit moderators
- **Description:** (copy from `README.md`'s "Why it exists" and "How it works" sections)
- **Built with:** TypeScript, Devvit, Claude API, Anthropic, Zod
- **Try it out:** GitHub repo URL + the unlisted demo video URL
- **Image gallery:** Screenshot the mod queue with ModSentinel's reasoning attached, plus the settings page
- **Categories:** Best New Mod Tool (primary)

## Step 10 — If anything's blocking

When you hit any blocker, ping me with:
- The exact error message (copy-paste)
- Which step you're on
- A screenshot if visual

Common things that might come up:
- "devvit login" → maybe your Reddit account is too new, needs a few days of activity
- "devvit playtest" failing → usually a permissions issue in devvit.yaml; share `devvit.yaml` content + the error
- Claude API rate-limiting → unlikely at hackathon volume, but fix is in `src/classifier/claude.ts` (already has retry+backoff)

Worst case: skip the live deploy entirely and submit just the GitHub repo + a recorded "code walkthrough" video. Devpost accepts code-only submissions for software hackathons; live install is preferred but not required.
