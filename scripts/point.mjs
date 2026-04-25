#!/usr/bin/env node
// Rewrite the CLAUDE_CWD line in .env so the bridge points at a different
// project across restarts. Usage: npm run point -- /path/to/your-project
import { readFile, writeFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

const arg = process.argv[2]
if (!arg) {
  console.error("usage: npm run point -- /absolute/or/relative/path/to/project")
  process.exit(1)
}

const target = resolve(arg)
try {
  const s = await stat(target)
  if (!s.isDirectory()) {
    console.error(`✗ ${target} is not a directory`)
    process.exit(1)
  }
} catch (e) {
  console.error(`✗ ${target} not accessible: ${e?.message ?? e}`)
  process.exit(1)
}

let env = ""
try {
  env = await readFile(".env", "utf8")
} catch {
  console.error("✗ .env not found — run `npm run setup` first.")
  process.exit(1)
}

const line = `CLAUDE_CWD=${target}`
const re = /^CLAUDE_CWD=.*$/m
const next = re.test(env) ? env.replace(re, line) : env.trimEnd() + "\n" + line + "\n"

await writeFile(".env", next, { mode: 0o600 })
console.log(`✓ .env now points at ${target}`)
console.log("  Restart the bridge for the change to take effect (Ctrl-C, then `npm start`).")
