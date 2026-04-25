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

The whole bridge is a single file: **`src/bridge.ts`** (~140 LOC). The pieces that aren't obvious from a quick read:

**Two Slack listeners, deliberately non-overlapping.** `app.message` only handles DMs (`channel_type === "im"`); channel messages reach the bot through `app.event("app_mention")`. The split avoids double-handling when a user @mentions the bot in a channel — both events fire, and we want exactly one response.

**One Claude Agent SDK session per Slack channel/DM,** keyed by Slack channel ID in `sessionByChannel: Map<string, string>`. The session ID comes from the SDK's `system/init` message (`message.session_id`) on the first turn and is passed back via `options.resume` on subsequent turns. Sessions are in-memory only — restarting the process resets every channel. This is intentional for v0.1.

**In-channel concurrency is serialized, not parallel.** While a query is running for a channel, additional messages for that channel queue in `queue: Map<string, ...>`; the `finally` block drains one entry and recurses. Different channels run independently.

**SDK message shape (verify before changing the `query()` call site).** The current SDK in `package.json` is `@anthropic-ai/claude-agent-sdk@^0.2.x`. Two shapes the bridge depends on, both defined in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:
- `SDKSystemMessage` — `{ type: 'system', subtype: 'init', session_id, ... }`
- `SDKAssistantMessage` — `{ type: 'assistant', message: BetaMessage }` where `message.content` is an array of blocks; we only read `{ type: 'text', text }` blocks.

If you bump the SDK, re-read those types before touching the `for await` loop. The SDK is pre-1.0 and shapes have drifted before.

**Bolt v4 import gotcha.** `@slack/bolt`'s default export *is* the `App` class. Use `import { App } from "@slack/bolt"`, not `import bolt from "@slack/bolt"; const { App } = bolt` — the latter type-checks but `App` is `undefined` at runtime.

**Tool permissions are wide open.** The Agent SDK runs with default permissions inside `CLAUDE_CWD` (defaults to `process.cwd()`). There is no allowlist, no `canUseTool`, no `permissionMode` set. Anyone who can DM or @mention the bot can run any tool the SDK exposes (file edits, bash, etc.) in that directory. A safe-mode toggle is on the roadmap but not implemented.

**Slack output chunking.** `splitForSlack()` splits long replies on paragraph/line boundaries before posting, because Slack rejects messages over ~40KB and degrades readability well before that. Each chunk becomes its own threaded post.

## Setup flow

The repo is meant to be handed to other people. `npm run setup` (`scripts/setup.mjs`) is the supported install path; the manual steps in the README mirror what the wizard does and exist as a fallback. `slack-app-manifest.yaml` is the source of truth for required scopes/events — if you add a Slack feature, update it there.
