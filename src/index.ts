import type { Plugin } from "@opencode/plugin"
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

// Minimal shape this plugin needs off a session, read from `ctx.session.get()`'s
// `SessionInfo` (OpenCode 2 / `@opencode/plugin@2.0.25`). V1 had a flat `directory`
// field; V2 nests it under `location.directory` (`LocationPublicRef`). `time.archived`
// kept the same name and shape across both majors.
type SessionInfoLike = {
  id: string
  title?: string
  location?: { directory?: string }
  time?: { archived?: number }
}

// `ctx.session` in `@opencode/plugin@2.0.25`'s Promise context (`SessionDomain` in
// `dist/promise/session.d.ts`) deliberately `Pick`s a subset of the full client's
// `SessionApi` — `list` and `active` are NOT in that Pick, unlike V1's
// `PluginInput.client.session`, which had `list`. Confirmed by reading the type
// directly, not inferred from a runtime error. There is no other documented way to
// enumerate project sessions from inside a Promise plugin's `setup(ctx)` (no
// `serverUrl`/raw client escape hatch on `Context`, unlike V1's `PluginInput`).
// Periodic reconciliation is therefore gated behind this runtime capability check,
// exactly like V1 already gated it behind a stale-SDK-type concern — if a future
// `@opencode/plugin` release adds `list` back, this activates with no plugin code
// changes. Today, on OpenCode 2.0.25, this is always `false`: reconciliation does not
// run under the V2 contract, and only the two event-driven paths (immediate
// classify-on-rename/create, bounded retry on turn-end) file sessions. See
// `oc-plugin-autofile.architecture.md` for the operational implication.
type ReconcileCapableSession = {
  list: (input: { project?: string; limit?: number; cursor?: string }) => Promise<{
    data: SessionInfoLike[]
    cursor?: { next?: string | null }
  }>
}

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
// Caps *moves* (writes), not the scan: a huge backlog shouldn't monopolize one tick.
const RECONCILE_MAX_MOVES_PER_TICK = 25
// Page size per `session.list` request, if the capability exists.
const RECONCILE_LIST_LIMIT = 200
// Overall cap on sessions scanned in one tick across every page. V1 could only guess
// at "possibly incomplete" by re-requesting once at an escalated limit, since its SDK
// build had no page cursor. V2's `SessionsResponse.cursor.next` (if `list` exists)
// supports real pagination, so this cap now bounds genuine enumeration instead of a
// single best-effort request — `possiblyIncomplete` is only set if the cap is hit
// while a next page still exists.
const RECONCILE_LIST_LIMIT_ESCALATED = 5_000

// Guards against two reconciliation ticks running concurrently, process-wide (not
// per directory/instance): every instance's sweep writes the same full-snapshot
// `/api/session-folders` blob, so two concurrent sweeps' read-modify-write cycles
// could each discard the other's moves. Kept at module scope so it applies across
// every directory/worktree's copy of this plugin in one process.
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

// OpenChamber 1.24.2's server accepted the write with HTTP 200 but silently dropped it
// (`{ success: true, ignored: true }`) when its stored state was already at least as
// fresh as our `updatedAt` (last-write-wins by timestamp). OpenChamber 2.1.1 changed
// this route's conflict handling entirely (confirmed by reading the installed
// `session-folders/routes.js` on `vm-oc-hugoj2` directly, not assumed from the old
// behavior): POSTs now queue per-process (`saveQueue`) and the server performs its own
// read-modify-write merge per folder id, unioning session ids only for same-name
// different-id "twin" folders. It no longer returns `ignored: true` at all, and still
// never returns `409`. That makes the retry branch below unreachable in practice against
// 2.1.1 — not harmful (the loop still succeeds on the first attempt), just dead weight
// kept so this function behaves identically against either OpenChamber version without
// a version check. If a future OpenChamber reintroduces a conflict signal, this still
// handles it the same way: re-fetch and retry rather than report false success.
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

function archivedAt(session: SessionInfoLike): number {
  return typeof session.time?.archived === "number" ? session.time.archived : 0
}

