import "dotenv/config"
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { resolve } from "node:path"
// NOTE: must be `import { App } from "@slack/bolt"`. The default-import form
// (`import bolt from "@slack/bolt"; const { App } = bolt`) type-checks but
// `App` is undefined at runtime — Bolt v4's default export *is* the class.
import { App } from "@slack/bolt"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { toMrkdwn } from "./mrkdwn.js"

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
if (!BOT_TOKEN || !APP_TOKEN) {
  console.error("Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN — copy .env.example to .env and fill them in.")
  process.exit(1)
}

const ALLOWED = (process.env.ALLOWED_CHANNELS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

const ALLOWED_USERS = (process.env.ALLOWED_USERS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

const CWD = process.env.CLAUDE_CWD ?? process.cwd()

// Safe mode is the default. Set MODE=trusted (or UNSAFE=1) to allow Bash/Edit/Write.
const TRUSTED = process.env.MODE === "trusted" || process.env.UNSAFE === "1"
const SAFE_DISALLOWED = ["Bash", "Edit", "Write", "NotebookEdit", "KillBash"]

// Per-turn timeout. Default 5 minutes.
const TIMEOUT_MS = (() => {
  const raw = process.env.AGENT_TIMEOUT_MS
  if (!raw) return 5 * 60 * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[bridge] invalid AGENT_TIMEOUT_MS=${raw} — using default 300000`)
    return 5 * 60 * 1000
  }
  return n
})()

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
})

// Slack channel/DM ID -> Claude Agent SDK session id (for resume).
// Persisted to SESSIONS_FILE so context survives restart. Stale session ids
// are tolerated: if the SDK rejects `resume`, runQuery() falls back to a
// fresh session for that channel.
const SESSIONS_FILE = resolve(process.env.SESSIONS_FILE ?? ".sessions.json")
const sessionByChannel: Map<string, string> = (() => {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf8")
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object") {
      const entries = Object.entries(obj).filter(
        ([k, v]) => typeof k === "string" && typeof v === "string",
      ) as Array<[string, string]>
      return new Map(entries)
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      console.error(`[bridge] could not read ${SESSIONS_FILE}: ${e?.message ?? e} — starting empty`)
    }
  }
  return new Map<string, string>()
})()

function persistSessions() {
  try {
    const tmp = SESSIONS_FILE + ".tmp"
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessionByChannel)), { mode: 0o600 })
    renameSync(tmp, SESSIONS_FILE)
  } catch (e: any) {
    console.error(`[bridge] could not persist sessions: ${e?.message ?? e}`)
  }
}
// Channels currently running a query — additional messages queue here
const busy = new Set<string>()
const queue = new Map<string, Array<{ text: string; threadTs: string }>>()
// Active AbortController per channel, used by !cancel
const inflight = new Map<string, AbortController>()

type IncomingMsg = { channel: string; threadTs: string; text: string }

async function handle(msg: IncomingMsg) {
  // Control commands run before queueing.
  const cmd = msg.text.trim().toLowerCase()
  if (cmd === "!cancel") {
    const ac = inflight.get(msg.channel)
    if (ac) {
      ac.abort()
      await postChunked(msg.channel, msg.threadTs, ":octagonal_sign: Cancelling current turn…")
    } else {
      await postChunked(msg.channel, msg.threadTs, "_Nothing running to cancel._")
    }
    return
  }
  if (cmd === "!reset") {
    sessionByChannel.delete(msg.channel)
    persistSessions()
    // If a turn is in flight, abort it — otherwise it will re-save its
    // session id on completion and silently undo the reset.
    inflight.get(msg.channel)?.abort()
    await postChunked(msg.channel, msg.threadTs, ":recycle: Session reset for this channel.")
    return
  }

  if (busy.has(msg.channel)) {
    const q = queue.get(msg.channel) ?? []
    q.push({ text: msg.text, threadTs: msg.threadTs })
    queue.set(msg.channel, q)
    return
  }
  busy.add(msg.channel)
  try {
    await runQuery(msg)
  } catch (err: any) {
    if (err?.name === "AbortError" || /aborted/i.test(err?.message ?? "")) {
      // Already messaged by !cancel or timeout path.
    } else {
      console.error("[bridge] query error:", err?.message ?? err)
      await postChunked(msg.channel, msg.threadTs, `:warning: Error: ${err?.message ?? "unknown"}`).catch(() => {})
    }
  } finally {
    busy.delete(msg.channel)
    inflight.delete(msg.channel)
    const q = queue.get(msg.channel)
    if (q && q.length > 0) {
      const next = q.shift()!
      handle({ channel: msg.channel, threadTs: next.threadTs, text: next.text })
    }
  }
}

async function runQuery({ channel, threadTs, text }: IncomingMsg) {
  const abortController = new AbortController()
  inflight.set(channel, abortController)

  const timeout = setTimeout(() => {
    abortController.abort()
    postChunked(channel, threadTs, `:hourglass: Turn exceeded ${Math.round(TIMEOUT_MS / 1000)}s — aborted. Try \`!reset\` if the session feels stuck.`).catch(() => {})
  }, TIMEOUT_MS)

  const baseOptions: Record<string, unknown> = {
    cwd: CWD,
    abortController,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  }
  if (!TRUSTED) baseOptions.disallowedTools = SAFE_DISALLOWED

  const resume = sessionByChannel.get(channel)
  let buffer = ""
  let sessionId: string | undefined

  // Run the SDK loop. If `resume` is set and the SDK rejects it (stale session
  // from a previous process / SDK upgrade), drop the session and retry once
  // with a fresh one so the user isn't forced to `!reset`.
  const drain = async (opts: Record<string, unknown>) => {
    buffer = ""
    sessionId = undefined
    for await (const message of query({ prompt: text, options: opts }) as AsyncIterable<any>) {
      if (message.type === "system" && message.subtype === "init" && message.session_id) {
        sessionId = message.session_id
      } else if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            buffer += block.text
          }
        }
      }
    }
  }

  try {
    try {
      await drain(resume ? { ...baseOptions, resume } : baseOptions)
    } catch (err: any) {
      const aborted = err?.name === "AbortError" || /aborted/i.test(err?.message ?? "")
      if (resume && !aborted && /resum|session/i.test(err?.message ?? "")) {
        console.error(`[bridge] resume failed for ${channel} (${err?.message ?? err}) — retrying with fresh session`)
        sessionByChannel.delete(channel)
        persistSessions()
        await drain(baseOptions)
      } else {
        throw err
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  if (sessionId) {
    const prev = sessionByChannel.get(channel)
    sessionByChannel.set(channel, sessionId)
    if (prev !== sessionId) persistSessions()
  }

  const out = buffer.trim()
  if (out) {
    await postChunked(channel, threadTs, toMrkdwn(out))
  } else if (!abortController.signal.aborted) {
    await postChunked(channel, threadTs, "_(no text response — the agent finished without producing output)_")
  }
}

async function postChunked(channel: string, threadTs: string, text: string) {
  for (const chunk of splitForSlack(text, 3500)) {
    await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk })
  }
}

