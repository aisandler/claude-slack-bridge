---
name: install-slack-bridge
description: Drive the browser to set up the Slack app for claude-slack-bridge — paste the manifest, install the app, generate the app-level token, capture both tokens, and write `.env`. Use when the user runs `/install-slack-bridge` or asks to "install slack", "set up the slack bridge", or similar inside this repo. Login is intentionally NOT automated — hand off to the user for that step.
---

# install-slack-bridge

You are setting up the Slack app for `claude-slack-bridge`. The user has already cloned the repo and run `npm install`. Your job is to handle the parts of the process that are mechanical and tedious (manifest paste, install button, token copy) while handing off the parts that aren't safe to automate (login, workspace pick, anything that requires user judgment).

## Required tools

This skill drives Chrome via the `claude-in-chrome` MCP server. Before any browser call, load the tool schema with `ToolSearch` (e.g. `select:mcp__claude-in-chrome__navigate`). If those tools aren't available, stop and tell the user to install the `claude-in-chrome` extension first — see `INSTALL.md` in the repo root for the prereq list.

You'll also use `Read` (manifest), `Bash` (token validation, writing `.env`), and `mcp__claude-in-chrome__get_page_text` / `find` / `javascript_tool` for reading values out of the page.

## Operating principles

- **Prefer text/aria locators over CSS.** Slack's app-config UI changes a few times a year. "Find the button whose text is `Create New App`" survives reskinning; `.btn-primary:nth-child(3)` does not.
- **After every navigation, confirm where you are** with `get_page_text` or `find` before clicking the next thing. If the page doesn't look right, stop and describe what you see to the user — don't guess.
- **Never type or capture passwords.** Login is the user's job. So is anything that requires a 2FA code, an SSO redirect, or a magic link.
- **Read tokens from the page once revealed; never echo them back to the user in chat.** Write directly to `.env` with mode 0600.

## Procedure

### 1. Pre-flight

- Confirm cwd is the `claude-slack-bridge` repo (look for `slack-app-manifest.yaml` and `package.json` with `"name": "claude-slack-bridge"`).
- Read `slack-app-manifest.yaml` so you have the YAML body in memory.
- **Ask the user what they want the bot named** (default: `Claude Code`). If they pick something else, do a literal substitution on the two `Claude Code` occurrences in the manifest — one under `display_information.name`, one under `features.bot_user.display_name`. Quote names with YAML-special chars by wrapping them in double quotes. Example: `display_name: "My Bot"`. Common reasons to rename: another app named "Claude Code" already exists in the workspace, or the user wants a project-specific identity.
- Check whether `.env` already exists. If it does, ask the user whether to overwrite before continuing.

### 2. Hand off login to the user

- Open `https://api.slack.com/apps` in a new tab via `tabs_create_mcp`.
- Tell the user: *"I've opened the Slack app dashboard. Please sign in (and pick the workspace if prompted). Tell me 'ready' once you see the 'Your Apps' page or a list of apps."*
- Wait for the user. Don't poll the page; don't try to type credentials.

### 3. Create the app from the manifest

- Once the user says ready, call `get_page_text` and verify the page mentions "Your Apps" or a "Create New App" button.
- Click `Create New App` (text-locator).
- A modal appears with options. Click `From a manifest`.
- The modal shows a workspace picker. **Stop and ask the user** which workspace if there's more than one option visible. If exactly one is selected by default, you may continue. Click `Next`.
- The next step is a YAML/JSON paste editor. Switch to the YAML tab if it isn't already selected. Paste the manifest body. (Use `javascript_tool` to set the editor's value if `form_input` doesn't reach it — Slack uses Monaco for this editor; `monaco.editor.getEditors()[0].setValue(...)` works.)
- Click `Next`, review, then `Create`.

### 4. Install to workspace + capture bot token

- After creation you land on the app's "Basic Information" page. Navigate to **OAuth & Permissions** in the left sidebar (link text).
- Click `Install to Workspace`. Slack will show a permission consent screen — **hand off to the user** to click `Allow` (this is a deliberate trust boundary; don't click it for them).
- Wait for the user to confirm they clicked Allow.
- You should now be back on **OAuth & Permissions** with a "Bot User OAuth Token" section. The token is masked behind a "Copy" / "Show" affordance. Reveal it (click `Show`) and read the value via `get_page_text` or `javascript_tool` reading the input's `value`.
- The token must start with `xoxb-`. If it doesn't, stop and show the user what you see.
- Hold the token in memory. Do **not** echo it in chat.

### 5. Generate the app-level token

- Navigate to **Basic Information** in the left sidebar.
- Scroll to **App-Level Tokens**. Click `Generate Token and Scopes`.
- A modal appears. Type a name (use `socket`). Click `Add Scope`, pick `connections:write`. Click `Generate`.
- The token is shown once. Read it from the page; it must start with `xapp-`. Copy it to memory.

### 6. Validate both tokens

Use `Bash` to call Slack's API and confirm both tokens work before writing them:

```bash
curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $BOT" | jq .
curl -s -X POST https://slack.com/api/apps.connections.open -H "Authorization: Bearer $APP" | jq .
```

Both must return `"ok": true`. If either fails, stop and tell the user what `error` came back. Do not write `.env` with a broken token.

### 7. Write `.env`

- Ask the user for their Slack user ID (offer to skip with a warning that `ALLOWED_USERS` will be empty). Recommend they paste it now: avatar → Profile → ⋯ → Copy member ID.
- Ask whether they want to set `CLAUDE_CWD` to something other than the repo, or restrict to specific channels. Defaults are fine for most users.
- Write `.env` with mode 0600 using `Bash`:
  ```bash
  umask 077 && cat > .env <<EOF
  SLACK_BOT_TOKEN=...
  SLACK_APP_TOKEN=...
  ALLOWED_USERS=...    # only if provided
  EOF
  ```
- Confirm the file was written and has mode 600 (`stat -f %A .env` on macOS, `stat -c %a .env` on Linux).

### 8. Hand back to the user

Tell them:

> Setup is complete. To start the bridge: `npm start`. The bot is named in `slack-app-manifest.yaml` (default: "Claude Code") — invite it to a channel with `/invite @Claude Code`, or just open a DM with it. Send `!cancel` to abort a turn, `!reset` to clear context. Run in safe mode by default — set `MODE=trusted` in `.env` only if you trust everyone in `ALLOWED_USERS` to run shell commands in `CLAUDE_CWD`.

## Recovery

If anything fails partway through:

- **Login problem (SSO redirect, 2FA loop, etc.)** — Slack's problem, not ours. Tell the user to finish manually and re-invoke the skill once they're past it.
- **Selector miss / UI changed** — describe what you see, ask the user to click the equivalent button, then resume from the next step.
- **Token validation fails** — the token was probably copied incompletely. Re-read from the page; if still broken, ask the user to copy/paste manually and resume from step 6.
- **`.env` already exists** — never overwrite without asking. If the user says don't overwrite, stop.

Do not retry blindly. If you've failed the same step twice with the same error, surface it and ask the user how to proceed.
