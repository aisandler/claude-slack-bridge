# claude-slack-bridge

Two-way Slack chat for your Claude Code CLI session. DM the bot or @mention it in a channel — your message is routed into a persistent Claude Code session, and the reply lands back in Slack as a thread.

- No Pipedream, no public webhook, no ngrok — uses Slack **Socket Mode**
- No Anthropic API key required if you're already logged into Claude Code (the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) inherits your CLI auth)
- One persistent session per Slack channel/DM — context carries across messages and survives bridge restarts (stored in `.sessions.json`)
- Concurrent messages in the same channel are queued and processed in order
- **Safe mode by default** — Bash, Edit, Write, and NotebookEdit are blocked unless you opt in
- **`!cancel` and `!reset`** — abort the current turn or clear a channel's session from Slack
- **Markdown is rendered as Slack mrkdwn** — bold, italic, headers, links, lists, and code fences come through correctly

## Requirements

- Node.js 20+
- Claude Code installed and logged in (`claude` on PATH, `~/.claude/` populated)
- A Slack workspace where you can install apps

## Quick start

```bash
git clone <this-repo> claude-slack-bridge
cd claude-slack-bridge
npm install
npm run setup
npm start
```

To point the bridge at a project other than the bridge repo itself, either:

```bash
# Per-launch override (positional arg):
npm start -- ~/projects/your-other-project

# Persistent (rewrites CLAUDE_CWD in .env):
npm run point -- ~/projects/your-other-project
npm start
```

`npm run setup` copies the manifest to your clipboard, walks you through creating the Slack app, prompts for both tokens (validating each against the Slack API), and writes `.env`. If you'd rather wire it up by hand, follow the manual setup below.

**Three setup paths** — see [INSTALL.md](./INSTALL.md) for a comparison. TL;DR:

- **Browser-driven** (`/install-slack-bridge` in Claude Code) — fully guided, mostly hands-off. Requires the `claude-in-chrome` extension.
- **Wizard** (`npm run setup`) — copy/paste two tokens, validates them, writes `.env`. What's shown above.
- **Manual** — see "Manual setup" below.

## Manual setup

### 1. Create the Slack app from the manifest

1. Go to **https://api.slack.com/apps** → **Create New App** → **From an app manifest**
2. Pick your workspace
3. Open `slack-app-manifest.yaml` from this repo, copy its contents, and paste into the manifest editor
4. (Optional) Edit the `name` and `display_name` fields if you want a custom bot name — both default to `Claude Code`. Useful if a workspace already has an app by that name, or you want a project-specific identity. The `npm run setup` wizard prompts for this automatically.
5. Review → **Create**

The manifest pre-configures Socket Mode + all required scopes.

### 2. Get the two tokens

**Bot token** (`xoxb-...`):
- Left sidebar → **OAuth & Permissions**
- Click **Install to Workspace** → Allow
- Copy the **Bot User OAuth Token**

**App-level token** (`xapp-...`):
- Left sidebar → **Basic Information**
- Scroll to **App-Level Tokens** → **Generate Token and Scopes**
- Name it (e.g. `socket`), add the `connections:write` scope → Generate
- Copy the token

### 3. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Optional:
- `ALLOWED_USERS=U0123ABCD,U0456EFGH` — restrict who can talk to the bot, by Slack user ID. **Strongly recommended** — without it, anyone in the workspace can DM the bot and read files via the agent's read tools. (To find your user ID: in Slack, click your avatar → Profile → ⋯ → Copy member ID.)
- `ALLOWED_CHANNELS=C0123ABCD,C0456EFGH` — restrict the bot to specific channel IDs
- `CLAUDE_CWD=/path/to/project` — working directory for the Claude Code session (defaults to current directory)
- `MODE=trusted` — allow Bash/Edit/Write/NotebookEdit. Default is safe mode (those tools blocked).
- `AGENT_TIMEOUT_MS=300000` — per-turn timeout. Default 5 minutes; abort fires `!cancel` automatically.
- `SESSIONS_FILE=/path/to/sessions.json` — where to persist per-channel session ids. Default `.sessions.json` in cwd.

### 4. Invite the bot

In any Slack channel you want it to listen in:

```
/invite @Claude Code
```

For DMs, just open a DM with the bot — no invite needed.

### 5. Run

```bash
npm start
```

You should see something like:

```
⚡ claude-slack-bridge running in Socket Mode (cwd=/path/to/project)
   mode: safe (Bash/Edit/Write blocked)
   per-turn timeout: 300s
   allowed users: U0123ABCD
```

If `ALLOWED_USERS` is empty you'll get a warning instead — set it before letting anyone else into the workspace.

## Usage

- **DM the bot** — every message is routed into the session
- **@mention in a channel** — `@Claude Code can you summarize the latest commit?`
- **Group DMs (mpim)** — bot only responds when explicitly @mentioned, so it won't talk over a normal group conversation
- **Replies appear in-thread** — the bot replies to the originating message's thread
- **`!cancel`** — abort the in-flight turn for this channel
- **`!reset`** — drop the session for this channel (next message starts a fresh one); also aborts an in-flight turn

The bot adds a 👀 reaction the moment it receives your message, so you know it's working.

## Keeping it running

The bridge is a long-lived process. Options:

- **pm2**: `npm install -g pm2 && pm2 start "npm start" --name claude-slack-bridge`
- **Docker**: standard Node 20 image, copy repo, `npm ci`, `CMD ["npm","start"]`
- **macOS LaunchAgent / systemd**: write a unit pointing at `npm --prefix /path/to/repo start`

## Limits and gotchas

- **One workspace per bridge instance.** Run multiple instances for multiple workspaces.
- **One session per channel.** Messages while the agent is thinking are queued and drained when it finishes.
- **Safe mode is the default.** Bash, Edit, Write, and NotebookEdit are blocked. Read/Grep/Glob/WebFetch/WebSearch still work, so the bot can still answer questions about your repo. Set `MODE=trusted` to enable mutating tools — and only do that if you trust everyone who can DM or @mention the bot.
- **First reply may be slow** if the SDK has to spin up; subsequent messages reuse the session.
- **Reset a channel's session** with `!reset` in the channel/DM. Sessions are persisted to `.sessions.json` so a restart preserves context; if the SDK rejects a stale session id (e.g. after an SDK upgrade), the bridge transparently retries with a fresh one. To wipe everything, stop the bridge and delete `.sessions.json`.
- **Cancel a runaway turn** with `!cancel`. Turns also auto-abort after `AGENT_TIMEOUT_MS` (default 5 minutes).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not_in_channel` | Run `/invite @Claude Code` in that channel |
| `missing_scope` | Reinstall the app from **OAuth & Permissions** after editing scopes |
| `invalid_auth` | Bot token expired or revoked — rotate in OAuth & Permissions, update `.env` |
| Socket Mode connect fails | App-level token missing `connections:write` — regenerate with that scope |
| Bot replies twice | You added scopes/events outside the manifest — verify against `slack-app-manifest.yaml` |
| Replies are empty | The agent ran tools but produced no text — check the bridge logs for errors |
| Bot ignores you | Your Slack user ID isn't in `ALLOWED_USERS`. Find your ID (avatar → Profile → ⋯ → Copy member ID) and add it to `.env`, then restart. |
| Agent operating on the wrong directory | Check the `cwd=...` line in the startup logs. Override with `npm start -- /correct/path` for one launch, or `npm run point -- /correct/path` to update `.env`. |
| Agent refuses to edit/run commands | You're in safe mode — set `MODE=trusted` in `.env` and restart. Read the warning before you do. |

## License

MIT