// Split on paragraph/line boundaries while keeping fenced code blocks intact.
// If a chunk would close mid-fence, we close it with ``` and re-open the next chunk
// with the same fence so Slack renders both halves as code.
function splitForSlack(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  let openFence: string | null = null

  while (rest.length > max) {
    let i = rest.lastIndexOf("\n\n", max)
    if (i <= 0) i = rest.lastIndexOf("\n", max)
    if (i <= 0) i = max
    let head = rest.slice(0, i)
    rest = rest.slice(i)

    const prefix = openFence ? openFence + "\n" : ""
    const fenceCount = (head.match(/```/g) ?? []).length
    // Source's fence state at end of head = openAtStart XOR (fenceCount odd).
    const endsOpen: boolean = (fenceCount % 2 === 1) !== !!openFence
    const suffix = endsOpen ? "\n```" : ""
    openFence = endsOpen ? "```" : null
    out.push((prefix + head.trim() + suffix).trim())
  }
  if (rest.trim()) {
    const prefix = openFence ? openFence + "\n" : ""
    out.push((prefix + rest.trim()).trim())
  }
  return out.filter(Boolean)
}

function isAllowed(channel: string, user: string | undefined) {
  if (ALLOWED.length > 0 && !ALLOWED.includes(channel)) return false
  if (ALLOWED_USERS.length > 0 && (!user || !ALLOWED_USERS.includes(user))) return false
  return true
}

function react(channel: string, ts: string, name = "eyes") {
  return app.client.reactions.add({ channel, timestamp: ts, name }).catch(() => {})
}

// DMs and group DMs (mpim). Channel @mentions go through app_mention below;
// public/private channel messages without a mention are intentionally ignored.
app.message(async ({ message }: { message: any }) => {
  const m = message as any
  if (m.subtype || m.bot_id) return
  if (!m.text) return
  if (!isAllowed(m.channel, m.user)) return

  // Handle DMs and multi-person DMs here. Public/private channel messages
  // reach the bot via app_mention so we don't double-respond.
  if (m.channel_type !== "im" && m.channel_type !== "mpim") return

  react(m.channel, m.ts)
  const threadTs = m.thread_ts ?? m.ts
  // In mpim the bot sees every message — only respond if it was @mentioned.
  let text = m.text as string
  if (m.channel_type === "mpim") {
    if (!/<@[A-Z0-9]+>/.test(text)) return
    text = text.replace(/<@[A-Z0-9]+>\s*/g, "").trim()
    if (!text) return
  }
  await handle({ channel: m.channel, threadTs, text })
})

// @mentions in public/private channels
app.event("app_mention", async ({ event }: { event: any }) => {
  const m = event as any
  if (m.bot_id) return
  if (!isAllowed(m.channel, m.user)) return

  react(m.channel, m.ts)
  const text = (m.text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim()
  if (!text) return
  const threadTs = m.thread_ts ?? m.ts
  await handle({ channel: m.channel, threadTs, text })
})

// Graceful shutdown so in-flight turns can abort cleanly.
async function shutdown(sig: string) {
  console.log(`\n[bridge] ${sig} received — aborting in-flight turns and stopping…`)
  for (const ac of inflight.values()) ac.abort()
  persistSessions()
  try { await app.stop() } catch {}
  process.exit(0)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

;(async () => {
  await app.start()
  const mode = TRUSTED ? "TRUSTED (Bash/Edit/Write enabled)" : "safe (Bash/Edit/Write blocked)"
  console.log(`⚡ claude-slack-bridge running in Socket Mode (cwd=${CWD})`)
  console.log(`   mode: ${mode}`)
  console.log(`   per-turn timeout: ${Math.round(TIMEOUT_MS / 1000)}s`)
  if (ALLOWED.length > 0) console.log(`   allowed channels: ${ALLOWED.join(", ")}`)
  if (ALLOWED_USERS.length > 0) {
    console.log(`   allowed users: ${ALLOWED_USERS.join(", ")}`)
  } else {
    console.log("   ⚠  ALLOWED_USERS is empty — anyone in the workspace can DM the bot. Set ALLOWED_USERS=U... in .env to restrict.")
  }
  if (TRUSTED) {
    console.log("   ⚠  TRUSTED mode — anyone allowed can run shell commands and edit files in CWD.")
  }
})()
