import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"

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
  mappings?: Record<string, string>
  titlePrompt?: string
  fallbackMaxAttempts?: number
  fallbackDelayMs?: number
  reconcileIntervalMs?: number
}

// Minimal shape the periodic reconciliation reads off a `Session`. The installed
// `@opencode-ai/sdk` version's `Session` type omits `time.archived` even though the
// server sends it (OpenChamber's own client reads `session.time?.archived` the same
// way — see `packages/ui/src/sync/event-reducer.ts`), so this is declared locally
// rather than trusting the SDK's stale type.
type SessionSummary = {
  id: string
  directory?: string
  title: string
  time?: { archived?: number }
}

// The installed `@opencode-ai/sdk` version's generated `SessionListData.query` type
// only declares `directory`. The live `/session` route (confirmed against opencode
// v1.18.32's HttpApi `ListQuery` schema and its `SessionHttpApi.list` handler) also
// accepts `scope: "project"`, which tells the server to ignore the directory filter
// for session selection and return every session in the project, including every git
// worktree, and a numeric `limit` (server default 100 when omitted). Deliberately NOT
// using `roots: true`: Hugo's requirement is that every title-tagged session gets
// reconciled, including child/subagent sessions, not just top-level ones — the sweep
// must be a true superset of what the event-driven paths already file one at a time.
// `directory` is kept even under `scope: "project"` since the same value is also how
// `createOpencodeClient` derives the `x-opencode-directory` request header that
// instance/project routing reads — dropping it from the query costs nothing to avoid.
// Declared locally and cast at the call site rather than trusting the stale generated
// type.
type ReconcileListQuery = { scope: "project"; limit: number; directory?: string }

const MAX_WRITE_ATTEMPTS = 3
const WRITE_RETRY_DELAY_MS = 50
const TAG = /\[([^\]\r\n]{1,40})\]/g
const DEFAULT_FALLBACK_MAX_ATTEMPTS = 3
const DEFAULT_FALLBACK_DELAY_MS = 500
const DEFAULT_RECONCILE_INTERVAL_MS = 600_000
const MIN_RECONCILE_INTERVAL_MS = 60_000
const MAX_RECONCILE_INTERVAL_MS = 86_400_000
// Startup pass runs once shortly after the plugin loads, not immediately: firing back
// into a server that is still booting risks re-entrancy.
const RECONCILE_STARTUP_DELAY_MS = 20_000
// Caps *moves* (writes), not the scan: `session.list` gives no ordering guarantee, so
// capping how many sessions get scanned per tick could let the same prefix win every
// tick while the tail never gets filed. Scanning/classifying is local and cheap;
// only the write side needs a per-tick bound. Sessions beyond the cap stay in the
// misfiled set and are picked up on a later tick (or by the primary event path first).
const RECONCILE_MAX_MOVES_PER_TICK = 25
// `/session` defaults to `limit: 100` server-side and has no cursor for paging past
// that (confirmed against opencode v1.18.32's `Session.list`/`listByProject`: `start`
// only filters by `updated >= start`, it isn't a `before`/page cursor). A first try at
// `RECONCILE_LIST_LIMIT` covers ordinary session counts in a single request; only
// projects at or beyond that size pay for a second, larger request.
const RECONCILE_LIST_LIMIT = 200
// Hard ceiling on the escalated retry — never ask for an unbounded number of rows in
// one tick. Since the sweep now includes every session (not just root sessions), a
// single long-lived, actively-used project can realistically approach or pass a
// four-figure session count well before this plugin is uninstalled; 5,000 gives real
// headroom above that without being unbounded. If even this comes back exactly full,
// `possiblyIncomplete` is set instead of silently treating whatever was fetched as the
// whole project — there is no way to page further in one `/session` request (see
// ADVANCED.md).
const RECONCILE_LIST_LIMIT_ESCALATED = 5_000

