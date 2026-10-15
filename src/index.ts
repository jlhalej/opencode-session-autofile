import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import {
  DEFAULT_RULES,
  buildTitlePrompt,
  classify,
  createRulesSource,
  defaultRulesPath,
  normalizeRules,
  rulesFromMappings,
  type Rule,
  type RulesSource,
} from "./rules.js"

export type { Rule } from "./rules.js"

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

export type SessionAutofileOptions = {
  enabled?: boolean
  apiBaseUrl?: string
  // Single source of truth for "which sessions go where". Either inline (`rules`) or in
  // a JSON file (`rulesFile`) that is re-read whenever it changes, no restart needed.
  rules?: unknown
  rulesFile?: string
  // Legacy `{ "Tag": "Folder" }` table. Still honored when no `rules` are given.
  mappings?: Record<string, string>
  titlePrompt?: string
  // Log and record what would move, but never write to OpenChamber.
  dryRun?: boolean
  // Child/subagent sessions are filed wherever their root session goes. Set to false
  // to leave them alone.
  includeSubagents?: boolean
  fallbackMaxAttempts?: number
  fallbackDelayMs?: number
  reconcileIntervalMs?: number
}

// Minimal shape read off a session, from `ctx.session.get()` (OpenCode 2 SessionInfo)
// and from OpenChamber's `GET /api/session` listing, which uses the same fields.
type SessionInfoLike = {
  id: string
  title?: string
  parentID?: string
  location?: { directory?: string }
  time?: { archived?: number }
}

const MAX_WRITE_ATTEMPTS = 3
const WRITE_RETRY_DELAY_MS = 50
const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3
const DEFAULT_FALLBACK_DELAY_MS = 500
const DEFAULT_SWEEP_INTERVAL_MS = 600_000
const MIN_SWEEP_INTERVAL_MS = 60_000
const MAX_SWEEP_INTERVAL_MS = 86_400_000
// First sweep runs shortly after load, not immediately: firing into a server that is
// still booting risks re-entrancy.
const SWEEP_STARTUP_DELAY_MS = 20_000
// Caps *moves* (one batched write), not the scan.
const SWEEP_MAX_MOVES_PER_TICK = 100
const SWEEP_PAGE_LIMIT = 200
const SWEEP_SCAN_CAP = 5_000
const SWEEP_MAX_PAGES = 50

// Overridable so tests never write into a real host's diagnostics.
const DIAGNOSTIC_DIR = process.env.AUTOFILE_DIAGNOSTIC_DIR || "/tmp/opencode-session-autofile"

function log(message: string, detail?: unknown) {
  console.error("[session-autofile]", message, detail ?? "")
}

type ResolvedOptions = {
  enabled: boolean
  apiBaseUrl: string
  rulesFile?: string
  rulesFileOptional: boolean
  inlineRules: Rule[]
  titlePrompt?: string
  dryRun: boolean
  includeSubagents: boolean
  fallbackMaxAttempts: number
  fallbackDelayMs: number
  sweepIntervalMs: number
  configProblems: string[]
}

