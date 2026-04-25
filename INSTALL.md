# Installing claude-slack-bridge

Three ways to set up the Slack app side. Pick whichever fits — they all produce the same `.env`.

| Path | Effort | Best when |
|---|---|---|
| **A. Browser-driven (Claude Code skill)** | ~3 min, mostly watching | You have Claude Code + the `claude-in-chrome` extension and don't want to fiddle with Slack's dashboard |
| **B. Interactive wizard** (`npm run setup`) | ~5 min, copy/paste tokens | You're comfortable in the Slack app dashboard and don't want to grant browser automation |
| **C. Fully manual** | ~10 min | You want to understand each step, or you're scripting from a different environment |

All three assume you've cloned the repo and run `npm install`.

---

## A. Browser-driven setup (recommended)

A Claude Code skill walks the browser through the deterministic parts (manifest paste, install, token capture, `.env` write) while you handle the parts that aren't safe to automate (login, workspace pick, "Allow" on the install consent screen).

### Prerequisites

- [Claude Code](https://claude.com/product/claude-code) CLI installed and logged in
- The [`claude-in-chrome`](https://chromewebstore.google.com/) extension installed in your Chrome browser, and at least one Chrome window open
- You're already signed in to Slack in that browser (or willing to sign in when prompted)

### What you'll do

1. From this repo's directory, start Claude Code:
   ```
   claude
   ```
2. Tell it: `/install-slack-bridge` (or just: *"set up the slack bridge"*).
3. Claude will open `https://api.slack.com/apps` in a new Chrome tab and ask you to **log in to Slack and tell it "ready"**. Do that.
4. Claude clicks through `Create New App → From a manifest`. If you have multiple Slack workspaces, Claude will **stop and ask you which one** to install into.
5. Claude pastes the manifest, clicks Create, navigates to OAuth & Permissions, and clicks `Install to Workspace`.
6. Slack shows a permission consent page. **You** click `Allow` — Claude won't click this for you. Tell it you've clicked Allow.
7. Claude reads the bot token, navigates to Basic Information, generates the app-level token (`connections:write` scope), reads that one too, and validates both against Slack's API.
8. Claude asks for your Slack user ID (`avatar → Profile → ⋯ → Copy member ID`) so it can populate `ALLOWED_USERS`. **Strongly recommended** — without it, anyone in your workspace can DM the bot.
9. Claude writes `.env` (mode 0600) and tells you the next command: `npm start`.

### What Claude will NOT do

- Type your password, deal with 2FA, or follow SSO redirects.
- Click `Allow` on the OAuth consent screen.
- Echo your tokens into the chat transcript.
- Overwrite an existing `.env` without asking.

### If something goes wrong

Slack's app dashboard UI changes a few times a year, so a button rename can break the skill. If Claude says it can't find an element it expects:

- It will describe what it sees and ask you to click the equivalent button. Do that, then say "continue".
- Worst case, fall back to **path B** (`npm run setup`) — your half-created Slack app is still usable.

---

## B. Interactive wizard (`npm run setup`)

```bash
npm run setup
```

The wizard:

1. Copies `slack-app-manifest.yaml` to your clipboard.
2. Tells you to go to https://api.slack.com/apps?new_app=1 and paste it.
3. Prompts for the bot token (`xoxb-...`) — validates it via `auth.test`.
4. Prompts for the app-level token (`xapp-...`) — validates it via `apps.connections.open`.
5. Asks for `ALLOWED_USERS` and (optional) channel restrictions / cwd.
6. Writes `.env` (mode 0600).

You're doing the same Slack-dashboard clicking as path A, just without browser automation. Read the README's "Manual setup" section for the exact dashboard navigation.

---

## C. Fully manual

See the [Manual setup](./README.md#manual-setup) section of the README. You'll create the Slack app, copy two tokens, and fill out `.env` yourself.

---

## After setup

```bash
npm start
```

You should see:

```
⚡ claude-slack-bridge running in Socket Mode (cwd=/path/to/project)
   mode: safe (Bash/Edit/Write blocked)
   per-turn timeout: 300s
   allowed users: U0123ABCD
```

Then:

- DM the bot, or `/invite @Claude Code` into a channel and `@`-mention it.
- `!cancel` aborts the current turn. `!reset` clears the channel's session.
- Read [README.md](./README.md) for `MODE=trusted`, troubleshooting, and the rest.
