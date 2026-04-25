import "dotenv/config"
import { App } from "@slack/bolt"
import { query } from "@anthropic-ai/claude-agent-sdk"

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

const CWD = process.env.CLAUDE_CWD ?? process.cwd()

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
})

// Slack channel/DM ID -> Claude Agent SDK session id (for resume)
const sessionByChannel = new Map<string, string>()
// Channels currently running a query — additional messages queue here
const busy = new Set<string>()
const queue = new Map<string, Array<{ text: string; threadTs: string }>>()

type IncomingMsg = { channel: string; threadTs: string; text: string }

async function handle(msg: IncomingMsg) {
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
    console.error("[bridge] query error:", err?.message ?? err)
    await postChunked(msg.channel, msg.threadTs, `:warning: Error: ${err?.message ?? "unknown"}`).catch(() => {})
  } finally {
    busy.delete(msg.channel)
    const q = queue.get(msg.channel)
    if (q && q.length > 0) {
      const next = q.shift()!
      handle({ channel: msg.channel, threadTs: next.threadTs, text: next.text })
    }
  }
}

async function runQuery({ channel, threadTs, text }: IncomingMsg) {
  const resume = sessionByChannel.get(channel)
  let buffer = ""
  let sessionId: string | undefined

  const options: Record<string, unknown> = { cwd: CWD }
  if (resume) options.resume = resume

  for await (const message of query({ prompt: text, options }) as AsyncIterable<any>) {
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

  if (sessionId) sessionByChannel.set(channel, sessionId)

  const out = buffer.trim()
  if (out) await postChunked(channel, threadTs, out)
}

async function postChunked(channel: string, threadTs: string, text: string) {
  for (const chunk of splitForSlack(text, 3500)) {
    await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk })
  }
}

function splitForSlack(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let i = rest.lastIndexOf("\n\n", max)
    if (i <= 0) i = rest.lastIndexOf("\n", max)
    if (i <= 0) i = max
    out.push(rest.slice(0, i).trim())
    rest = rest.slice(i).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

function isAllowed(channel: string) {
  return ALLOWED.length === 0 || ALLOWED.includes(channel)
}

function react(channel: string, ts: string, name = "eyes") {
  return app.client.reactions.add({ channel, timestamp: ts, name }).catch(() => {})
}

// DMs and channel messages (filtered to ones not already handled by app_mention)
app.message(async ({ message }: { message: any }) => {
  const m = message as any
  if (m.subtype || m.bot_id) return
  if (!m.text) return
  if (!isAllowed(m.channel)) return

  // In public/private channels, only respond to mentions (handled by app_mention).
  // Skip non-DM channel messages here to avoid double-handling.
  if (m.channel_type !== "im") return

  react(m.channel, m.ts)
  const threadTs = m.thread_ts ?? m.ts
  await handle({ channel: m.channel, threadTs, text: m.text })
})

// @mentions in channels
app.event("app_mention", async ({ event }: { event: any }) => {
  const m = event as any
  if (m.bot_id) return
  if (!isAllowed(m.channel)) return

  react(m.channel, m.ts)
  const text = (m.text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim()
  if (!text) return
  const threadTs = m.thread_ts ?? m.ts
  await handle({ channel: m.channel, threadTs, text })
})

;(async () => {
  await app.start()
  console.log(`⚡ claude-slack-bridge running in Socket Mode (cwd=${CWD})`)
  if (ALLOWED.length > 0) console.log(`   allowed channels: ${ALLOWED.join(", ")}`)
})()