function resolveOptions(options: Record<string, unknown>): ResolvedOptions {
  const fallbackMaxAttempts = options.fallbackMaxAttempts
  const fallbackDelayMs = options.fallbackDelayMs
  const sweepIntervalMs = options.reconcileIntervalMs
  const configProblems: string[] = []

  let inlineRules: Rule[] = []
  if (options.rules !== undefined) {
    const normalized = normalizeRules(options.rules)
    inlineRules = normalized.rules
    configProblems.push(...normalized.problems)
  } else {
    inlineRules = rulesFromMappings(options.mappings)
  }
  const rulesFile = typeof options.rulesFile === "string" && options.rulesFile.trim() ? options.rulesFile.trim() : undefined
  // With a rules file, defaults would only be a surprise: inline stays empty until the
  // file loads. With no configuration at all, the conventional rules file is watched
  // (optional, may not exist) and the built-in domain list applies until it does.
  const unconfigured = !rulesFile && options.rules === undefined && options.mappings === undefined
  if (inlineRules.length === 0 && unconfigured) inlineRules = DEFAULT_RULES

  return {
    enabled: options.enabled !== false,
    apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl : "http://localhost:3000",
    rulesFile: rulesFile ?? (unconfigured ? defaultRulesPath() : undefined),
    rulesFileOptional: unconfigured,
    inlineRules,
    titlePrompt: typeof options.titlePrompt === "string" && options.titlePrompt.trim() ? options.titlePrompt.trim() : undefined,
    dryRun: options.dryRun === true,
    includeSubagents: options.includeSubagents !== false,
    fallbackMaxAttempts: typeof fallbackMaxAttempts === "number" && Number.isInteger(fallbackMaxAttempts) && fallbackMaxAttempts >= 1 && fallbackMaxAttempts <= 10 ? fallbackMaxAttempts : DEFAULT_FALLBACK_MAX_ATTEMPTS,
    fallbackDelayMs: typeof fallbackDelayMs === "number" && Number.isFinite(fallbackDelayMs) && fallbackDelayMs >= 0 && fallbackDelayMs <= 5_000 ? fallbackDelayMs : DEFAULT_FALLBACK_DELAY_MS,
    sweepIntervalMs: typeof sweepIntervalMs === "number" && Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= MIN_SWEEP_INTERVAL_MS && sweepIntervalMs <= MAX_SWEEP_INTERVAL_MS ? sweepIntervalMs : DEFAULT_SWEEP_INTERVAL_MS,
    configProblems,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

// OpenChamber 1.24.2 answered a stale write with HTTP 200 `{ ignored: true }`; 2.x
// merges per folder id and never signals a conflict. The retry branch below is kept so
// this behaves correctly against either: re-read and re-merge instead of false success.
async function writeFolderState(apiBaseUrl: string, state: FolderState, baseRev: number): Promise<"success" | "retry"> {
  const response = await fetch(apiUrl(apiBaseUrl, "/api/session-folders"), {
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
  if (response.status === 409) return "retry"
  if (!response.ok) throw new Error(`POST /api/session-folders returned HTTP ${response.status}`)
  const body = await response.json().catch(() => null) as { ignored?: unknown } | null
  if (body && body.ignored === true) return "retry"
  return "success"
}

// Pure lookup: the folder named `folderName` (case-insensitive) within `folders`.
// More than one folder with that exact name is `ambiguous`, never resolved by guessing.
function findFolderTarget(folders: Folder[], folderName: string): { target: Folder | null; ambiguous: boolean } {
  const matches = folders.filter((folder) => folder.name?.trim().toLocaleLowerCase() === folderName.trim().toLocaleLowerCase())
  if (matches.length > 1) return { target: null, ambiguous: true }
  return { target: matches[0] ?? null, ambiguous: false }
}

// True if `sessionID` is filed in `target` and nowhere else in `folders`.
function isSessionFiled(folders: Folder[], sessionID: string, target: Folder): boolean {
  const targetSessionIDs = Array.isArray(target.sessionIds) ? target.sessionIds : []
  const appearsOnlyInTarget = folders.every((folder) => !Array.isArray(folder.sessionIds) || !folder.sessionIds.includes(sessionID) || folder.id === target.id)
  return appearsOnlyInTarget && targetSessionIDs.includes(sessionID)
}

type Placement = "already-filed" | "misfiled" | "ambiguous"
function classifyPlacement(folders: Folder[], sessionID: string, folderName: string): Placement {
  const { target, ambiguous } = findFolderTarget(folders, folderName)
  if (ambiguous) return "ambiguous"
  if (!target) return "misfiled"
  return isSessionFiled(folders, sessionID, target) ? "already-filed" : "misfiled"
}

type MoveItem = { scope: string; sessionID: string; folderName: string }
type MoveResult = "moved" | "created-and-moved" | "already-filed" | "folder-ambiguous"

// Applies any number of moves with ONE read-modify-write of the whole folder blob, so
// a sweep over a large backlog is one POST, not one per session. Already-filed items
// cost nothing: when nothing changes there is no POST at all.
async function moveSessions(apiBaseUrl: string, items: MoveItem[]): Promise<Map<string, MoveResult>> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(WRITE_RETRY_DELAY_MS)
    const state = await getFolderState(apiBaseUrl)
    const foldersMap = state.foldersMap ?? (state.foldersMap = {})
    const results = new Map<string, MoveResult>()
    let changed = false

    for (const item of items) {
      const folders = foldersMap[item.scope] ?? (foldersMap[item.scope] = [])
      const { target: existingTarget, ambiguous } = findFolderTarget(folders, item.folderName)
      if (ambiguous) {
        results.set(item.sessionID, "folder-ambiguous")
        continue
      }
      const created = !existingTarget
      const target = existingTarget ?? (() => {
        const folder: Folder = { id: crypto.randomUUID(), name: item.folderName.trim(), sessionIds: [], createdAt: Date.now(), parentId: null }
        folders.push(folder)
        return folder
      })()
      if (!created && isSessionFiled(folders, item.sessionID, target)) {
        results.set(item.sessionID, "already-filed")
        continue
      }
      for (const folder of folders) {
        const current = Array.isArray(folder.sessionIds) ? folder.sessionIds : []
        folder.sessionIds = folder.id === target.id
          ? [...new Set([...current.filter((id) => id !== item.sessionID), item.sessionID])]
          : current.filter((id) => id !== item.sessionID)
      }
      changed = true
      results.set(item.sessionID, created ? "created-and-moved" : "moved")
    }

    if (!changed) return results
    const outcome = await writeFolderState(apiBaseUrl, state, typeof state.rev === "number" ? state.rev : 0)
    if (outcome === "success") return results
  }
  throw new Error("OpenChamber rejected or ignored the write too many times to file the session(s)")
}

async function moveSession(apiBaseUrl: string, scope: string, sessionID: string, folderName: string): Promise<MoveResult> {
  const results = await moveSessions(apiBaseUrl, [{ scope, sessionID, folderName }])
  return results.get(sessionID) ?? "already-filed"
}

function archivedAt(session: SessionInfoLike): number {
  return typeof session.time?.archived === "number" ? session.time.archived : 0
}

// A subagent session is filed wherever its root (top-level) session goes, so its own
// title and directory are never classified. `getParent` returns null when the parent
// cannot be read, in which case the child is left alone rather than guessed at.
const MAX_PARENT_DEPTH = 10
async function resolveRoot(session: SessionInfoLike, getParent: (id: string) => Promise<SessionInfoLike | null>): Promise<SessionInfoLike | null> {
  let current = session
  const seen = new Set<string>([session.id])
  for (let depth = 0; current.parentID; depth += 1) {
    if (depth >= MAX_PARENT_DEPTH || seen.has(current.parentID)) return null
    const parent = await getParent(current.parentID)
    if (!parent?.id) return null
    seen.add(parent.id)
    current = parent
  }
  return current
}

// ---------------------------------------------------------------------------------
// Periodic sweep. It reads sessions from OpenChamber's own `GET /api/session` (global,
// cursor-paginated), not from the plugin context: the V2 plugin context has no
// `session.list`. One sweep runs per process regardless of how many directories load
// this plugin — the list is global, so per-directory sweeps would only repeat work.
// ---------------------------------------------------------------------------------

type SweepInstance = {
  config: ResolvedOptions
  source: RulesSource
}

// OpenCode creates one plugin instance per location (directory) and disposes idle ones
// (about an hour in practice), so instance lifetime is not process lifetime. The sweep
// therefore belongs to the module, not to any instance: it keeps running on the last
// known configuration after every instance is gone, and each newly loaded instance
// replaces that configuration and asks for a catch-up pass. A session created while no
// instance for its directory was loaded is picked up by that pass.
const shared = {
  instances: new Map<symbol, SweepInstance>(),
  lastKnown: undefined as SweepInstance | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  sweeping: false,
  lastSweepAt: 0,
}

// Session ids with an event-path attempt in flight; module-level so the sweep can
// skip them regardless of which directory's instance owns the attempt.
const inFlight = new Set<string>()

async function fetchSessionPage(apiBaseUrl: string, cursor?: string): Promise<{ data: SessionInfoLike[]; next?: string }> {
  const url = new URL(apiUrl(apiBaseUrl, "/api/session"))
  url.searchParams.set("limit", String(SWEEP_PAGE_LIMIT))
  if (cursor) url.searchParams.set("cursor", cursor)
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`GET /api/session returned HTTP ${response.status}`)
  const body = await response.json() as { data?: unknown; cursor?: { next?: string | null } }
  if (!body || !Array.isArray(body.data)) throw new Error("GET /api/session returned an unexpected shape")
  return { data: body.data as SessionInfoLike[], next: body.cursor?.next ?? undefined }
}

// Stop conditions are copied from how OpenChamber itself walks this endpoint: the last
// page still carries a `next` cursor, so "no cursor" alone is not enough — an empty page
// or an already-seen cursor also ends the walk.
async function listAllSessions(apiBaseUrl: string): Promise<{ sessions: SessionInfoLike[]; truncated: boolean }> {
  const sessions: SessionInfoLike[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const result = await fetchSessionPage(apiBaseUrl, cursor)
    sessions.push(...result.data)
    if (!result.next || result.data.length === 0 || seen.has(result.next)) return { sessions, truncated: false }
    if (sessions.length >= SWEEP_SCAN_CAP) return { sessions, truncated: true }
    seen.add(result.next)
    cursor = result.next
  }
  return { sessions, truncated: true }
}

async function fetchSession(apiBaseUrl: string, sessionID: string): Promise<SessionInfoLike | null> {
  const response = await fetch(apiUrl(apiBaseUrl, `/api/session/${encodeURIComponent(sessionID)}`), { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) return null
  const body = await response.json() as { data?: SessionInfoLike } | SessionInfoLike | null
  const record = body && typeof body === "object" && "data" in body && body.data ? body.data : body
  return record && typeof (record as SessionInfoLike).id === "string" ? record as SessionInfoLike : null
}

async function writeSweepDiagnostic(detail: Record<string, unknown>) {
  try {
    await mkdir(DIAGNOSTIC_DIR, { recursive: true })
    await writeFile(`${DIAGNOSTIC_DIR}/sweep-${process.pid}.json`, JSON.stringify({ pid: process.pid, recordedAt: new Date().toISOString(), ...detail }, null, 2), { mode: 0o600 })
  } catch (error) {
    log("sweep: could not record diagnostic", error instanceof Error ? error.message : error)
  }
}

function currentSweepInstance(): SweepInstance | undefined {
  let latest: SweepInstance | undefined
  for (const instance of shared.instances.values()) latest = instance
  return latest ?? shared.lastKnown
}

async function sweepTick(): Promise<void> {
  const instance = currentSweepInstance()
  if (!instance || !instance.config.enabled) return
  if (shared.sweeping) return
  shared.sweeping = true
  shared.lastSweepAt = Date.now()
  const { config, source } = instance
  const stats = { listed: 0, archivedSkipped: 0, subagentsSkipped: 0, rootUnavailable: 0, inFlight: 0, noRule: 0, alreadyFiled: 0, moved: 0, deferred: 0, ambiguous: 0, staleSkipped: 0 }
  let phase = "completed"
  let failure: string | undefined
  let truncated = false
  const plan: Array<{ sessionID: string; title: string; scope: string; folder: string; via: string; detail: string }> = []
  try {
    const rules = await source.get()
    const listing = await listAllSessions(config.apiBaseUrl)
    truncated = listing.truncated
    stats.listed = listing.sessions.length
    if (truncated) log("sweep: session count exceeds the scan cap; this pass is NOT complete", { cap: SWEEP_SCAN_CAP })

    const listed = new Map(listing.sessions.map((entry) => [entry.id, entry]))
    const getParent = async (id: string) => listed.get(id) ?? await fetchSession(config.apiBaseUrl, id).catch(() => null)
    const folderState = await getFolderState(config.apiBaseUrl)
    const candidates: typeof plan = []
    for (const session of listing.sessions) {
      const directory = session.location?.directory
      if (!session?.id || !directory) continue
      if (archivedAt(session)) { stats.archivedSkipped += 1; continue }
      if (session.parentID && !config.includeSubagents) { stats.subagentsSkipped += 1; continue }
      if (inFlight.has(session.id)) { stats.inFlight += 1; continue }
      const root = await resolveRoot(session, getParent)
      if (!root || archivedAt(root)) { stats.rootUnavailable += 1; continue }
      const match = classify(root.title ?? "", root.location?.directory ?? directory, rules)
      if (match.status !== "match") { stats.noRule += 1; continue }
      const placement = classifyPlacement(folderState.foldersMap?.[directory] ?? [], session.id, match.folder)
      if (placement === "already-filed") { stats.alreadyFiled += 1; continue }
      if (placement === "ambiguous") { stats.ambiguous += 1; continue }
      candidates.push({ sessionID: session.id, title: session.title ?? "", scope: directory, folder: match.folder, via: match.via, detail: match.detail })
    }

    const batch = candidates.slice(0, SWEEP_MAX_MOVES_PER_TICK)
    stats.deferred = candidates.length - batch.length
    plan.push(...batch)

    if (config.dryRun) {
      phase = "completed (dry run: nothing written)"
      log("sweep dry run", { wouldMove: batch.length, ...stats })
      return
    }

    // Re-read each candidate right before writing so a title changed by the event path
    // while this sweep was running is not overwritten with a stale classification.
    const items: MoveItem[] = []
    for (const candidate of batch) {
      if (inFlight.has(candidate.sessionID)) { stats.inFlight += 1; continue }
      const fresh = await fetchSession(config.apiBaseUrl, candidate.sessionID).catch(() => null)
      const freshRoot = fresh ? await resolveRoot(fresh, (id) => fetchSession(config.apiBaseUrl, id).catch(() => null)) : null
      const freshMatch = freshRoot ? classify(freshRoot.title ?? "", freshRoot.location?.directory ?? candidate.scope, rules) : null
      if (!fresh || archivedAt(fresh) || !freshRoot || archivedAt(freshRoot) || freshMatch?.status !== "match" || freshMatch.folder !== candidate.folder) { stats.staleSkipped += 1; continue }
      items.push({ scope: candidate.scope, sessionID: candidate.sessionID, folderName: candidate.folder })
    }
    if (items.length > 0) {
      const results = await moveSessions(config.apiBaseUrl, items)
      for (const result of results.values()) {
        if (result === "folder-ambiguous") stats.ambiguous += 1
        else if (result === "already-filed") stats.alreadyFiled += 1
        else stats.moved += 1
      }
    }
    log("sweep complete", { truncated, ...stats })
  } catch (error) {
    phase = "failed"
    failure = error instanceof Error ? error.message : String(error)
    log("sweep failed; will retry next interval", failure)
  } finally {
    shared.sweeping = false
    await writeSweepDiagnostic({
      phase,
      dryRun: config.dryRun,
      truncated,
      ...stats,
      ...(failure ? { failure } : {}),
      ...(config.dryRun ? { wouldMove: plan.slice(0, 100) } : {}),
    })
  }
}

// A new instance asks for a pass soon, unless one just ran or one is about to.
function requestSweepSoon() {
  if (Date.now() - shared.lastSweepAt < 60_000) return
  if (shared.timer) {
    clearTimeout(shared.timer)
    shared.timer = undefined
  }
  scheduleSweep(SWEEP_STARTUP_DELAY_MS)
}

function scheduleSweep(delayMs: number) {
  if (shared.timer || !currentSweepInstance()) return
  shared.timer = setTimeout(() => {
    shared.timer = undefined
    void sweepTick().finally(() => scheduleSweep(currentSweepInstance()?.config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS))
  }, delayMs)
  shared.timer.unref?.()
}

// ---------------------------------------------------------------------------------
// `current_session` tool: lets the model ask the runtime which session it is running
// in. The id comes only from the tool-call context the runtime passes to `execute`
// (that call's own session, even for a fork, subagent or /btw child), then is
// confirmed with `session.get`. Nothing here may guess: no title search, no shared
// "current" variable, no directory lookup, and nothing from `resolveRoot` (which is for
// folder grouping and deliberately walks up to the root session).
//
// `execute` runs inside `Effect.promise`, so a rejection would become a defect rather
// than a model-visible error. Failures are therefore returned as content, never thrown.
// ---------------------------------------------------------------------------------

const CURRENT_SESSION_TOOL = "current_session"

const CURRENT_SESSION_DESCRIPTION =
  "Returns the id, title, working directory and parent id of the session this very tool call is running in. " +
  "Takes no input. Use it whenever you need your own session id (for example to schedule a follow-up into this same conversation); " +
  "never search by title or pick the newest session instead. The id is authoritative; the title is a snapshot and may change."

type ToolContentResult = { content: string }

function currentSessionFailure(reason: string, message: string, contextSessionID?: string): ToolContentResult {
  return {
    content: JSON.stringify({
      ok: false,
      reason,
      error: message,
      ...(contextSessionID ? { contextSessionID } : {}),
      guidance: "Do not guess this session's id from a title, the newest session, an environment variable or a log. Report that the current session id is unavailable.",
    }),
  }
}

async function describeCurrentSession(
  getSession: (input: { sessionID: string }) => Promise<unknown>,
  context: unknown,
): Promise<ToolContentResult> {
  const sessionID = (context as { sessionID?: unknown } | null | undefined)?.sessionID
  if (typeof sessionID !== "string" || !sessionID) {
    return currentSessionFailure("no-context", "The runtime did not provide a session id for this tool call.")
  }
  let info: SessionInfoLike | null
  try {
    info = await getSession({ sessionID }) as SessionInfoLike | null
  } catch (error) {
    return currentSessionFailure("lookup-failed", `Could not read session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`, sessionID)
  }
  if (!info || typeof info.id !== "string" || info.id !== sessionID) {
    return currentSessionFailure("id-mismatch", `session.get did not return session ${sessionID}.`, sessionID)
  }
  const workspaceID = (info.location as { workspaceID?: unknown } | undefined)?.workspaceID
  return {
    content: JSON.stringify({
      ok: true,
      id: info.id,
      title: info.title ?? null,
      directory: info.location?.directory ?? null,
      ...(typeof workspaceID === "string" ? { workspaceID } : {}),
      ...(info.parentID ? { parentID: info.parentID } : {}),
      isChild: Boolean(info.parentID),
      archived: archivedAt(info) > 0,
    }),
  }
}

export default {
  id: "opencode-session-autofile",
  async setup(ctx) {
    // Registered first and unconditionally: it is independent of `enabled` (the filing
    // kill switch) and of the rules, so a broken rules file or `enabled: false` never
    // removes it. A host without `ctx.tool` just logs and filing carries on.
    let toolRegistration: { dispose(): Promise<void> } | undefined
    try {
      toolRegistration = await ctx.tool.transform((editor) => {
        editor.add({
          name: CURRENT_SESSION_TOOL,
          description: CURRENT_SESSION_DESCRIPTION,
          input: { type: "object", properties: {}, additionalProperties: false },
          // Direct tool, not Code Mode only: "call current_session first" must not
          // depend on going through `execute`.
          options: { codemode: false },
          execute: (_input, context) => describeCurrentSession((input) => ctx.session.get(input), context),
        })
      })
    } catch (error) {
      log("could not register the current_session tool; filing continues", error instanceof Error ? error.message : error)
    }

    const config = resolveOptions(ctx.options)
    const instanceKey = Symbol("autofile-instance")
    const source = createRulesSource({ rulesFile: config.rulesFile, optional: config.rulesFileOptional, inline: config.inlineRules, log })
    await source.get()

    // OpenChamber captures plugin stderr in an inaccessible in-memory buffer while its
    // managed OpenCode process is alive. Keep a small, non-secret status snapshot
    // outside the synced vault so an operator can tell what this instance loaded.
    const diagnosticPath = typeof ctx.location.directory === "string"
      ? `${DIAGNOSTIC_DIR}/${process.pid}-${createHash("sha256").update(ctx.location.directory).digest("hex").slice(0, 12)}.json`
      : null
    const startedAt = new Date().toISOString()
    async function diagnostic(phase: string, detail: Record<string, unknown> = {}) {
      if (!diagnosticPath) return
      try {
        const rules = await source.get()
        await mkdir(DIAGNOSTIC_DIR, { recursive: true })
        await writeFile(diagnosticPath, JSON.stringify({
          pid: process.pid,
          directory: ctx.location.directory,
          opencodeVersion: ctx.app.version,
          startedAt,
          recordedAt: new Date().toISOString(),
          phase,
          dryRun: config.dryRun,
          rulesFile: config.rulesFile,
          rules: rules.map((rule) => ({ folder: rule.folder, tags: rule.tags, keywords: rule.keywords.length, directories: rule.directories })),
          problems: [...config.configProblems, ...source.problems()],
          ...detail,
        }, null, 2), { mode: 0o600 })
      } catch (error) {
        log("could not record diagnostic", error instanceof Error ? error.message : error)
      }
    }

    // Replaces OpenCode's native title-generation prompt for every title request. The
    // default prompt is generated from the rules each time, so editing the rules file
    // changes which tags the model may write without restarting anything.
    const titleHook = await ctx.session.hook("title", async (request) => {
      const text = config.titlePrompt ?? buildTitlePrompt(await source.get())
      request.system = [{ type: "text", text }]
    })

    // Shared body for the immediate path (session.created / session.renamed) and the
    // bounded-retry path (session.execution.*). It always works from a fresh
    // `session.get` — V2 event payloads are partial (e.g. `session.renamed` carries only
    // `{ title, sessionID }`). There is deliberately no "already handled" memory: the
    // rules are evaluated again on every call, and a session already in the right
    // folder costs one GET and no write, so a stray move is corrected on the session's
    // next activity instead of staying wrong until a restart.
    async function classifyAndFile(info: SessionInfoLike): Promise<"filed" | "archived" | "skipped" | "unfiled" | "none"> {
      if (archivedAt(info)) {
        log("session archived, no folder change", { sessionID: info.id })
        return "archived"
      }
      if (info.parentID && !config.includeSubagents) return "skipped"
      const directory = info.location?.directory
      const root = await resolveRoot(info, async (id) => await ctx.session.get({ sessionID: id }).catch(() => null) as SessionInfoLike | null)
      if (!root) return "none"
      if (archivedAt(root)) return "archived"
      const match = classify(root.title ?? "", root.location?.directory ?? directory, await source.get())
      if (match.status === "unfiled") return "unfiled"
      if (match.status === "none") return "none"
      if (!directory) return "none"
      if (config.dryRun) {
        log("dry run: would file", { sessionID: info.id, folder: match.folder, via: match.via, detail: match.detail })
        return "filed"
      }
      const result = await moveSession(config.apiBaseUrl, directory, info.id, match.folder)
      if (result !== "already-filed") log(result, { sessionID: info.id, folder: match.folder, via: match.via, detail: match.detail })
      return "filed"
    }

    // Immediate path: one attempt, no retry. If nothing matches yet (title still default)
    // this is a no-op and the bounded retry on turn end is the catch-up.
    async function attemptFile(sessionID: string) {
      if (!config.enabled || inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        const info = await ctx.session.get({ sessionID }) as SessionInfoLike
        await classifyAndFile(info)
      } catch (error) {
        log("filing failed; chat continues", error instanceof Error ? error.message : error)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    // Bounded retry path. V2 splits V1's `session.idle` into three terminal execution
    // events; all three count as "turn ended".
    async function runFallback(sessionID: string) {
      if (!config.enabled || inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        let lastReadError: unknown
        for (let attempt = 0; attempt < config.fallbackMaxAttempts; attempt += 1) {
          if (attempt > 0) await delay(config.fallbackDelayMs)
          let info: SessionInfoLike
          try {
            info = await ctx.session.get({ sessionID }) as SessionInfoLike
          } catch (error) {
            lastReadError = error
            continue
          }
          lastReadError = undefined
          const outcome = await classifyAndFile(info)
          if (outcome !== "none") return
        }
        if (lastReadError) log("could not read session; chat continues", { sessionID, error: lastReadError instanceof Error ? lastReadError.message : lastReadError })
      } catch (error) {
        log("fallback check failed; chat continues", error instanceof Error ? error.message : error)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    let disposed = false
    if (config.enabled) {
      const registered = { config, source }
      shared.instances.set(instanceKey, registered)
      shared.lastKnown = registered
      requestSweepSoon()
      void diagnostic("initialized")
    }

    // Background event loop. V2 delivers events as a pull-based async iterable, aborted
    // from the cleanup function `setup` returns.
    const eventController = new AbortController()
    const eventLoop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (!config.enabled || disposed) continue
          const type = (event as { type?: string }).type
          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (!sessionID) continue

          if (type === "session.created" || type === "session.renamed") {
            void attemptFile(sessionID)
            continue
          }

          if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
            void runFallback(sessionID)
            if (!disposed && Date.now() - shared.lastSweepAt >= config.sweepIntervalMs) void sweepTick()
          }
        }
      } catch (error) {
        if (!eventController.signal.aborted) {
          log("event stream ended; chat continues", error instanceof Error ? error.message : error)
        }
      }
    })()

    return async () => {
      disposed = true
      eventController.abort()
      await eventLoop.catch(() => {})
      // The sweep outlives its instances on purpose (see `shared`).
      shared.instances.delete(instanceKey)
      await titleHook.dispose().catch(() => {})
      await toolRegistration?.dispose().catch(() => {})
      if (config.enabled) await diagnostic("disposed")
    }
  },
} satisfies Plugin.Plugin
