# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps
- `npm run setup` — interactive wizard: copies the Slack manifest to clipboard, prompts for bot + app tokens (validates each via `auth.test` and `apps.connections.open`), writes `.env`
- `npm start` — run the bridge (`tsx src/bridge.ts`)
- `npm run dev` — same with `tsx watch`
- `npx tsc --noEmit` — type-check only (the project never emits JS; `tsx` runs TS directly)

There is no test suite and no linter configured.

## Architecture

Two source files: **`src/bridge.ts`** (Slack ↔ Agent SDK glue) and **`src/mrkdwn.ts`** (CommonMark → Slack mrkdwn translator). The pieces that aren't obvious from a quick read:

**Two Slack listeners, deliberately non-overlapping.** `app.message` handles DMs (`channel_type === "im"`) and group DMs (`mpim`); public/private channel messages reach the bot through `app.event("app_mention")`. The split avoids double-handling when a user @mentions the bot in a channel — both events fire, and we want exactly one response. In `mpim` the bot also requires an explicit `<@bot>` mention (otherwise it would respond to every message in the group chat).

**One Claude Agent SDK session per Slack channel/DM,** keyed by Slack channel ID in `sessionByChannel: Map<string, string>`. The session ID comes from the SDK's `system/init` message (`message.session_id`) on the first turn and is passed back via `options.resume` on subsequent turns. The map is persisted to `SESSIONS_FILE` (default `.sessions.json`) via atomic write-then-rename after every change (post-turn, `!reset`, SIGTERM/SIGINT). On startup the file is loaded; missing/malformed file is tolerated and the bridge starts empty. If `query()` rejects a `resume` (stale id from a prior process or SDK upgrade), `runQuery` catches it, drops the entry, persists, and retries once with a fresh session — the user shouldn't have to `!reset` after a deploy.

**In-channel concurrency is serialized, not parallel.** While a query is running for a channel, additional messages for that channel queue in `queue: Map<string, ...>`; the `finally` block drains one entry and recurses. Different channels run independently.

**SDK message shape (verify before changing the `query()` call site).** The current SDK in `package.json` is `@anthropic-ai/claude-agent-sdk@^0.2.x`. Two shapes the bridge depends on, both defined in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:
- `SDKSystemMessage` — `{ type: 'system', subtype: 'init', session_id, ... }`
- `SDKAssistantMessage` — `{ type: 'assistant', message: BetaMessage }` where `message.content` is an array of blocks; we only read `{ type: 'text', text }` blocks.

If you bump the SDK, re-read those types before touching the `for await` loop. The SDK is pre-1.0 and shapes have drifted before.

**Bolt v4 import gotcha.** `@slack/bolt`'s default export *is* the `App` class. Use `import { App } from "@slack/bolt"`, not `import bolt from "@slack/bolt"; const { App } = bolt` — the latter type-checks but `App` is `undefined` at runtime.

**Permission model.** Always runs with `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` because Slack has no UI to surface approval prompts (a prompt would just hang the turn). Safety comes from `disallowedTools` instead. Two modes:
- **safe** (default) — `disallowedTools: ["Bash","Edit","Write","NotebookEdit","KillBash"]`. Read/Grep/Glob/WebFetch/WebSearch/TodoWrite still work, so the bot can still answer repo questions.
- **trusted** — set `MODE=trusted` (or legacy `UNSAFE=1`). No tool restrictions; logs a startup warning.

**Per-turn timeout + cancel.** Each `runQuery` creates an `AbortController`, registers it in `inflight: Map<string, AbortController>`, and arms a timer (`AGENT_TIMEOUT_MS`, default 5 min) that calls `abort()` and posts a warning. `!cancel` and `!reset` are intercepted in `handle()` *before* the busy/queue check so they work even while a turn is running. `!reset` deletes the channel's session id, persists, *and* aborts any in-flight turn — without the abort, the running query would re-save its session id on completion and silently undo the reset. SIGTERM/SIGINT abort all in-flight turns, persist sessions, and call `app.stop()`.

**Access control.** `isAllowed(channel, user)` gates both listeners. `ALLOWED_CHANNELS` is a channel-id allowlist; `ALLOWED_USERS` is a user-id allowlist. Empty list = no restriction on that axis. Empty `ALLOWED_USERS` triggers a loud startup warning because safe-mode read tools (`Read`/`Grep`/`Glob`) can still exfiltrate the cwd to anyone in the workspace.

**Slack mrkdwn translation.** `toMrkdwn()` in `src/mrkdwn.ts` converts the CommonMark Claude emits (`**bold**`, `*italic*`, `# headers`, `[text](url)`, `- bullets`, ` ``` ` fences) to Slack's mrkdwn dialect (`*bold*`, `_italic_`, headers as bold lines, `<url|text>`, `•` bullets, fenced code with the language tag stripped). The order matters: bold runs are stashed in unicode-private-use placeholders before italic conversion, because Slack bold (`*x*`) and Markdown italic (`*x*`) collide. Code fences and inline code are likewise stashed first so inline transforms can't touch their contents. There's a hand-rolled smoke-test harness (the README/CLAUDE never wrote one to disk) — re-test by writing a tiny tsx script that imports `toMrkdwn` and asserts output if you change the regex chain.

**Slack output chunking.** `splitForSlack()` splits long replies on paragraph/line boundaries before posting, because Slack rejects messages over ~40KB and degrades readability well before that. It also tracks open code-fence state across chunks: if a chunk would close mid-fence, it appends ```` ``` ```` and re-opens with ```` ``` ```` on the next chunk so both halves render as code. Each chunk becomes its own threaded post.

## Setup flow

The repo is meant to be handed to other people. Three install paths, documented in `INSTALL.md`:
1. **Browser-driven** — the project-local skill at `.claude/skills/install-slack-bridge/SKILL.md` drives `claude-in-chrome` to do the deterministic parts (manifest paste, install, token capture, `.env` write). Login and "Allow" on the OAuth consent screen are deliberately handed off to the user.
2. **Wizard** — `npm run setup` (`scripts/setup.mjs`).
3. **Manual** — README's "Manual setup".

`slack-app-manifest.yaml` is the source of truth for required scopes/events — if you add a Slack feature, update it there. If you change the auth/UI flow on Slack's side that the skill relies on (button text, page navigation), update `SKILL.md` too — its locator strategy is text-based, so renames break it.
