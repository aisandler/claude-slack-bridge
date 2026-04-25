#!/usr/bin/env node
import { readFile, writeFile, access } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { stdin, stdout, platform, cwd as getCwd } from "node:process"
import { spawn } from "node:child_process"

const rl = createInterface({ input: stdin, output: stdout })
const ask = (q) => rl.question(q)

async function copyToClipboard(text) {
  const isMac = platform === "darwin"
  const isWin = platform === "win32"
  const cmd = isMac ? "pbcopy" : isWin ? "clip" : "xclip"
  const args = !isMac && !isWin ? ["-selection", "clipboard"] : []
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
      proc.on("error", () => resolve(false))
      proc.on("exit", (c) => resolve(c === 0))
      proc.stdin.write(text)
      proc.stdin.end()
    } catch {
      resolve(false)
    }
  })
}

async function fileExists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function validateBotToken(token) {
  const r = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  return r.json()
}

async function validateAppToken(token) {
  const r = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  return r.json()
}

async function main() {
  console.log("\n  claude-slack-bridge setup\n")

  if (await fileExists(".env")) {
    const ans = (await ask("  .env already exists. Overwrite? [y/N] ")).trim().toLowerCase()
    if (ans !== "y") {
      console.log("  Aborted.")
      rl.close()
      return
    }
  }

  // Step 1 — manifest
  console.log("STEP 1 — Create the Slack app from the manifest")
  const manifest = await readFile("slack-app-manifest.yaml", "utf8")
  const copied = await copyToClipboard(manifest)
  if (copied) {
    console.log("  ✓ Manifest copied to your clipboard")
  } else {
    console.log("  (Could not copy to clipboard — manifest contents below)\n")
    console.log(manifest)
  }
  console.log("\n  Open:    https://api.slack.com/apps?new_app=1")
  console.log("  Then:    'From a manifest' → choose workspace → paste (YAML tab) → Next → Create\n")
  await ask("  Press Enter once the app is created... ")

  // Step 2 — bot token
  console.log("\nSTEP 2 — Install the app and copy the bot token")
  console.log("  In your new app: OAuth & Permissions → Install to Workspace → Allow")
  console.log("  Then copy the 'Bot User OAuth Token' (starts with xoxb-)")
  let botToken, botInfo
  while (true) {
    botToken = (await ask("  Bot token: ")).trim()
    if (!botToken.startsWith("xoxb-")) {
      console.log("  ✗ Expected a token starting with 'xoxb-'")
      continue
    }
    process.stdout.write("  Validating... ")
    const v = await validateBotToken(botToken)
    if (v.ok) {
      console.log(`✓ workspace="${v.team}" bot="${v.user}"`)
      botInfo = v
      break
    }
    console.log(`✗ ${v.error}`)
  }

  // Step 3 — app token
  console.log("\nSTEP 3 — Generate an app-level token (for Socket Mode)")
  console.log("  Basic Information → App-Level Tokens → Generate Token and Scopes")
  console.log("  Name it (e.g. 'socket') → add scope 'connections:write' → Generate")
  console.log("  Copy the token (starts with xapp-)")
  let appToken
  while (true) {
    appToken = (await ask("  App token: ")).trim()
    if (!appToken.startsWith("xapp-")) {
      console.log("  ✗ Expected a token starting with 'xapp-'")
      continue
    }
    process.stdout.write("  Validating... ")
    const v = await validateAppToken(appToken)
    if (v.ok) {
      console.log("✓ Socket Mode connection established")
      break
    }
    console.log(`✗ ${v.error}`)
  }

  // Step 4 — optional working directory
  console.log("\nSTEP 4 — Optional settings")
  const here = getCwd()
  const cwdAns = (await ask(`  Working directory for Claude [${here}]: `)).trim()
  const cwd = cwdAns || here

  const allowed = (
    await ask("  Restrict to specific channel IDs (comma-separated, blank for any): ")
  ).trim()

  // Write .env
  const lines = [
    `SLACK_BOT_TOKEN=${botToken}`,
    `SLACK_APP_TOKEN=${appToken}`,
  ]
  if (cwd !== here) lines.push(`CLAUDE_CWD=${cwd}`)
  if (allowed) lines.push(`ALLOWED_CHANNELS=${allowed}`)
  await writeFile(".env", lines.join("\n") + "\n", { mode: 0o600 })
  console.log("\n  ✓ Wrote .env (mode 600)")

  console.log("\nDone. Next:")
  console.log(`   • Invite the bot in any channel:  /invite @${botInfo.user}`)
  console.log("   • Or just open a DM with it")
  console.log("   • Then run:  npm start\n")

  rl.close()
}

main().catch((e) => {
  console.error("\n  setup failed:", e?.message ?? e)
  process.exit(1)
})
