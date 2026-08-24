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
}

const MAX_WRITE_ATTEMPTS = 3
const PREFIX = /^\[([A-Za-z][A-Za-z -]{0,40})\]\s+/

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

Start every title with exactly one classification prefix from this list, followed by a space and a concise description in the user's language:

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

function resolveOptions(options: Record<string, unknown>): Required<Pick<SessionAutofileOptions, "enabled" | "apiBaseUrl" | "titlePrompt">> & { mappings: Record<string, Mapping> } {
  const mappings = options.mappings
  return {
    enabled: options.enabled !== false,
    apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl : "http://localhost:3000",
    titlePrompt: typeof options.titlePrompt === "string" && options.titlePrompt.trim() ? options.titlePrompt.trim() : DEFAULT_TITLE_PROMPT,
    mappings: mappings && typeof mappings === "object" && !Array.isArray(mappings) ? mappings as Record<string, Mapping> : DEFAULT_MAPPINGS,
  }
}

function parseLabel(title: string): string | undefined {
  return PREFIX.exec(title)?.[1]
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

export default (async (_input, options = {}) => {
  const config = resolveOptions(options)
  return {
    config: async (opencodeConfig) => {
      const mutableConfig = opencodeConfig as typeof opencodeConfig & { agent?: Record<string, Record<string, unknown>> }
      mutableConfig.agent ??= {}
      mutableConfig.agent.title = { ...mutableConfig.agent.title, prompt: config.titlePrompt }
    },
    event: async ({ event }) => {
      if (event.type !== "session.updated" || !config.enabled) return
      try {
        const info = event.properties.info
        const label = parseLabel(info.title)
        const mapping = label ? config.mappings[label] : undefined
        if (!info.id || !info.directory || !mapping?.folderName?.trim()) return
        const result = await moveSession(config.apiBaseUrl, info.directory, info.id, mapping.folderName)
        log(result, { sessionID: info.id, label, folderName: mapping.folderName })
      } catch (error) {
        log("filing failed; chat continues", error instanceof Error ? error.message : error)
      }
    },
  }
}) satisfies Plugin