export default {
  id: "opencode-session-autofile",
  async setup(ctx) {
    const config = resolveOptions(ctx.options)
    // OpenChamber captures plugin stderr in an inaccessible in-memory buffer while
    // its managed OpenCode process is alive. Keep a small, non-secret status snapshot
    // outside the synced vault so an operator can tell whether the timer fired and
    // which folder names this plugin instance actually loaded from Options JSON.
    const diagnosticDir = "/tmp/opencode-session-autofile"
    const diagnosticPath = typeof ctx.location.directory === "string"
      ? `${diagnosticDir}/${createHash("sha256").update(ctx.location.directory).digest("hex").slice(0, 16)}.json`
      : null
    const startedAt = new Date().toISOString()
    async function diagnostic(phase: string, detail: Record<string, unknown> = {}) {
      if (!diagnosticPath) return
      try {
        await mkdir(diagnosticDir, { recursive: true })
        await writeFile(diagnosticPath, JSON.stringify({
          pid: process.pid,
          directory: ctx.location.directory,
          opencodeVersion: ctx.app.version,
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

    // Replaces OpenCode's native title-generation prompt for every title request,
    // regardless of provider. V1 did this by rewriting `agent.title.prompt` from the
    // `config` hook (which V2 does not have). V2 intercepts the title request itself
    // via `session.hook("title", ...)` (`SessionHooks.title: SessionTitle`, confirmed
    // in `@opencode/plugin@2.0.25`'s `dist/promise/session.d.ts`) and replaces its
    // `system` array outright — the model still runs and produces the actual title
    // text, same as V1; only the instructions it's given change.
    const titleHook = await ctx.session.hook("title", async (request) => {
      request.system = [{ type: "text", text: config.titlePrompt }]
    })

    // Sessions confirmed filed (or confirmed terminally unfiled, e.g. `[Unfiled]`/unmapped
    // tag, or archived) so later events stop rechecking them. Session IDs are globally
    // unique, so a flat set is sufficient without directory scoping.
    const resolvedSessions = new Set<string>()
    // Guards against two overlapping attempts (immediate classify-on-rename and a
    // bounded retry loop) for the same session running at once.
    const pendingFallback = new Set<string>()

    // Shared body for both the immediate path (session.created/session.renamed) and
    // the bounded-retry path (session.execution.*): fetch the session's current state
    // directly (never trust an event's embedded fields, which in V2 are partial — e.g.
    // `session.renamed`'s `data` carries only `{title, sessionID}`, no directory or
    // archived flag), classify its title, and move it if mapped.
    async function classifyAndFile(info: SessionInfoLike): Promise<"filed" | "archived" | "unmapped" | "no-tag"> {
      if (archivedAt(info)) {
        resolvedSessions.add(info.id)
        log("session archived, no folder change", { sessionID: info.id })
        return "archived"
      }
      const classification = classifyTitle(info.title ?? "", config.mappings)
      if (classification.status === "no-tag") return "no-tag"
      if (classification.status === "unmapped") {
        resolvedSessions.add(info.id)
        log("tag unmapped, no folder", { sessionID: info.id, label: classification.label })
        return "unmapped"
      }
      const directory = info.location?.directory
      if (!directory) return "no-tag"
      const result = await moveSession(config.apiBaseUrl, directory, info.id, classification.folderName)
      resolvedSessions.add(info.id)
      log(result, { sessionID: info.id, label: classification.label, folderName: classification.folderName })
      return "filed"
    }

    // Immediate path: fires once, with no retry, right when a session is created with
    // a preset tagged title (scheduler/spawn flows) or its title is renamed by the
    // native title agent. If the tag isn't there yet (title still default), this is a
    // no-op and the bounded retry path below is the catch-up mechanism, same as V1's
    // primary/fallback split.
    async function attemptFile(sessionID: string) {
      if (!config.enabled || resolvedSessions.has(sessionID) || pendingFallback.has(sessionID)) return
      pendingFallback.add(sessionID)
      try {
        const info = await ctx.session.get({ sessionID }) as SessionInfoLike
        await classifyAndFile(info)
      } catch (error) {
        log("filing failed; chat continues", error instanceof Error ? error.message : error)
      } finally {
        pendingFallback.delete(sessionID)
      }
    }

    // Bounded retry path: V1's `session.idle` fired reliably once a turn ended,
    // regardless of outcome. V2 splits that into three terminal execution events
    // (`session.execution.succeeded/failed/interrupted`); all three are treated as
    // "turn ended" to preserve the same "always eventually re-checked" guarantee.
    async function runFallback(sessionID: string) {
      if (!config.enabled || resolvedSessions.has(sessionID) || pendingFallback.has(sessionID)) return
      pendingFallback.add(sessionID)
      try {
        for (let attempt = 0; attempt < config.fallbackMaxAttempts; attempt += 1) {
          if (attempt > 0) await delay(config.fallbackDelayMs)
          if (resolvedSessions.has(sessionID)) return
          let info: SessionInfoLike
          try {
            info = await ctx.session.get({ sessionID }) as SessionInfoLike
          } catch {
            continue
          }
          const outcome = await classifyAndFile(info)
          if (outcome !== "no-tag") return
        }
      } catch (error) {
        log("fallback check failed; chat continues", error instanceof Error ? error.message : error)
      } finally {
        pendingFallback.delete(sessionID)
      }
    }

    // Tag-authoritative periodic reconciliation — see the `ReconcileCapableSession`
    // comment above for why this is feature-detected rather than assumed. Ported
    // verbatim from 0.4.1's logic (list, classify, bounded sequential moves) in case a
    // future `@opencode/plugin` release restores `session.list`; inert today.
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined
    let lastReconcileAt = 0
    let disposed = false

    async function listProjectSessions(): Promise<{ sessions: SessionInfoLike[]; possiblyIncomplete: boolean }> {
      const session = ctx.session as unknown as ReconcileCapableSession
      const sessions: SessionInfoLike[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await session.list({ project: ctx.location.project?.id, limit: RECONCILE_LIST_LIMIT, ...(cursor ? { cursor } : {}) })
        if (!page || !Array.isArray(page.data)) throw new Error("session.list returned an unexpected shape")
        sessions.push(...page.data)
        const next = page.cursor?.next
        if (!next) return { sessions, possiblyIncomplete: false }
        if (sessions.length >= RECONCILE_LIST_LIMIT_ESCALATED) return { sessions, possiblyIncomplete: true }
        cursor = next
      }
    }

    const reconciliationSupported = typeof (ctx.session as unknown as ReconcileCapableSession).list === "function"
    if (!reconciliationSupported) {
      log("reconcile: session.list unavailable on this OpenCode/plugin build; periodic reconciliation disabled")
    }
    if (config.enabled) void diagnostic("initialized", { reconciliationSupported })

    async function reconcileTick(): Promise<void> {
      if (!config.enabled || disposed) return
      if (reconciling) {
        log("reconcile: another instance's pass is running, skipping this tick", { directory: ctx.location.directory })
        await diagnostic("skipped: another instance is reconciling")
        return
      }
      reconciling = true
      lastReconcileAt = Date.now()
      await diagnostic("running")
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
            directory: ctx.location.directory,
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
        for (const session of sessions) {
          const directory = session.location?.directory
          if (!session?.id || !directory) { stats.missingMetadata += 1; continue }
          if (archivedAt(session)) { stats.archivedSkipped += 1; continue }
          if (pendingFallback.has(session.id)) { stats.inFlight += 1; continue }

          const classification = classifyTitle(session.title ?? "", config.mappings)
          if (classification.status !== "mapped") { stats.untaggedOrUnmapped += 1; continue }

          const scopedFolders = folderState.foldersMap?.[directory] ?? []
          const placement = classifyPlacement(scopedFolders, session.id, classification.folderName)
          if (placement === "already-filed") { stats.alreadyFiled += 1; continue }
          if (placement === "ambiguous") {
            stats.ambiguous += 1
            log("reconcile: folder name ambiguous, skipping", { sessionID: session.id, folderName: classification.folderName })
            continue
          }
          misfiled.push({ sessionID: session.id, folderName: classification.folderName, label: classification.label })
        }

        const toMove = misfiled.slice(0, RECONCILE_MAX_MOVES_PER_TICK)
        stats.deferred = misfiled.length - toMove.length

        for (let i = 0; i < toMove.length; i += 1) {
          if (disposed) {
            stats.deferred += toMove.length - i
            break
          }
          const item = toMove[i]!
          try {
            if (pendingFallback.has(item.sessionID)) { stats.inFlight += 1; continue }
            const fresh = await ctx.session.get({ sessionID: item.sessionID }) as SessionInfoLike
            const freshDirectory = fresh.location?.directory
            if (!fresh?.id || !freshDirectory) { stats.missingMetadata += 1; continue }
            if (archivedAt(fresh)) { stats.archivedSkipped += 1; continue }

            const freshClassification = classifyTitle(fresh.title ?? "", config.mappings)
            if (freshClassification.status !== "mapped") { stats.untaggedOrUnmapped += 1; continue }

            const result = await moveSession(config.apiBaseUrl, freshDirectory, fresh.id, freshClassification.folderName)
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

        log("reconcile tick complete", { directory: ctx.location.directory, possiblyIncomplete, ...stats })
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

    // Background event loop. V1 received events via a pushed `hooks.event({event})`
    // callback; V2 delivers them as a pull-based async iterable
    // (`ctx.event.subscribe({signal})`, confirmed against the real, working
    // `@openchamber/opencode-claude@1.3.8` plugin on `vm-oc-hugoj2`, which uses the
    // identical pattern). Aborted from the cleanup function `setup` returns.
    const eventController = new AbortController()
    const eventLoop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (!config.enabled || disposed) continue
          const type = (event as { type?: string }).type
          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (!sessionID) continue

          // `session.created` carries a preset title inline (scheduler/spawn flows,
          // e.g. `Morning sales brief [Sales]`); `session.renamed` is what the native
          // title agent fires after `setTitle`. Both go through the same immediate,
          // no-retry path — V1's primary path, unified across both V2 event types
          // because neither carries enough fields (notably: no archived flag) to act
          // on without a fresh `session.get` anyway.
          if (type === "session.created" || type === "session.renamed") {
            void attemptFile(sessionID)
            continue
          }

          if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
            void runFallback(sessionID)
            if (config.enabled && !disposed && reconciliationSupported && Date.now() - lastReconcileAt >= config.reconcileIntervalMs) {
              void reconcileTick()
            }
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
      if (reconcileTimer) clearTimeout(reconcileTimer)
      await titleHook.dispose().catch(() => {})
      if (config.enabled) await diagnostic("disposed")
    }
  },
} satisfies Plugin.Plugin
