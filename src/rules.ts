import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"

// One rule = one destination folder plus every way a session can qualify for it.
// This is the single source of truth: the title-tagging prompt is generated from the
// same rules, so there is no second place that decides where sessions go.
export type Rule = {
  folder: string
  // Free text shown to the title model so it knows when to pick this rule's tag.
  description?: string
  // Bracketed tags the title model may write, e.g. "Tech" for `… [Tech]`.
  // Omitted -> defaults to [folder]. An explicit empty array means "no tag".
  tags: string[]
  // Words or phrases looked up in the session title. Case- and accent-insensitive,
  // whole words; a trailing `*` makes it a prefix match (`impuest*`).
  keywords: string[]
  // Absolute directories. A session whose working directory is this one, or inside
  // it, qualifies.
  directories: string[]
}

export type RuleMatch =
  | { status: "unfiled"; label: string }
  | { status: "none" }
  | { status: "match"; folder: string; via: "tag" | "keyword" | "directory"; detail: string; rule: Rule }

export const UNFILED_TAG = "Unfiled"

export const DEFAULT_RULES: Rule[] = [
  ["Language", "language learning, translation, or French study"],
  ["Tech", "software, IT, OpenCode/OpenChamber, infrastructure, or technical projects"],
  ["Personal", "personal organization, health, relationships, or everyday matters"],
  ["Business", "business strategy, operations, or entrepreneurship"],
  ["Sales", "accounts, prospects, CRM, deals, or outreach"],
  ["Career", "job search, professional development, or workplace decisions"],
  ["Finance", "budgeting, taxes, investments, or financial planning"],
  ["Immigration", "visas, residency, citizenship, or immigration process"],
  ["Artist", "music, creative work, artist management, or publishing"],
].map(([folder, description]) => ({ folder: folder!, description, tags: [folder!], keywords: [], directories: [] }))

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
}

// Tolerant on purpose: a malformed entry is dropped and reported, never allowed to
// turn into an unexpected folder move.
export function normalizeRules(raw: unknown): { rules: Rule[]; problems: string[] } {
  const problems: string[] = []
  const rules: Rule[] = []
  if (!Array.isArray(raw)) return { rules, problems: ["rules must be an array"] }
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`rules[${index}] is not an object`)
      return
    }
    const item = entry as Record<string, unknown>
    const folder = typeof item.folder === "string" ? item.folder.trim() : ""
    if (!folder) {
      problems.push(`rules[${index}] has no folder`)
      return
    }
    const tags = item.tags === undefined
      ? [folder]
      : strings(item.tags).filter((tag) => {
          const ok = tag.length <= 40 && !/[[\]\r\n]/.test(tag)
          if (!ok) problems.push(`rules[${index}] ignored tag ${JSON.stringify(tag)}`)
          return ok
        })
    const directories = strings(item.directories).map((dir) => dir.replace(/\/+$/, "")).filter((dir) => {
      const ok = dir.startsWith("/")
      if (!ok) problems.push(`rules[${index}] ignored non-absolute directory ${JSON.stringify(dir)}`)
      return ok
    })
    rules.push({
      folder,
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}),
      tags,
      keywords: strings(item.keywords),
      directories,
    })
  })
  return { rules, problems }
}

// Old `{ "Tag": "Folder" }` configuration, kept working: each pair becomes a rule.
export function rulesFromMappings(raw: unknown): Rule[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const byFolder = new Map<string, Rule>()
  for (const [tag, folder] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== "string" || !folder.trim()) continue
    const key = folder.trim()
    const existing = byFolder.get(key) ?? { folder: key, tags: [], keywords: [], directories: [] }
    existing.tags.push(tag)
    byFolder.set(key, existing)
  }
  return [...byFolder.values()]
}

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
}

const WORD = "\\p{L}\\p{N}"
const keywordRegexCache = new Map<string, RegExp | null>()
function keywordRegex(keyword: string): RegExp | null {
  const cached = keywordRegexCache.get(keyword)
  if (cached !== undefined) return cached
  const prefix = keyword.endsWith("*")
  const body = fold(prefix ? keyword.slice(0, -1) : keyword).trim()
  let regex: RegExp | null = null
  if (body) {
    const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
    regex = new RegExp(`(?<![${WORD}])${escaped}${prefix ? "" : `(?![${WORD}])`}`, "u")
  }
  keywordRegexCache.set(keyword, regex)
  return regex
}

