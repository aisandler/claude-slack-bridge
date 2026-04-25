// Convert CommonMark-ish output from Claude into Slack's mrkdwn dialect.
//
// Slack's rules differ from standard Markdown:
//   *bold*       (single asterisks, not **)
//   _italic_     (underscores, not single asterisks)
//   ~strike~     (single tildes, not ~~)
//   `code`       (same)
//   ```fence```  (no language tag — Slack renders it as part of the code)
//   <url|text>   (links)
//   • bullet     (no real list syntax — just leading bullets)
//   no headers   (we render them as bold lines)
//
// Strategy: pull fenced code and inline code out into placeholder tokens that
// the inline transforms can't touch, run the transforms, then re-insert.

// Use a private-use unicode char as the placeholder marker so it can't appear
// in the model's output or be mangled by the inline regex passes.
const MARK = ""
const fenceTok = (i: number) => `${MARK}F${i}${MARK}`
const codeTok = (i: number) => `${MARK}C${i}${MARK}`

export function toMrkdwn(input: string): string {
  let s = input

  const fences: string[] = []
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body) => {
    fences.push("```\n" + body.replace(/\n+$/, "") + "\n```")
    return fenceTok(fences.length - 1)
  })

  const codes: string[] = []
  s = s.replace(/`([^`\n]+)`/g, (_m, body) => {
    codes.push("`" + body + "`")
    return codeTok(codes.length - 1)
  })

  // Stash bold runs in placeholders before doing italic — Slack bold (*x*)
  // collides with Markdown italic (*x*), so we have to convert bold last.
  const bolds: string[] = []
  const boldTok = (i: number) => `${MARK}B${i}${MARK}`

  // Headers → bold line, stashed so the italic pass doesn't see *…*.
  s = s.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, body) => {
    bolds.push("*" + body + "*")
    return boldTok(bolds.length - 1)
  })
  // ***x*** and ___x___ → bold-italic
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, (_m, body) => {
    bolds.push("*_" + body + "_*")
    return boldTok(bolds.length - 1)
  })
  s = s.replace(/___([^_\n]+?)___/g, (_m, body) => {
    bolds.push("*_" + body + "_*")
    return boldTok(bolds.length - 1)
  })
  // **x** and __x__ → bold
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_m, body) => {
    bolds.push("*" + body + "*")
    return boldTok(bolds.length - 1)
  })
  s = s.replace(/__([^_\n]+?)__/g, (_m, body) => {
    bolds.push("*" + body + "*")
    return boldTok(bolds.length - 1)
  })

  // Italic *x* → _x_. Now safe — bold has been stashed.
  s = s.replace(/(^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|\S)\*(?=[^\w*]|$)/g, "$1_$2_")
  // Italic _x_ stays as-is (already Slack syntax).

  // Restore bold.
  s = s.replace(new RegExp(`${MARK}B(\\d+)${MARK}`, "g"), (_m, i) => bolds[Number(i)] ?? "")

  // Strikethrough.
  s = s.replace(/~~([^~\n]+?)~~/g, "~$1~")

  // Links.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "<$2|$1>")

  // Bullets.
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ")

  // Re-insert inline code first, then fences.
  s = s.replace(new RegExp(`${MARK}C(\\d+)${MARK}`, "g"), (_m, i) => codes[Number(i)] ?? "")
  s = s.replace(new RegExp(`${MARK}F(\\d+)${MARK}`, "g"), (_m, i) => {
    const fence = fences[Number(i)] ?? ""
    // Ensure fences sit on their own lines so Slack renders them as a block.
    return "\n" + fence + "\n"
  })

  // Collapse the extra blank lines we may have introduced around fences.
  s = s.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "")

  return s
}
