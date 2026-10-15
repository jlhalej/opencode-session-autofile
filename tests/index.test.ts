import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Mock } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.AUTOFILE_DIAGNOSTIC_DIR = mkdtempSync(join(tmpdir(), "autofile-diag-"))
// Module-level state (the shared sweep) must not leak between tests, so every test
// loads its own copy of the module.
let freshCount = 0
let plugin: any
async function loadFreshPlugin() {
  plugin = (await import(`../src/index.ts?fresh=${freshCount++}`)).default
}
await loadFreshPlugin()

type FolderApiMock = {
  fetchMock: typeof fetch
  getCallCount: () => number
  postCallCount: () => number
  listCallCount: () => number
  getState: () => any
}

type FolderApiMockOptions = {
  // Sessions served by GET /api/session (pages of `pageSize`) and GET /api/session/:id.
  sessions?: Array<Record<string, unknown>>
  pageSize?: number
  forceIgnoredWrites?: number
  onFirstForcedIgnore?: (state: any) => void
}

function createFolderApiMock(options: FolderApiMockOptions = {}): FolderApiMock {
  let state: any = { version: 1, rev: 0, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 }
  let getCalls = 0
  let postCalls = 0
  let listCalls = 0
  let ignoredRemaining = options.forceIgnoredWrites ?? 0
  let firstForcedIgnoreFired = false

  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const parsed = new URL(url)
    if (parsed.pathname === "/api/session") {
      listCalls += 1
      const all = options.sessions ?? []
      const size = options.pageSize ?? 200
      const offset = Number(parsed.searchParams.get("cursor") ?? 0)
      const data = all.slice(offset, offset + size)
      // Like the real endpoint: even the last page carries a `next` cursor, and the page
      // after it is empty.
      return new Response(JSON.stringify({ data, cursor: { next: String(offset + size) } }), { status: 200 })
    }
    if (parsed.pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/api/session/".length))
      const found = (options.sessions ?? []).find((entry) => entry.id === id)
      return found ? new Response(JSON.stringify({ data: found }), { status: 200 }) : new Response("{}", { status: 404 })
    }
    if (parsed.pathname !== "/api/session-folders") throw new Error(`Unexpected fetch URL: ${url}`)

    const method = init?.method ?? "GET"
    if (method === "GET") {
      getCalls += 1
      return new Response(JSON.stringify(state), { status: 200 })
    }
    if (method === "POST") {
      postCalls += 1
      const body = JSON.parse(init!.body as string)

      if (ignoredRemaining > 0) {
        ignoredRemaining -= 1
        if (!firstForcedIgnoreFired) {
          firstForcedIgnoreFired = true
          options.onFirstForcedIgnore?.(state)
        }
        return new Response(JSON.stringify({ success: true, ignored: true }), { status: 200 })
      }

      if (typeof state.updatedAt === "number" && state.updatedAt >= body.updatedAt) {
        return new Response(JSON.stringify({ success: true, ignored: true }), { status: 200 })
      }
      state = {
        version: body.version,
        rev: state.rev + 1,
        foldersMap: body.foldersMap,
        collapsedFolderIds: body.collapsedFolderIds,
        updatedAt: body.updatedAt,
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    throw new Error(`Unexpected fetch method: ${method}`)
  }) as unknown as typeof fetch

  return {
    fetchMock,
    getCallCount: () => getCalls,
    postCallCount: () => postCalls,
    listCallCount: () => listCalls,
    getState: () => state,
  }
}

// Controllable async-iterable stand-in for `ctx.event.subscribe({signal})`. Lets a test
// push synthetic V2 events into the plugin's background event loop one at a time and
// await their (fire-and-forget) handling via `waitUntil` below, the same shape the real
// `@opencode/plugin@2.0.25` Promise context delivers (confirmed against the working
// `@openchamber/opencode-claude@1.3.8` plugin, which consumes `ctx.event.subscribe` the
// same way).
function makeEventBus() {
  const queue: unknown[] = []
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  let done = false
  function finish() {
    done = true
    if (pendingResolve) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve({ value: undefined, done: true })
    }
  }
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { pendingResolve = resolve })
        },
      }
    },
  }
  return {
    push(event: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ value: event, done: false })
      } else {
        queue.push(event)
      }
    },
    // Real `ctx.event.subscribe({signal})` ends the iterator when the signal aborts
    // (confirmed by how `@openchamber/opencode-claude@1.3.8` relies on exactly this to
    // unblock its own `for await` loop on cleanup). Mirror that here: without it, the
    // plugin's cleanup function — which correctly awaits the event loop exiting — would
    // hang forever against a mock that never ends its iterator.
    subscribe: (opts?: { signal?: AbortSignal }) => {
      if (opts?.signal) {
        if (opts.signal.aborted) finish()
        else opts.signal.addEventListener("abort", finish, { once: true })
      }
      return iterable
    },
  }
}

