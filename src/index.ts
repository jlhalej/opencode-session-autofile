import type { Plugin } from "@opencode-ai/plugin"

type Folder = {
  id: string
  name: string
  sessionIds: string[]
  createdAt?: number
  parentId?: string | null
}

type FolderState = {
  version?: number
  rev?: number
  foldersMap?: Record<string, Folder[]>
  collapsedFolderIds?: string[]
}

type Mapping = { folderName: string }

export type SessionAutofileOptions = {
  enabled?: boolean
  apiBaseUrl?: string
  mappings?: Record<string, Mapping>
  titlePrompt?: string
  fallbackMaxAttempts?: number
  fallbackDelayMs?: number
}

const MAX_WRITE_ATTEMPTS = 3
const TAG = /\[([^\]\r\n]{1,40})\]/g
const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3
const DEFAULT_FALLBACK_DELAY_MS = 500

const DEFAULT_MAPPINGS: Record<string, Mapping> = {
  Language: { folderName: "Language" },
  Tech: { folderName: "Tech" },
  Personal: { folderName: "Personal" },
  Business: { folderName: "Business" },
  Sales: { folderName: "Sales" },
  Career: { folderName: "Career" },
  Finance: { folderName: "Finance" },
  Immigration: { folderName: "Immigration" },
  Artist: { folderName: "Artist" },
}

const DEFAULT_TITLE_PROMPT = `You generate short, descriptive titles for conversations. Respond with ONLY the title text — no explanation, quotes, or ending punctuation.

Write a concise description in the user's language, then end every title with exactly one classification tag from this list:

- [Language] — language learning, translation, or French study.
- [Tech] — software, IT, OpenCode/OpenChamber, infrastructure, or technical projects.
- [Personal] — personal organization, health, relationships, or everyday matters.
- [Business] — business strategy, operations, or entrepreneurship.
- [Sales] — accounts, prospects, CRM, deals, or outreach.
- [Career] — job search, professional development, or workplace decisions.
- [Finance] — budgeting, taxes, investments, or financial planning.
- [Immigration] — visas, residency, citizenship, or immigration process.
- [Artist] — music, creative work, artist management, or publishing.
- [Unfiled] — the request is mixed, unclear, or does not fit one category.

Keep the entire title at 50 characters or fewer. Use [Unfiled] rather than guessing a category.`

function log(message: string, detail?: unknown) {
  console.error("[session-autofile]", message, detail ?? "")
}