function titleLabels(title: string): string[] {
  return Array.from(title.matchAll(/\[([^\]\r\n]{1,40})\]/g), (match) => match[1]!.trim()).filter(Boolean)
}

function inDirectory(directory: string, root: string): boolean {
  const dir = directory.replace(/\/+$/, "")
  return dir === root || dir.startsWith(`${root}/`)
}

// Precedence: an explicit tag (written by the title model, which saw the first
// message) beats a keyword (only the ~50-char title is visible), which beats a
// directory. Inside each level, rule order in the file decides. `[Unfiled]` is the
// model's explicit "does not fit anything" and is never overridden by keywords.
export function classify(title: string, directory: string | undefined, rules: Rule[]): RuleMatch {
  const labels = titleLabels(title)
  if (labels.some((label) => fold(label) === fold(UNFILED_TAG))) return { status: "unfiled", label: UNFILED_TAG }

  for (const label of labels) {
    const rule = rules.find((candidate) => candidate.tags.some((tag) => fold(tag) === fold(label)))
    if (rule) return { status: "match", folder: rule.folder, via: "tag", detail: label, rule }
  }

  const haystack = fold(title)
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (keywordRegex(keyword)?.test(haystack)) return { status: "match", folder: rule.folder, via: "keyword", detail: keyword, rule }
    }
  }

  if (directory) {
    for (const rule of rules) {
      const root = rule.directories.find((candidate) => inDirectory(directory, candidate))
      if (root) return { status: "match", folder: rule.folder, via: "directory", detail: root, rule }
    }
  }
  return { status: "none" }
}

const PROMPT_INTRO = `You generate short, descriptive titles for conversations. Respond with ONLY the title text — no explanation, quotes, or ending punctuation.

Write a concise description in the user's language, then end every title with exactly one classification tag from this list:
`

const PROMPT_OUTRO = `
Keep the entire title at 50 characters or fewer. Use [Unfiled] rather than guessing a category.`

// The model is only offered tags that some rule actually maps, with the rule's own
// description, so what it can write and what the plugin can file never drift apart.
export function buildTitlePrompt(rules: Rule[]): string {
  const lines: string[] = []
  for (const rule of rules) {
    if (rule.tags.length === 0) continue
    const description = rule.description ?? `sessions that belong in the ${rule.folder} folder`
    lines.push(`- [${rule.tags[0]}] — ${description}.`)
  }
  lines.push("- [Unfiled] — the request is mixed, unclear, or does not fit one category.")
  return `${PROMPT_INTRO}\n${lines.join("\n")}\n${PROMPT_OUTRO}`
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path
}

export type RulesSource = {
  // Current rules. Cheap to call; re-reads the file only when its mtime changed.
  get(): Promise<Rule[]>
  problems(): string[]
}

// `rules` file shape: either `[...]` or `{ "rules": [...] }`. A file that stops
// parsing keeps the last good rules in force instead of silently emptying them.
export function createRulesSource(options: { rulesFile?: string; inline: Rule[]; log: (message: string, detail?: unknown) => void }): RulesSource {
  const path = options.rulesFile ? expandHome(options.rulesFile) : undefined
  let current = options.inline
  let mtimeMs = -1
  let problems: string[] = []
  let lastCheck = 0
  return {
    problems: () => problems,
    async get() {
      if (!path) return current
      const now = Date.now()
      if (now - lastCheck < 2_000) return current
      lastCheck = now
      try {
        const info = await stat(path)
        if (info.mtimeMs === mtimeMs) return current
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
        const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules
        const normalized = normalizeRules(list)
        if (normalized.rules.length === 0) throw new Error(`no valid rules (${normalized.problems.join("; ") || "empty"})`)
        current = normalized.rules
        problems = normalized.problems
        mtimeMs = info.mtimeMs
        options.log("rules file loaded", { path, rules: current.length, problems: problems.length })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        problems = [`rules file ${path}: ${message}`]
        mtimeMs = -1
        options.log("rules file unusable; keeping last good rules", message)
      }
      return current
    },
  }
}