function makeSessionGetQueue(responses: Array<Record<string, unknown>>) {
  let calls = 0
  const fn = async (_args: unknown) => {
    const index = Math.min(calls, responses.length - 1)
    calls += 1
    const value = responses[index]!
    if (value.__throw) throw new Error(String(value.__throw))
    return value
  }
  return { fn, callCount: () => calls }
}

function session(overrides: Partial<{ id: string; directory: string; title: string; archived: number; parentID: string }>) {
  const { id = "ses_default", directory = "/proj", title = "Untitled", archived, parentID } = overrides
  return {
    id,
    title,
    ...(parentID ? { parentID } : {}),
    location: { directory },
    time: archived ? { archived } : {},
  }
}

function makeCtx(opts: {
  options?: Record<string, unknown>
  directory?: string
  projectId?: string
  sessionGet?: (args: unknown) => Promise<unknown>
  sessionList?: (args: unknown) => Promise<unknown>
  // `false` leaves `ctx.tool` out, like a host that predates the tool domain.
  withTool?: boolean
}) {
  const bus = makeEventBus()
  const toolState = {
    definitions: [] as any[],
    transforms: 0,
    disposed: 0,
    transformError: undefined as Error | undefined,
  }
  const titleHook: { callback?: (request: any) => Promise<void> | void } = {}
  const session: Record<string, unknown> = {
    get: opts.sessionGet ?? (async () => { throw new Error("session.get not wired in this test") }),
    hook: async (name: string, callback: (request: any) => Promise<void> | void) => {
      if (name === "title") titleHook.callback = callback
      return { dispose: async () => {} }
    },
  }
  if (opts.sessionList) session.list = opts.sessionList
  const ctx = {
    options: opts.options ?? {},
    location: { directory: opts.directory ?? "/proj", project: { id: opts.projectId ?? "proj_1" } },
    app: { name: "opencode", version: "2.0.25", channel: "stable" },
    event: { subscribe: bus.subscribe },
    session,
    ...(opts.withTool === false ? {} : {
      tool: {
        transform: async (callback: (editor: any) => void) => {
          toolState.transforms += 1
          if (toolState.transformError) throw toolState.transformError
          callback({ add: (definition: any) => toolState.definitions.push(definition) })
          return { dispose: async () => { toolState.disposed += 1 } }
        },
      },
    }),
  }
  return { ctx: ctx as any, push: bus.push, titleHook, toolState }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: condition never became true")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("opencode-session-autofile (V2 / @opencode/plugin promise contract)", () => {
  let folderApi: FolderApiMock
  let errorSpy: Mock<typeof console.error>

  beforeEach(async () => {
    await loadFreshPlugin()
    folderApi = createFolderApiMock()
    globalThis.fetch = folderApi.fetchMock
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  test("export shape: default export is {id, setup} (V2 contract), not a bare function", () => {
    expect(typeof plugin).toBe("object")
    expect(typeof (plugin as any).id).toBe("string")
    expect((plugin as any).id).toBe("opencode-session-autofile")
    expect(typeof (plugin as any).setup).toBe("function")
  })

  test("built dist/index.js exports the same V2 shape and bundles no @opencode/* or effect imports", async () => {
    const source = await Bun.file(new URL("../dist/index.js", import.meta.url)).text()
    expect(source).not.toMatch(/from\s+["']@opencode\//)
    expect(source).not.toMatch(/from\s+["']effect["']/)
    const dist = await import("../dist/index.js")
    const mod = dist.default
    expect(typeof mod).toBe("object")
    expect(typeof mod.id).toBe("string")
    expect(typeof mod.setup).toBe("function")
  })

  test("title hook replaces the title-generation system prompt", async () => {
    const { ctx, titleHook } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999", titlePrompt: "Custom tagging prompt" } })
    const cleanup = await plugin.setup(ctx)
    const request: any = { sessionID: "ses_x", model: { id: "m", providerID: "p" }, system: [{ type: "text", text: "old" }], messages: [], options: {} }
    await titleHook.callback!(request)
    expect(request.system).toEqual([{ type: "text", text: "Custom tagging prompt" }])
    await cleanup?.()
  })

  test("primary path: session.renamed with a valid tag files the session", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_1", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_1", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)

    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe("Tech")
    expect(folders[0].sessionIds).toEqual(["ses_1"])
    await cleanup?.()
  })

  test("primary path: session.created with a scheduler-preset tag files the session immediately", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_sched", directory: "/proj", title: "Morning sales brief [Sales] 2026-08-28 06:00" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.created", data: { sessionID: "ses_sched", title: "Morning sales brief [Sales] 2026-08-28 06:00" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)

    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders[0].name).toBe("Sales")
    expect(folders[0].sessionIds).toEqual(["ses_sched"])
    await cleanup?.()
  })

  test("fallback: first execution.succeeded check misses the tag, a later bounded check within budget files it", async () => {
    const sessionGet = makeSessionGetQueue([
      session({ id: "ses_2", directory: "/session/scope", title: "Untitled" }),
      session({ id: "ses_2", directory: "/session/scope", title: "Deploy pipeline [Sales]" }),
    ])
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 3, fallbackDelayMs: 5 },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.execution.succeeded", data: { sessionID: "ses_2" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)

    expect(sessionGet.callCount()).toBe(2)
    const folders = folderApi.getState().foldersMap["/session/scope"]
    expect(folders[0].name).toBe("Sales")
    expect(folders[0].sessionIds).toEqual(["ses_2"])
    await cleanup?.()
  })

  test("fallback: never fires if the title never becomes valid within the bounded budget", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_3", title: "Untitled" })])
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 3, fallbackDelayMs: 5 },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.execution.succeeded", data: { sessionID: "ses_3" } })
    await waitUntil(() => sessionGet.callCount() >= 3)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The turn-end event also kicks off a sweep, which only reads; nothing is written.
    expect(folderApi.postCallCount()).toBe(0)
    await cleanup?.()
  })

  test("no premature filing while title is still the default (no trailing tag)", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_4", title: "Untitled" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_4", title: "Untitled" } })
    await waitUntil(() => sessionGet.callCount() >= 1)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(folderApi.getCallCount()).toBe(0)
    expect(folderApi.postCallCount()).toBe(0)
    await cleanup?.()
  })

  test("idempotency: repeated session.renamed for an already-filed session does not duplicate", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_5", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_5", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)
    push({ type: "session.renamed", data: { sessionID: "ses_5", title: "Fix the bug [Tech]" } })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(folderApi.postCallCount()).toBe(1)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders[0].sessionIds).toEqual(["ses_5"])
    await cleanup?.()
  })

  test("no memory: a later turn re-checks the session but never rewrites one that is already filed", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_6", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 3, fallbackDelayMs: 5, reconcileIntervalMs: 86_400_000 },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_6", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)
    push({ type: "session.execution.succeeded", data: { sessionID: "ses_6" } })
    await waitUntil(() => sessionGet.callCount() >= 2)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(folderApi.postCallCount()).toBe(1)
    await cleanup?.()
  })

  test("no memory: a session dragged out of its folder is put back on its next turn", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_8", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 1, reconcileIntervalMs: 86_400_000 },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_8", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)
    const state = folderApi.getState()
    const tech = state.foldersMap["/proj"].find((folder: any) => folder.name === "Tech")
    tech.sessionIds = []
    state.foldersMap["/proj"].push({ id: "other", name: "Other", sessionIds: ["ses_8"], createdAt: 5 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    push({ type: "session.execution.succeeded", data: { sessionID: "ses_8" } })
    await waitUntil(() => folderApi.postCallCount() >= 2)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders.find((folder: any) => folder.name === "Tech").sessionIds).toEqual(["ses_8"])
    expect(folders.find((folder: any) => folder.name === "Other").sessionIds).toEqual([])
    await cleanup?.()
  })

  test("fail-open: an API failure during the fallback path does not throw and is logged", async () => {
    const sessionGet = makeSessionGetQueue([{ __throw: "network unreachable" } as any])
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 3, fallbackDelayMs: 5 },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.execution.succeeded", data: { sessionID: "ses_7" } })
    await waitUntil(() => sessionGet.callCount() >= 3)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(errorSpy).toHaveBeenCalled()
    expect(folderApi.postCallCount()).toBe(0)
    await cleanup?.()
  })

  test("HTTP 200 ignored:true retries after refetching, preserving a concurrent folder change (dead path against OpenChamber 2.1.1, still correct if a server ever sends it)", async () => {
    folderApi = createFolderApiMock()
    globalThis.fetch = folderApi.fetchMock
    const initialState = folderApi.getState()
    initialState.updatedAt = Date.now() + 30
    initialState.foldersMap["/proj"] = [
      { id: "concurrent-1", name: "Other", sessionIds: ["ses_other"], createdAt: Date.now(), parentId: null },
    ]
    const sessionGet = makeSessionGetQueue([session({ id: "ses_8", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_8", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 2)

    expect(folderApi.getCallCount()).toBe(2)
    const folders = folderApi.getState().foldersMap["/proj"]
    const other = folders.find((f: any) => f.name === "Other")
    const tech = folders.find((f: any) => f.name === "Tech")
    expect(other?.sessionIds).toEqual(["ses_other"])
    expect(tech?.sessionIds).toEqual(["ses_8"])
    await cleanup?.()
  })

  test("mappings: flat string mapping resolves to a custom folder name", async () => {
    const sessionGet = makeSessionGetQueue([session({ id: "ses_flat", directory: "/proj", title: "Follow up [Sales]" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999", mappings: { Sales: "Client work" } }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_flat", title: "Follow up [Sales]" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)

    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders[0].name).toBe("Client work")
    expect(folders[0].sessionIds).toEqual(["ses_flat"])
    await cleanup?.()
  })

  test("mappings: invalid values are ignored and never trigger a folder move", async () => {
    const sessionGet = makeSessionGetQueue([
      session({ id: "ses_Empty", directory: "/proj", title: "Untitled [Empty]" }),
      session({ id: "ses_Numeric", directory: "/proj", title: "Untitled [Numeric]" }),
      session({ id: "ses_Nullish", directory: "/proj", title: "Untitled [Nullish]" }),
    ])
    const { ctx, push } = makeCtx({
      options: {
        apiBaseUrl: "http://localhost:9999",
        mappings: { Empty: "", Numeric: 123, Nullish: null } as any,
      },
      sessionGet: sessionGet.fn,
    })
    const cleanup = await plugin.setup(ctx)

    for (const label of ["Empty", "Numeric", "Nullish"]) {
      push({ type: "session.renamed", data: { sessionID: `ses_${label}`, title: `Untitled [${label}]` } })
    }
    await waitUntil(() => sessionGet.callCount() >= 3)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(folderApi.getCallCount()).toBe(0)
    expect(folderApi.postCallCount()).toBe(0)
    await cleanup?.()
  })

  test("bounded exhaustion: writes ignored on every attempt stop after MAX_WRITE_ATTEMPTS, fail open, and leave the session retryable", async () => {
    folderApi = createFolderApiMock({ forceIgnoredWrites: 3 })
    globalThis.fetch = folderApi.fetchMock
    const sessionGet = makeSessionGetQueue([session({ id: "ses_9", directory: "/proj", title: "Fix the bug [Tech]" })])
    const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
    const cleanup = await plugin.setup(ctx)

    push({ type: "session.renamed", data: { sessionID: "ses_9", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 3)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(folderApi.postCallCount()).toBe(3)
    expect(folderApi.getCallCount()).toBe(3)
    expect(errorSpy).toHaveBeenCalled()
    expect(folderApi.getState().foldersMap["/proj"] ?? []).toHaveLength(0)

    push({ type: "session.renamed", data: { sessionID: "ses_9", title: "Fix the bug [Tech]" } })
    await waitUntil(() => folderApi.postCallCount() >= 4)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders.find((f: any) => f.name === "Tech")?.sessionIds).toEqual(["ses_9"])
    await cleanup?.()
  })

  test("event path: a subagent session is filed with its root session", async () => {
    const byId: Record<string, any> = {
      ses_root: session({ id: "ses_root", title: "Quarterly review [Sales]" }),
      ses_sub: session({ id: "ses_sub", title: "Subtask", parentID: "ses_root" }),
    }
    const { ctx, push } = makeCtx({
      options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 1, reconcileIntervalMs: 86_400_000 },
      sessionGet: async ({ sessionID }: any) => byId[sessionID],
    })
    const cleanup = await plugin.setup(ctx)
    push({ type: "session.created", data: { sessionID: "ses_sub" } })
    await waitUntil(() => folderApi.postCallCount() >= 1)
    expect(folderApi.getState().foldersMap["/proj"].find((folder: any) => folder.name === "Sales").sessionIds).toEqual(["ses_sub"])
    await cleanup?.()
  })

  describe("periodic sweep over OpenChamber's GET /api/session", () => {
    // The first turn-end event triggers the sweep (lastSweepAt starts at 0).
    async function runSweep(options: Record<string, unknown>, sessions: Array<Record<string, unknown>>, pageSize?: number) {
      await loadFreshPlugin()
      folderApi = createFolderApiMock({ sessions, pageSize })
      globalThis.fetch = folderApi.fetchMock
      const { ctx, push } = makeCtx({
        options: { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 1, ...options },
        sessionGet: async () => { throw new Error("session.get must not be needed by the sweep") },
      })
      const cleanup = await plugin.setup(ctx)
      push({ type: "session.execution.succeeded", data: { sessionID: "ses_trigger" } })
      return cleanup!
    }

    test("files misfiled and unfiled sessions by tag, keyword and directory, and puts back one that was moved by hand", async () => {
      const sessions = [
        session({ id: "ses_wrong", title: "Wrong folder [Sales]" }),
        session({ id: "ses_tag", title: "Unassigned [Sales]" }),
        session({ id: "ses_kw", title: "Cotización del cliente Acme" }),
        session({ id: "ses_dir", directory: "/proj/family", title: "Whatever" }),
        session({ id: "ses_none", title: "Nothing matches" }),
      ]
      folderApi = createFolderApiMock({ sessions })
      folderApi.getState().foldersMap["/proj"] = [
        { id: "sales", name: "Sales", sessionIds: [], createdAt: 1 },
        { id: "client-work", name: "Client work", sessionIds: ["ses_wrong"], createdAt: 2 },
      ]
      globalThis.fetch = folderApi.fetchMock
      const { ctx, push } = makeCtx({
        options: {
          apiBaseUrl: "http://localhost:9999",
          fallbackMaxAttempts: 1,
          rules: [
            { folder: "Sales", keywords: ["cotizacion", "cliente*"] },
            { folder: "Personal", tags: [], directories: ["/proj/family"] },
          ],
        },
        sessionGet: async () => { throw new Error("not used") },
      })
      const cleanup = await plugin.setup(ctx)
      try {
        push({ type: "session.execution.succeeded", data: { sessionID: "ses_trigger" } })
        await waitUntil(() => folderApi.postCallCount() >= 1)
        const folders = folderApi.getState().foldersMap["/proj"]
        const ids = (name: string) => folders.find((folder: any) => folder.name === name)?.sessionIds
        expect(ids("Sales")).toEqual(["ses_wrong", "ses_tag", "ses_kw"])
        expect(ids("Client work")).toEqual([])
        // Folders are scoped by the session's own directory, so the directory-rule
        // match lands in /proj/family's scope, not /proj's.
        expect(folderApi.getState().foldersMap["/proj/family"].find((folder: any) => folder.name === "Personal").sessionIds).toEqual(["ses_dir"])
        expect(ids("Personal")).toBeUndefined()
        expect(folderApi.postCallCount()).toBe(1)
      } finally {
        await cleanup?.()
      }
    })

    test("pagination terminates when the last page still carries a cursor", async () => {
      const sessions = Array.from({ length: 5 }, (_, index) => session({ id: `ses_p${index}`, title: `Item ${index} [Tech]` }))
      const cleanup = await runSweep({}, sessions, 2)
      try {
        await waitUntil(() => folderApi.postCallCount() >= 1)
        const tech = folderApi.getState().foldersMap["/proj"].find((folder: any) => folder.name === "Tech")
        expect(tech.sessionIds).toEqual(["ses_p0", "ses_p1", "ses_p2", "ses_p3", "ses_p4"])
        // 5 sessions at 2 per page = 3 data pages + 1 empty page, then it stops.
        expect(folderApi.listCallCount()).toBe(4)
      } finally {
        await cleanup()
      }
    })

    test("archived sessions are skipped", async () => {
      const cleanup = await runSweep({}, [
        session({ id: "ses_old", title: "Old [Tech]", archived: 1 }),
        session({ id: "ses_ok", title: "Live [Tech]" }),
      ])
      try {
        await waitUntil(() => folderApi.postCallCount() >= 1)
        expect(folderApi.getState().foldersMap["/proj"].find((folder: any) => folder.name === "Tech").sessionIds).toEqual(["ses_ok"])
      } finally {
        await cleanup()
      }
    })

    test("a subagent session follows its root session, ignoring its own title", async () => {
      const cleanup = await runSweep({}, [
        session({ id: "ses_root", title: "Pipeline notes [Sales]" }),
        session({ id: "ses_child", title: "Explore the repo [Tech]", parentID: "ses_root" }),
        session({ id: "ses_grandchild", title: "Untitled", parentID: "ses_child" }),
      ])
      try {
        await waitUntil(() => folderApi.postCallCount() >= 1)
        const folders = folderApi.getState().foldersMap["/proj"]
        expect(folders.find((folder: any) => folder.name === "Sales").sessionIds).toEqual(["ses_root", "ses_child", "ses_grandchild"])
        expect(folders.find((folder: any) => folder.name === "Tech")).toBeUndefined()
      } finally {
        await cleanup()
      }
    })

    test("a subagent whose parent is not in the listing is looked up; an unreadable parent leaves it alone", async () => {
      // `ses_far` exists on the server but is not in the first listing pages we serve.
      const sessions = [
        session({ id: "ses_kid", title: "Kid", parentID: "ses_far" }),
        session({ id: "ses_orphan", title: "Orphan [Tech]", parentID: "ses_missing" }),
        session({ id: "ses_far", title: "Far away [Sales]" }),
      ]
      const cleanup = await runSweep({}, sessions, 2)
      try {
        await waitUntil(() => folderApi.postCallCount() >= 1)
        const folders = folderApi.getState().foldersMap["/proj"]
        expect(folders.find((folder: any) => folder.name === "Sales").sessionIds).toEqual(["ses_kid", "ses_far"])
        expect(folders.find((folder: any) => folder.name === "Tech")).toBeUndefined()
      } finally {
        await cleanup()
      }
    })

    test("includeSubagents: false leaves subagents alone", async () => {
      const cleanup = await runSweep({ includeSubagents: false }, [
        session({ id: "ses_root", title: "Root [Sales]" }),
        session({ id: "ses_child", title: "Child", parentID: "ses_root" }),
      ])
      try {
        await waitUntil(() => folderApi.postCallCount() >= 1)
        expect(folderApi.getState().foldersMap["/proj"].find((folder: any) => folder.name === "Sales").sessionIds).toEqual(["ses_root"])
      } finally {
        await cleanup()
      }
    })

    test("dryRun reports what would move and writes nothing", async () => {
      const cleanup = await runSweep({ dryRun: true }, [session({ id: "ses_d", title: "Dry [Tech]" })])
      try {
        await waitUntil(() => folderApi.listCallCount() >= 1)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(folderApi.postCallCount()).toBe(0)
      } finally {
        await cleanup()
      }
    })
  })

  describe("current_session tool", () => {
    const toolContext = (sessionID?: string) => ({ sessionID, agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} })
    const parse = (result: any) => JSON.parse(result.content)

    // Session store keyed by id, so every lookup answers for exactly the id asked.
    const store = (entries: Record<string, Record<string, unknown>>) => async (args: any) => {
      const found = entries[args.sessionID]
      if (!found) throw new Error(`session ${args.sessionID} not found`)
      return found
    }

    async function setupWithTool(sessionGet: (args: unknown) => Promise<unknown>, options: Record<string, unknown> = {}) {
      const made = makeCtx({ options: { apiBaseUrl: "http://localhost:9999", ...options }, sessionGet })
      const cleanup = await plugin.setup(made.ctx)
      const definition = made.toolState.definitions[0]
      return { ...made, cleanup, definition, run: (sessionID?: string) => definition.execute({}, toolContext(sessionID)) }
    }

    test("registers one direct tool with an empty-object input schema", async () => {
      const { definition, toolState, cleanup } = await setupWithTool(store({}))
      expect(toolState.definitions).toHaveLength(1)
      expect(definition.name).toBe("current_session")
      expect(definition.input).toEqual({ type: "object", properties: {}, additionalProperties: false })
      expect(definition.options).toEqual({ codemode: false })
      expect(definition.description).toContain("never search by title")
      await cleanup?.()
    })

    test("returns the calling session's own id, title, directory and parent", async () => {
      const entries = { ses_a: session({ id: "ses_a", title: "Work [Tech]", directory: "/proj/a" }) }
      const { run, cleanup } = await setupWithTool(store(entries))
      expect(parse(await run("ses_a"))).toEqual({ ok: true, id: "ses_a", title: "Work [Tech]", directory: "/proj/a", isChild: false, archived: false })
      await cleanup?.()
    })

    test("concurrent calls from different sessions each get their own id", async () => {
      const entries: Record<string, Record<string, unknown>> = {}
      for (let index = 0; index < 20; index += 1) entries[`ses_${index}`] = session({ id: `ses_${index}`, title: "Same title", directory: `/proj/${index % 3}` })
      // Slow, out-of-order lookups: answers must still pair with the question.
      const lookup = async (args: any) => {
        await new Promise((resolve) => setTimeout(resolve, 20 - Number(args.sessionID.slice(4))))
        return entries[args.sessionID]
      }
      const { run, cleanup } = await setupWithTool(lookup)
      const results = await Promise.all(Object.keys(entries).map((id) => run(id)))
      expect(results.map((result) => parse(result).id)).toEqual(Object.keys(entries))
      await cleanup?.()
    })

    test("identical titles never confuse identity", async () => {
      const entries = {
        ses_1: session({ id: "ses_1", title: "Resume this [Tech]" }),
        ses_2: session({ id: "ses_2", title: "Resume this [Tech]" }),
      }
      const { run, cleanup } = await setupWithTool(store(entries))
      expect(parse(await run("ses_2")).id).toBe("ses_2")
      expect(parse(await run("ses_1")).id).toBe("ses_1")
      await cleanup?.()
    })

    test("a rename between calls changes the title but never the id", async () => {
      const entries: Record<string, Record<string, unknown>> = { ses_r: session({ id: "ses_r", title: "Old title" }) }
      const { run, cleanup } = await setupWithTool(store(entries))
      const before = parse(await run("ses_r"))
      entries.ses_r = session({ id: "ses_r", title: "AI renamed [Sales]" })
      const after = parse(await run("ses_r"))
      expect(before).toMatchObject({ id: "ses_r", title: "Old title" })
      expect(after).toMatchObject({ id: "ses_r", title: "AI renamed [Sales]" })
      await cleanup?.()
    })

    test("still available when filing is disabled (enabled: false)", async () => {
      const entries = { ses_off: session({ id: "ses_off", title: "x" }) }
      const { run, cleanup } = await setupWithTool(store(entries), { enabled: false })
      expect(parse(await run("ses_off")).id).toBe("ses_off")
      await cleanup?.()
    })

    test("a child session reports its own id, not its parent or root", async () => {
      const entries = {
        ses_root: session({ id: "ses_root", title: "Root [Tech]" }),
        ses_child: session({ id: "ses_child", title: "Subagent", parentID: "ses_root" }),
      }
      const { run, cleanup } = await setupWithTool(store(entries))
      expect(parse(await run("ses_child"))).toMatchObject({ id: "ses_child", parentID: "ses_root", isChild: true })
      await cleanup?.()
    })

    test("worktree metadata is reported from the session's own location", async () => {
      const entries = { ses_w: { ...session({ id: "ses_w", directory: "/work/tree-1" }), location: { directory: "/work/tree-1", workspaceID: "wrk_9" } } }
      const { run, cleanup } = await setupWithTool(store(entries))
      expect(parse(await run("ses_w"))).toMatchObject({ id: "ses_w", directory: "/work/tree-1", workspaceID: "wrk_9" })
      await cleanup?.()
    })

    test("archived state is surfaced", async () => {
      const entries = { ses_z: session({ id: "ses_z", archived: 1700000000000 }) }
      const { run, cleanup } = await setupWithTool(store(entries))
      expect(parse(await run("ses_z")).archived).toBe(true)
      await cleanup?.()
    })

    test("missing context returns a structured error without calling session.get", async () => {
      const get = makeSessionGetQueue([session({ id: "ses_never" })])
      const { definition, cleanup } = await setupWithTool(get.fn)
      for (const context of [undefined, null, {}, { sessionID: "" }, { sessionID: 7 }]) {
        const result = parse(await definition.execute({}, context))
        expect(result).toMatchObject({ ok: false, reason: "no-context" })
        expect(result.id).toBeUndefined()
      }
      expect(get.callCount()).toBe(0)
      await cleanup?.()
    })

    test("a failing session.get returns an error naming the context id, never another id", async () => {
      const { run, cleanup } = await setupWithTool(async () => { throw new Error("backend down") })
      const result = parse(await run("ses_x"))
      expect(result).toMatchObject({ ok: false, reason: "lookup-failed", contextSessionID: "ses_x" })
      expect(result.error).toContain("backend down")
      expect(result.id).toBeUndefined()
      await cleanup?.()
    })

    test("an id mismatch from session.get is an error, not a substitute id", async () => {
      const { run, cleanup } = await setupWithTool(async () => session({ id: "ses_other", title: "Someone else" }))
      const result = parse(await run("ses_asked"))
      expect(result).toMatchObject({ ok: false, reason: "id-mismatch", contextSessionID: "ses_asked" })
      expect(result.id).toBeUndefined()
      expect(parse(await (await setupWithTool(async () => null)).run("ses_asked")).reason).toBe("id-mismatch")
      await cleanup?.()
    })

    test("the executor never rejects", async () => {
      const { definition, cleanup } = await setupWithTool(async () => { throw "not even an Error" })
      await expect(definition.execute({}, toolContext("ses_q"))).resolves.toBeDefined()
      await cleanup?.()
    })

    test("never reads ctx.location.directory or the title to decide identity", async () => {
      const calls: unknown[] = []
      const { run, cleanup } = await setupWithTool(async (args: any) => { calls.push(args); return session({ id: args.sessionID, directory: "/elsewhere" }) })
      await run("ses_only")
      expect(calls).toEqual([{ sessionID: "ses_only" }])
      await cleanup?.()
    })

    test("a host without ctx.tool still loads and files sessions", async () => {
      const sessionGet = makeSessionGetQueue([session({ id: "ses_nt", directory: "/proj", title: "Fix [Tech]" })])
      const { ctx, push } = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn, withTool: false })
      const cleanup = await plugin.setup(ctx)
      push({ type: "session.renamed", data: { sessionID: "ses_nt", title: "Fix [Tech]" } })
      await waitUntil(() => folderApi.postCallCount() >= 1)
      expect(folderApi.getState().foldersMap["/proj"][0].sessionIds).toEqual(["ses_nt"])
      await cleanup?.()
    })

    test("a failing tool registration is logged and filing still works", async () => {
      const sessionGet = makeSessionGetQueue([session({ id: "ses_tf", directory: "/proj", title: "Fix [Tech]" })])
      const made = makeCtx({ options: { apiBaseUrl: "http://localhost:9999" }, sessionGet: sessionGet.fn })
      made.toolState.transformError = new Error("transform rejected")
      const cleanup = await plugin.setup(made.ctx)
      made.push({ type: "session.renamed", data: { sessionID: "ses_tf", title: "Fix [Tech]" } })
      await waitUntil(() => folderApi.postCallCount() >= 1)
      expect(errorSpy.mock.calls.some((call) => String(call[1]).includes("could not register"))).toBe(true)
      await cleanup?.()
      expect(made.toolState.disposed).toBe(0)
    })

    test("cleanup disposes the tool registration exactly once", async () => {
      const { cleanup, toolState } = await setupWithTool(store({}))
      expect(toolState.disposed).toBe(0)
      await cleanup?.()
      expect(toolState.disposed).toBe(1)
    })

    test("two plugin instances (two directories) register independently and answer for their caller", async () => {
      const entries = { ses_d1: session({ id: "ses_d1", directory: "/d1" }), ses_d2: session({ id: "ses_d2", directory: "/d2" }) }
      const one = await setupWithTool(store(entries))
      const two = await setupWithTool(store(entries))
      expect(parse(await one.run("ses_d1")).directory).toBe("/d1")
      expect(parse(await two.run("ses_d2")).directory).toBe("/d2")
      await one.cleanup?.()
      await two.cleanup?.()
      expect(one.toolState.disposed).toBe(1)
      expect(two.toolState.disposed).toBe(1)
    })
  })
})