function resolveOptions(options: Record<string, unknown>): Required<Pick<SessionAutofileOptions, "enabled" | "apiBaseUrl" | "titlePrompt" | "fallbackMaxAttempts" | "fallbackDelayMs">> & { mappings: Record<string, Mapping> } {
  const mappings = options.mappings
  const fallbackMaxAttempts = options.fallbackMaxAttempts
  const fallbackDelayMs = options.fallbackDelayMs
  return {
    enabled: options.enabled !== false,
    apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl : "http://localhost:3000",
    titlePrompt: typeof options.titlePrompt === "string" && options.titlePrompt.trim() ? options.titlePrompt.trim() : DEFAULT_TITLE_PROMPT,
    mappings: mappings && typeof mappings === "object" && !Array.isArray(mappings) ? mappings as Record<string, Mapping> : DEFAULT_MAPPINGS,
    fallbackMaxAttempts: typeof fallbackMaxAttempts === "number" && Number.isInteger(fallbackMaxAttempts) && fallbackMaxAttempts >= 1 && fallbackMaxAttempts <= 10 ? fallbackMaxAttempts : DEFAULT_FALLBACK_MAX_ATTEMPTS,
    fallbackDelayMs: typeof fallbackDelayMs === "number" && Number.isFinite(fallbackDelayMs) && fallbackDelayMs >= 0 && fallbackDelayMs <= 5_000 ? fallbackDelayMs : DEFAULT_FALLBACK_DELAY_MS,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseLabels(title: string): string[] {
  return Array.from(title.matchAll(TAG), (match) => match[1].trim()).filter(Boolean)
}

type Classification =
  | { status: "no-tag" }
  | { status: "unmapped"; label: string }
  | { status: "mapped"; label: string; mapping: Mapping }

function classifyTitle(title: string, mappings: Record<string, Mapping>): Classification {
  const labels = parseLabels(title)
  if (labels.length > 0) {
    for (const label of labels) {
      const mapping = mappings[label]
      if (mapping?.folderName?.trim()) return { status: "mapped", label, mapping }
    }
    return { status: "unmapped", label: labels[0] }
  }
  return { status: "no-tag" }
}

function apiUrl(apiBaseUrl: string, path: string) {
  return new URL(path, apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`).toString()
}

async function getFolderState(apiBaseUrl: string): Promise<FolderState> {
  const response = await fetch(apiUrl(apiBaseUrl, "/api/session-folders"), { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`GET /api/session-folders returned HTTP ${response.status}`)
  const state = await response.json()
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid session-folder response")
  return state as FolderState
}

async function writeFolderState(apiBaseUrl: string, state: FolderState, baseRev: number): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/session-folders"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: typeof state.version === "number" ? state.version : 1,
      baseRev,
      foldersMap: state.foldersMap ?? {},
      collapsedFolderIds: state.collapsedFolderIds ?? [],
      updatedAt: Date.now(),
    }),
    signal: AbortSignal.timeout(5_000),
  })
}

async function moveSession(apiBaseUrl: string, scope: string, sessionID: string, folderName: string): Promise<"moved" | "created-and-moved" | "already-filed" | "folder-ambiguous"> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const state = await getFolderState(apiBaseUrl)
    const foldersMap = state.foldersMap ?? (state.foldersMap = {})
    const folders = foldersMap[scope] ?? (foldersMap[scope] = [])
    const targets = folders.filter((folder) => folder.name?.trim().toLocaleLowerCase() === folderName.trim().toLocaleLowerCase())
    if (targets.length > 1) return "folder-ambiguous"

    const created = targets.length === 0
    if (created) {
      const folder: Folder = { id: crypto.randomUUID(), name: folderName.trim(), sessionIds: [], createdAt: Date.now(), parentId: null }
      targets.push(folder)
      folders.push(folder)
    }

    const target = targets[0]
    const targetSessionIDs = Array.isArray(target.sessionIds) ? target.sessionIds : []
    const appearsOnlyInTarget = folders.every((folder) => !Array.isArray(folder.sessionIds) || !folder.sessionIds.includes(sessionID) || folder.id === target.id)
    if (appearsOnlyInTarget && targetSessionIDs.includes(sessionID)) return "already-filed"

    for (const folder of folders) {
      const current = Array.isArray(folder.sessionIds) ? folder.sessionIds : []
      folder.sessionIds = folder.id === target.id
        ? [...new Set([...current.filter((id) => id !== sessionID), sessionID])]
        : current.filter((id) => id !== sessionID)
    }

    const response = await writeFolderState(apiBaseUrl, state, typeof state.rev === "number" ? state.rev : 0)
    if (response.ok) return created ? "created-and-moved" : "moved"
    if (response.status !== 409) throw new Error(`POST /api/session-folders returned HTTP ${response.status}`)
  }
  throw new Error("OpenChamber folder state changed too often to file the session")
}

export default (async (input, options = {}) => {
  const config = resolveOptions(options)
  // Sessions confirmed filed (or confirmed terminally unfiled, e.g. `[Unfiled]`/unmapped
  // tag) so the fallback stops rechecking them. Session IDs are globally unique, so a
  // flat set is sufficient without directory scoping.
  const resolvedSessions = new Set<string>()
  // Guards against two overlapping fallback retry loops for the same session if
  // `session.idle` fires again while a loop is already in flight.
  const pendingFallback = new Set<string>()

  async function runFallback(sessionID: string) {
    if (!config.enabled || resolvedSessions.has(sessionID) || pendingFallback.has(sessionID)) return
    pendingFallback.add(sessionID)
    try {
      for (let attempt = 0; attempt < config.fallbackMaxAttempts; attempt += 1) {
        if (attempt > 0) await delay(config.fallbackDelayMs)
        if (resolvedSessions.has(sessionID)) return

        const { data } = await input.client.session.get({ path: { id: sessionID }, signal: AbortSignal.timeout(5_000) })
        if (!data?.id || !data.directory) continue

        const classification = classifyTitle(data.title, config.mappings)
        if (classification.status === "no-tag") continue
        if (classification.status === "unmapped") {
          resolvedSessions.add(sessionID)
          log("fallback: tag unmapped, no folder", { sessionID, label: classification.label })
          return
        }

        const result = await moveSession(config.apiBaseUrl, data.directory, data.id, classification.mapping.folderName)
        resolvedSessions.add(sessionID)
        log(`fallback ${result}`, { sessionID, label: classification.label, folderName: classification.mapping.folderName })
        return
      }
    } catch (error) {
      log("fallback check failed; chat continues", error instanceof Error ? error.message : error)
    } finally {
      pendingFallback.delete(sessionID)
    }
  }

  return {
    config: async (opencodeConfig) => {
      const mutableConfig = opencodeConfig as typeof opencodeConfig & { agent?: Record<string, Record<string, unknown>> }
      mutableConfig.agent ??= {}
      mutableConfig.agent.title = { ...mutableConfig.agent.title, prompt: config.titlePrompt }
    },
    event: async ({ event }) => {
      if (!config.enabled) return

      if (event.type === "session.updated") {
        try {
          const info = event.properties.info
          const classification = classifyTitle(info.title, config.mappings)
          if (classification.status !== "mapped" || !info.id || !info.directory) return
          const result = await moveSession(config.apiBaseUrl, info.directory, info.id, classification.mapping.folderName)
          resolvedSessions.add(info.id)
          log(result, { sessionID: info.id, label: classification.label, folderName: classification.mapping.folderName })
        } catch (error) {
          log("filing failed; chat continues", error instanceof Error ? error.message : error)
        }
        return
      }

      // Fallback/catch-up path: `session.updated` delivery for the session's first
      // real, tagged title can be missed (event timing/ordering at session start).
      // `session.idle` fires reliably once the turn is over and gives us a sessionID
      // we can use to pull the session's current title directly, independent of
      // whether the triggering `session.updated` was ever observed by this plugin.
      if (event.type === "session.idle") {
        await runFallback(event.properties.sessionID)
      }
    },
  }
}) satisfies Plugin