// Guards against two reconciliation ticks running concurrently, process-wide (not
// per directory/instance): every instance's sweep writes the same full-snapshot
// `/api/session-folders` blob, so two concurrent sweeps' read-modify-write cycles
// could each discard the other's moves even with the `ignored: true` retry (that
// retry only catches a write being stale against the *current* server state, not two
// near-simultaneous writers each computing their merge against a state the other is
// about to replace). Kept at module scope, not inside the plugin factory closure, so
// it applies across every directory/worktree's copy of this plugin in one process.
let reconciling = false

const DEFAULT_MAPPINGS: Record<string, string> = {
  Language: "Language",
  Tech: "Tech",
  Personal: "Personal",
  Business: "Business",
  Sales: "Sales",
  Career: "Career",
  Finance: "Finance",
  Immigration: "Immigration",
  Artist: "Artist",
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

// Normalizes user-supplied mappings to `{ label: folderName }`. Any entry whose value
// isn't a non-empty string is dropped rather than causing an unexpected folder move.
function normalizeMappings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_MAPPINGS
  const result: Record<string, string> = {}
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) result[label] = value.trim()
  }
  return result
}

function resolveOptions(options: Record<string, unknown>): Required<Pick<SessionAutofileOptions, "enabled" | "apiBaseUrl" | "titlePrompt" | "fallbackMaxAttempts" | "fallbackDelayMs" | "reconcileIntervalMs">> & { mappings: Record<string, string> } {
  const fallbackMaxAttempts = options.fallbackMaxAttempts
  const fallbackDelayMs = options.fallbackDelayMs
  const reconcileIntervalMs = options.reconcileIntervalMs
  return {
    enabled: options.enabled !== false,
    apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl : "http://localhost:3000",
    titlePrompt: typeof options.titlePrompt === "string" && options.titlePrompt.trim() ? options.titlePrompt.trim() : DEFAULT_TITLE_PROMPT,
    mappings: normalizeMappings(options.mappings),
    fallbackMaxAttempts: typeof fallbackMaxAttempts === "number" && Number.isInteger(fallbackMaxAttempts) && fallbackMaxAttempts >= 1 && fallbackMaxAttempts <= 10 ? fallbackMaxAttempts : DEFAULT_FALLBACK_MAX_ATTEMPTS,
    fallbackDelayMs: typeof fallbackDelayMs === "number" && Number.isFinite(fallbackDelayMs) && fallbackDelayMs >= 0 && fallbackDelayMs <= 5_000 ? fallbackDelayMs : DEFAULT_FALLBACK_DELAY_MS,
    reconcileIntervalMs: typeof reconcileIntervalMs === "number" && Number.isFinite(reconcileIntervalMs) && reconcileIntervalMs >= MIN_RECONCILE_INTERVAL_MS && reconcileIntervalMs <= MAX_RECONCILE_INTERVAL_MS ? reconcileIntervalMs : DEFAULT_RECONCILE_INTERVAL_MS,
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
  | { status: "mapped"; label: string; folderName: string }

function classifyTitle(title: string, mappings: Record<string, string>): Classification {
  const labels = parseLabels(title)
  if (labels.length > 0) {
    for (const label of labels) {
      const folderName = mappings[label]
      if (typeof folderName === "string" && folderName.trim()) return { status: "mapped", label, folderName: folderName.trim() }
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

// The server accepts the write with HTTP 200 but silently drops it (`{ success: true,
// ignored: true }`) when its stored state is already at least as fresh as our
// `updatedAt`. That is a real conflict, not a success: our merge was computed against
// state that a concurrent writer has since superseded. Treat it exactly like a 409 so
// the caller re-fetches the latest state and retries instead of reporting the move as
// done.
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

// Pure lookup, no network: finds the folder matching `folderName` (case-insensitive)
// within `folders`. `ambiguous` mirrors the write path's own guard — more than one
// folder sharing the exact destination name is never resolved by guessing.
function findFolderTarget(folders: Folder[], folderName: string): { target: Folder | null; ambiguous: boolean } {
  const matches = folders.filter((folder) => folder.name?.trim().toLocaleLowerCase() === folderName.trim().toLocaleLowerCase())
  if (matches.length > 1) return { target: null, ambiguous: true }
  return { target: matches[0] ?? null, ambiguous: false }
}

// Pure check, no network: true if `sessionID` is filed in `target` and nowhere else
// in `folders` (a session moved cleanly, not merely added to `target` alongside a
// stale membership elsewhere).
function isSessionFiled(folders: Folder[], sessionID: string, target: Folder): boolean {
  const targetSessionIDs = Array.isArray(target.sessionIds) ? target.sessionIds : []
  const appearsOnlyInTarget = folders.every((folder) => !Array.isArray(folder.sessionIds) || !folder.sessionIds.includes(sessionID) || folder.id === target.id)
  return appearsOnlyInTarget && targetSessionIDs.includes(sessionID)
}

// Cheap, read-only classification against an already-fetched `FolderState` snapshot —
// used by reconciliation to separate "nothing to do" from "needs a write" without a
// network round-trip per session. A missing destination folder counts as `misfiled`:
// `moveSession` creates it as part of the same protected write.
type Placement = "already-filed" | "misfiled" | "ambiguous"
function classifyPlacement(folders: Folder[], sessionID: string, folderName: string): Placement {
  const { target, ambiguous } = findFolderTarget(folders, folderName)
  if (ambiguous) return "ambiguous"
  if (!target) return "misfiled"
  return isSessionFiled(folders, sessionID, target) ? "already-filed" : "misfiled"
}

async function moveSession(apiBaseUrl: string, scope: string, sessionID: string, folderName: string): Promise<"moved" | "created-and-moved" | "already-filed" | "folder-ambiguous"> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(WRITE_RETRY_DELAY_MS)
    const state = await getFolderState(apiBaseUrl)
    const foldersMap = state.foldersMap ?? (state.foldersMap = {})
    const folders = foldersMap[scope] ?? (foldersMap[scope] = [])
    const { target: existingTarget, ambiguous } = findFolderTarget(folders, folderName)
    if (ambiguous) return "folder-ambiguous"

    const created = !existingTarget
    const target = existingTarget ?? (() => {
      const folder: Folder = { id: crypto.randomUUID(), name: folderName.trim(), sessionIds: [], createdAt: Date.now(), parentId: null }
      folders.push(folder)
      return folder
    })()

    if (!created && isSessionFiled(folders, sessionID, target)) return "already-filed"

    for (const folder of folders) {
      const current = Array.isArray(folder.sessionIds) ? folder.sessionIds : []
      folder.sessionIds = folder.id === target.id
        ? [...new Set([...current.filter((id) => id !== sessionID), sessionID])]
        : current.filter((id) => id !== sessionID)
    }

    const outcome = await writeFolderState(apiBaseUrl, state, typeof state.rev === "number" ? state.rev : 0)
    if (outcome === "success") return created ? "created-and-moved" : "moved"
  }
  throw new Error("OpenChamber rejected or ignored the write too many times to file the session")
}

export default (async (input, options = {}) => {
  const config = resolveOptions(options)
  // OpenChamber captures plugin stderr in an inaccessible in-memory buffer while
  // its managed OpenCode process is alive. Keep a small, non-secret status snapshot
  // outside the synced vault so an operator can tell whether the timer fired and
  // which folder names this plugin instance actually loaded from Options JSON.
  const diagnosticDir = "/tmp/opencode-session-autofile"
  const diagnosticPath = typeof input.directory === "string"
    ? `${diagnosticDir}/${createHash("sha256").update(input.directory).digest("hex").slice(0, 16)}.json`
    : null
  const startedAt = new Date().toISOString()
  async function diagnostic(phase: string, detail: Record<string, unknown> = {}) {
    if (!diagnosticPath) return
    try {
      await mkdir(diagnosticDir, { recursive: true })
      await writeFile(diagnosticPath, JSON.stringify({
        pid: process.pid,
        directory: input.directory,
        startedAt,
        recordedAt: new Date().toISOString(),
        phase,
        mappings: config.mappings,
        ...detail,
      }, null, 2), { mode: 0o600 })
    } catch (error) {
      log("reconcile: could not record diagnostic", error instanceof Error ? error.message : error)
    }
  }
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
        if (archivedAt(data as SessionSummary)) {
          resolvedSessions.add(sessionID)
          log("fallback: session archived, no folder change", { sessionID })
          return
        }

        const classification = classifyTitle(data.title, config.mappings)
        if (classification.status === "no-tag") continue
        if (classification.status === "unmapped") {
          resolvedSessions.add(sessionID)
          log("fallback: tag unmapped, no folder", { sessionID, label: classification.label })
          return
        }

        const result = await moveSession(config.apiBaseUrl, data.directory, data.id, classification.folderName)
        resolvedSessions.add(sessionID)
        log(`fallback ${result}`, { sessionID, label: classification.label, folderName: classification.folderName })
        return
      }
    } catch (error) {
      log("fallback check failed; chat continues", error instanceof Error ? error.message : error)
    } finally {
      pendingFallback.delete(sessionID)
    }
  }

  // Tag-authoritative periodic reconciliation: independent of the event-driven paths
  // above, it re-derives every mapped session's folder from its *current* title and
  // moves it if that's not where it currently sits — including sessions that started
  // in the right folder and were since moved elsewhere by hand. Unlike the fallback
  // (which only fires once, near session start, to catch a missed event), this runs
  // on its own schedule for the lifetime of the process. Sessions with no tag or an
  // unmapped tag are left untouched, same as the event-driven paths: this plugin only
  // ever files, never unfiles.
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined
  // Session-idle is a secondary wake-up source: if the timer is delayed or an
  // instance starts only when the first session is used, an idle event can still
  // initiate a pass. The normal interval prevents a pass on every turn.
  let lastReconcileAt = 0
  // Set once by `dispose` (OpenCode disposes and reloads plugin instances on config
  // changes). Checked before scheduling the next tick, at tick start, and before each
  // move, so a sweep already in flight at dispose time can't reschedule itself or keep
  // writing through a client that may since have been torn down.
  let disposed = false

  function archivedAt(session: SessionSummary): number {
    return typeof session.time?.archived === "number" ? session.time.archived : 0
  }

  // Tries `RECONCILE_LIST_LIMIT` first (covers ordinary session counts in one
  // request); only escalates to `RECONCILE_LIST_LIMIT_ESCALATED` if the project has at
  // least that many sessions (root and child sessions both count — see
  // `ReconcileListQuery`). `scope: "project"` means this already spans every worktree
  // of the project, not just `input.directory`. Throws rather than returning an empty
  // list on failure: a rejected/failed call must surface as a failed tick (counted and
  // logged as such by the caller), not as a false "swept zero sessions, nothing to do".
  async function listProjectSessions(): Promise<{ sessions: SessionSummary[]; possiblyIncomplete: boolean }> {
    let sessions: SessionSummary[] = []
    for (const limit of [RECONCILE_LIST_LIMIT, RECONCILE_LIST_LIMIT_ESCALATED]) {
      const query: ReconcileListQuery = { scope: "project", limit, directory: input.directory }
      const { data, error } = await input.client.session.list({
        query: query as unknown as { directory?: string },
        signal: AbortSignal.timeout(10_000),
      })
      if (!Array.isArray(data)) {
        throw new Error(`session.list failed${error ? `: ${JSON.stringify(error)}` : ""}`)
      }
      sessions = data as SessionSummary[]
      if (sessions.length < limit) return { sessions, possiblyIncomplete: false }
    }
    // Even the escalated cap came back exactly full: this project may have more
    // sessions than we're willing to fetch in one tick.
    return { sessions, possiblyIncomplete: true }
  }

  // Checked once at load, not per tick: this SDK build either has `session.list` or it
  // doesn't, and re-logging "unavailable" every tick would be noise (and would
  // contradict the one-time note in the README/ADVANCED docs).
  const reconciliationSupported = typeof input.client?.session?.list === "function"
  if (!reconciliationSupported) {
    log("reconcile: client.session.list unavailable on this SDK build; periodic reconciliation disabled")
  }
  if (config.enabled) void diagnostic("initialized", { reconciliationSupported })

  async function reconcileTick(): Promise<void> {
    if (!config.enabled || disposed) return
    // Single process-wide lock, not one per plugin instance/directory: every
    // instance's `moveSession` writes the *same* full-snapshot `/api/session-folders`
    // blob (just under different `foldersMap` scope keys), and the `ignored: true`
    // retry only protects a single writer's own stale write — it does not stop two
    // concurrent sweeps' read-modify-write cycles from each silently discarding the
    // other's moves. Serializing every instance's sweep avoids that entirely; the cost
    // is that a slow sweep in one directory can make another directory's tick skip and
    // wait for its own next interval, which just means that directory heals one tick
    // later, not that it's ever wrong. This only serializes sweeps against each other:
    // it does not serialize against the primary/fallback event-driven writes or
    // against OpenChamber's own UI writes, which still rely on the existing
    // read-refetch-retry protection in `moveSession`/`writeFolderState` to converge
    // rather than to never collide.
    if (reconciling) {
      log("reconcile: another instance's pass is running, skipping this tick", { directory: input.directory })
      await diagnostic("skipped: another instance is reconciling")
      return
    }
    reconciling = true
    lastReconcileAt = Date.now()
    await diagnostic("running")
    // `missingMetadata` and `inFlight` exist so `listed` always equals the sum of every
    // bucket below — an honest per-tick accounting instead of a count that silently
    // undercounts sessions the sweep saw but couldn't classify or chose to defer to
    // another in-flight path.
    const stats = { listed: 0, missingMetadata: 0, archivedSkipped: 0, inFlight: 0, untaggedOrUnmapped: 0, alreadyFiled: 0, moved: 0, deferred: 0, ambiguous: 0, failed: 0 }
    let possiblyIncomplete = false
    let phase = "completed"
    let failure: string | undefined
    let firstMoveFailure: string | undefined
    try {
      const listResult = await listProjectSessions()
      const sessions = listResult.sessions
      possiblyIncomplete = listResult.possiblyIncomplete
      if (possiblyIncomplete) {
        log("reconcile: project session count may exceed the fetch cap; this tick's coverage is NOT guaranteed complete", {
          directory: input.directory,
          cap: RECONCILE_LIST_LIMIT_ESCALATED,
        })
      }
      stats.listed = sessions.length

      let folderState: FolderState
      try {
        folderState = await getFolderState(config.apiBaseUrl)
      } catch (error) {
        phase = "failed: folder API GET"
        failure = error instanceof Error ? error.message : String(error)
        log("reconcile: failed to read folder state; skipping tick", error instanceof Error ? error.message : error)
        return
      }

      const misfiled: Array<{ sessionID: string; folderName: string; label: string }> = []
      for (const session of sessions as SessionSummary[]) {
        if (!session?.id || !session.directory) { stats.missingMetadata += 1; continue }
        if (archivedAt(session)) { stats.archivedSkipped += 1; continue }
        // Already being handled by the fallback's own retry loop for this exact
        // session; let that finish rather than racing it from here.
        if (pendingFallback.has(session.id)) { stats.inFlight += 1; continue }

        const classification = classifyTitle(session.title ?? "", config.mappings)
        if (classification.status !== "mapped") { stats.untaggedOrUnmapped += 1; continue }

        const scopedFolders = folderState.foldersMap?.[session.directory] ?? []
        const placement = classifyPlacement(scopedFolders, session.id, classification.folderName)
        if (placement === "already-filed") { stats.alreadyFiled += 1; continue }
        if (placement === "ambiguous") {
          stats.ambiguous += 1
          log("reconcile: folder name ambiguous, skipping", { sessionID: session.id, folderName: classification.folderName })
          continue
        }
        misfiled.push({ sessionID: session.id, folderName: classification.folderName, label: classification.label })
      }

      // Bounded and sequential: bounded so one huge backlog can't monopolize a tick
      // (the rest simply waits for the next tick), sequential so two concurrent
      // "folder doesn't exist yet" creates for the same name can't race into two
      // duplicate folders (which would then read back as `folder-ambiguous` forever).
      const toMove = misfiled.slice(0, RECONCILE_MAX_MOVES_PER_TICK)
      stats.deferred = misfiled.length - toMove.length

      for (let i = 0; i < toMove.length; i += 1) {
        if (disposed) {
          // Count the un-attempted remainder as deferred rather than leaving it
          // uncounted, so `listed` still equals the sum of every bucket even when a
          // sweep is cut short mid-loop by dispose.
          stats.deferred += toMove.length - i
          break
        }
        const item = toMove[i]!
        try {
          // Re-check right before writing, not just during the scan: the fallback's
          // own retry loop for this exact session may have started in the gap between
          // the scan above and this item's turn in the (sequential) move loop.
          if (pendingFallback.has(item.sessionID)) { stats.inFlight += 1; continue }
          // The list snapshot above can go stale mid-sweep — re-read the session's
          // live title immediately before writing rather than trusting it, so a
          // title the primary event path already changed since the snapshot isn't
          // filed under its old tag.
          const { data: fresh } = await input.client.session.get({ path: { id: item.sessionID }, signal: AbortSignal.timeout(5_000) })
          if (!fresh?.id || !fresh.directory) { stats.missingMetadata += 1; continue }
          if (archivedAt(fresh as SessionSummary)) { stats.archivedSkipped += 1; continue }

          const freshClassification = classifyTitle(fresh.title, config.mappings)
          if (freshClassification.status !== "mapped") { stats.untaggedOrUnmapped += 1; continue }

          const result = await moveSession(config.apiBaseUrl, fresh.directory, fresh.id, freshClassification.folderName)
          resolvedSessions.add(fresh.id)
          if (result === "already-filed") stats.alreadyFiled += 1
          else if (result === "folder-ambiguous") {
            stats.ambiguous += 1
            log("reconcile: folder name ambiguous, skipping", { sessionID: fresh.id, folderName: freshClassification.folderName })
          } else stats.moved += 1
        } catch (error) {
          stats.failed += 1
          firstMoveFailure ??= error instanceof Error ? error.message : String(error)
          log("reconcile: failed to file session; continuing sweep", { sessionID: item.sessionID, error: error instanceof Error ? error.message : error })
        }
      }

      log("reconcile tick complete", { directory: input.directory, possiblyIncomplete, ...stats })
    } catch (error) {
      phase = "failed: session listing or scan"
      failure = error instanceof Error ? error.message : String(error)
      log("reconcile tick failed; will retry next interval", error instanceof Error ? error.message : error)
    } finally {
      reconciling = false
      await diagnostic(phase, { possiblyIncomplete, ...stats, ...(failure ? { failure } : {}), ...(firstMoveFailure ? { firstMoveFailure } : {}) })
    }
  }

  function scheduleReconcile(delayMs: number) {
    if (!config.enabled || disposed) return
    reconcileTimer = setTimeout(() => {
      void reconcileTick().finally(() => scheduleReconcile(config.reconcileIntervalMs))
    }, delayMs)
    reconcileTimer.unref?.()
  }

  if (config.enabled && reconciliationSupported) scheduleReconcile(RECONCILE_STARTUP_DELAY_MS)

  return {
    dispose: async () => {
      disposed = true
      if (reconcileTimer) clearTimeout(reconcileTimer)
      if (config.enabled) await diagnostic("disposed")
    },
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
          if (!info.id) return
          if (archivedAt(info as SessionSummary)) {
            resolvedSessions.add(info.id)
            return
          }
          const classification = classifyTitle(info.title, config.mappings)
          if (classification.status !== "mapped" || !info.directory) return
          const result = await moveSession(config.apiBaseUrl, info.directory, info.id, classification.folderName)
          resolvedSessions.add(info.id)
          log(result, { sessionID: info.id, label: classification.label, folderName: classification.folderName })
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
        if (config.enabled && !disposed && reconciliationSupported && Date.now() - lastReconcileAt >= config.reconcileIntervalMs) {
          void reconcileTick()
        }
      }
    },
  }
}) satisfies Plugin
