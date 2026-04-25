# claude-slack-bridge

Two-way Slack chat for your Claude Code CLI session. DM the bot or @mention it in a channel — your message is routed into a persistent Claude Code session, and the reply lands back in Slack as a thread.

- No Pipedream, no public webhook, no ngrok — uses Slack **Socket Mode**
- No Anthropic API key required if you're already logged into Claude Code (the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) inherits your CLI auth)
- One persistent session per Slack channel/DM — context carries across messages
- Concurrent messages in the same channel are queued and processed in order

## Requirements

- Node.js 20+
- Claude Code installed and logged in (`claude` on PATH, `~/.claude/` populated)
- A Slack workspace where you can install apps

## Setup

### 1. Clone and install

```bash
git clone <this-repo> claude-slack-bridge
cd claude-slack-bridge
npm install
```

### 2. Create the Slack app from the manifest

1. Go to **https://api.slack.com/apps** → **Create New App** → **From an app manifest**
2. Pick your workspace
3. Open `slack-app-manifest.yaml` from this repo, copy its contents, and paste into the manifest editor
4. Review → **Create**

The manifest pre-configures Socket Mode + all required scopes.

### 3. Get the two tokens

**Bot token** (`xoxb-...`):
- Left sidebar → **OAuth & Permissions**
- Click **Install to Workspace** → Allow
- Copy the **Bot User OAuth Token**

**App-level token** (`xapp-...`):
- Left sidebar → **Basic Information**
- Scroll to **App-Level Tokens** → **Generate Token and Scopes**
- Name it (e.g. `socket`), add the `connections:write` scope → Generate
- Copy the token

### 4. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Optional:
- `ALLOWED_CHANNELS=C0123ABCD,C0456EFGH` — restrict the bot to specific channel IDs
- `CLAUDE_CWD=/path/to/project` — working directory for the Claude Code session (defaults to current directory)

### 5. Invite the bot

In any Slack channel you want it to listen in:

```
/invite @Claude Code
```

For DMs, just open a DM with the bot — no invite needed.

### 6. Run

```bash
npm start
```

You should see:

```
⚡ claude-slack-bridge running in Socket Mode (cwd=/path/to/project)
```

## Usage

- **DM the bot** — every message is routed into the session
- **@mention in a channel** — `@Claude Code can you summarize the latest commit?`
- **Replies appear in-thread** — the bot replies to the originating message's thread

The bot adds a 👀 reaction the moment it receives your message, so you know it's working.

## Keeping it running

The bridge is a long-lived process. Options:

- **macOS LaunchAgent**: see `examples/launchd.plist` *(not included — write your own)*
- **pm2**: `npm install -g pm2 && pm2 start "npm start" --name claude-slack-bridge`
- **Docker**: standard Node 20 image, copy repo, `npm ci`, `CMD ["npm","start"]`

## Limits and gotchas

- **One workspace per bridge instance.** Run multiple instances for multiple workspaces.
- **One session per channel.** Messages while the agent is thinking are queued and drained when it finishes.
- **No tool approval prompts.** The Claude Agent SDK runs autonomously — make sure the working directory is one you trust the agent to operate in.
- **First reply may be slow** if the SDK has to spin up; subsequent messages reuse the session.
- **Reset a channel's session**: stop the bridge, restart it. (Sessions live in memory only.)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not_in_channel` | Run `/invite @Claude Code` in that channel |
| `missing_scope` | Reinstall the app from **OAuth & Permissions** after editing scopes |
| `invalid_auth` | Bot token expired or revoked — rotate in OAuth & Permissions, update `.env` |
| Socket Mode connect fails | App-level token missing `connections:write` — regenerate with that scope |
| Bot replies twice | You added scopes/events outside the manifest — verify against `slack-app-manifest.yaml` |
| Replies are empty | The agent ran tools but produced no text — check the bridge logs for errors |

## License

MIT
