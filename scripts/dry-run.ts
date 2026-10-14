// Preview what a rules file would do against a live OpenChamber, without writing anything.
//   bun scripts/dry-run.ts <rulesFile> [apiBaseUrl] [--include-subagents]
import { readFile } from "node:fs/promises"
import { classify, expandHome, normalizeRules } from "../src/rules"

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const includeSubagents = process.argv.includes("--include-subagents")
const rulesFile = args[0]
const base = args[1] ?? "http://localhost:3000"
if (!rulesFile) {
  console.error("usage: bun scripts/dry-run.ts <rulesFile> [apiBaseUrl] [--include-subagents]")
  process.exit(2)
}

const parsed = JSON.parse(await readFile(expandHome(rulesFile), "utf8"))
const { rules, problems } = normalizeRules(Array.isArray(parsed) ? parsed : parsed.rules)
if (problems.length) console.error("rule problems:", problems)

const sessions: any[] = []
const seen = new Set<string>()
let cursor: string | undefined
for (let page = 0; page < 50; page += 1) {
  const url = new URL("/api/session", base)
  url.searchParams.set("limit", "200")
  if (cursor) url.searchParams.set("cursor", cursor)
  const body = await (await fetch(url)).json() as any
  sessions.push(...body.data)
  const next = body.cursor?.next
  if (!next || body.data.length === 0 || seen.has(next)) break
  seen.add(next)
  cursor = next
}

const folderState = await (await fetch(new URL("/api/session-folders", base))).json() as any
const currentFolder = (dir: string, id: string) =>
  (folderState.foldersMap?.[dir] ?? []).find((folder: any) => folder.sessionIds?.includes(id))?.name ?? "(none)"

const counts: Record<string, number> = {}
let active = 0
for (const session of sessions) {
  if (session.time?.archived) continue
  if (session.parentID && !includeSubagents) continue
  active += 1
  const dir = session.location?.directory
  const match = classify(session.title ?? "", dir, rules)
  const from = dir ? currentFolder(dir, session.id) : "(no dir)"
  const to = match.status === "match" ? match.folder : match.status === "unfiled" ? "[Unfiled]" : "(no rule)"
  const via = match.status === "match" ? `${match.via}:${match.detail}` : ""
  const verdict = match.status === "match" ? (from.toLowerCase() === to.toLowerCase() ? "ok  " : "MOVE") : "skip"
  counts[verdict] = (counts[verdict] ?? 0) + 1
  console.log(`${verdict}  ${from.padEnd(12)} -> ${to.padEnd(12)} ${via.padEnd(22)} ${String(session.title).slice(0, 70)}`)
}
console.log(`\n${active} active sessions considered of ${sessions.length} listed:`, counts)
