import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Mock } from "bun:test"
import plugin from "../src/index.ts"

type FolderApiMock = {
  fetchMock: typeof fetch
  getCallCount: () => number
  postCallCount: () => number
  getState: () => any
}

type FolderApiMockOptions = {
  // Number of upcoming POSTs to unconditionally answer with the real server's
  // `HTTP 200 { success: true, ignored: true }` shape, regardless of timestamps.
  // Models a deterministic "stale write" run for bounded-retry-exhaustion tests.
  forceIgnoredWrites?: number
  // Runs once, on the first forced-ignored POST, so a test can mutate `state` to model
  // a concurrent writer's change landing between this plugin's GET and its (ignored)
  // POST — proving a retry re-fetches and merges instead of reusing stale state.
  onFirstForcedIgnore?: (state: any) => void
}

function createFolderApiMock(options: FolderApiMockOptions = {}): FolderApiMock {
  let state: any = { version: 1, rev: 0, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 }
  let getCalls = 0
  let postCalls = 0
  let ignoredRemaining = options.forceIgnoredWrites ?? 0
  let firstForcedIgnoreFired = false

  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const parsed = new URL(url)
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

      // Real server semantics (see openchamber routes.js): last-write-wins by
      // `updatedAt`, not `baseRev` (the server never reads `baseRev` and never
      // returns 409). A write whose `updatedAt` is not strictly newer than the
      // stored one is silently ignored with HTTP 200.
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
    getState: () => state,
  }
}

function makeSessionGetQueue(responses: Array<{ data?: any; error?: any }>) {
  let calls = 0
  const fn = async (_args: unknown) => {
    const index = Math.min(calls, responses.length - 1)
    calls += 1
    return responses[index]
  }
  return { fn, callCount: () => calls }
}

function makeInput(sessionGet: (args: unknown) => Promise<{ data?: any; error?: any }>) {
  return {
    client: { session: { get: sessionGet } },
  } as any
}

function session(overrides: Partial<{ id: string; directory: string; title: string }>) {
  return { id: "ses_default", directory: "/proj", title: "Untitled", ...overrides }
}

describe("opencode-session-autofile", () => {
  let folderApi: FolderApiMock
  let errorSpy: Mock<typeof console.error>

  beforeEach(() => {
    folderApi = createFolderApiMock()
    globalThis.fetch = folderApi.fetchMock
    errorSpy = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  test("primary path: session.updated with a valid tag files the session", async () => {
    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })

    await hooks.event!({
      event: {
        type: "session.updated",
        properties: { info: session({ id: "ses_1", directory: "/proj", title: "Fix the bug [Tech]" }) },
      } as any,
    })

    expect(folderApi.postCallCount()).toBe(1)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe("Tech")
    expect(folders[0].sessionIds).toEqual(["ses_1"])
  })

  test("primary path: a valid tag before a scheduler timestamp files the session", async () => {
    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })

    await hooks.event!({
      event: {
        type: "session.updated",
        properties: { info: session({ id: "ses_scheduled", directory: "/proj", title: "Morning sales brief [Sales] 2026-08-28 06:00" }) },
      } as any,
    })

    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe("Sales")
    expect(folders[0].sessionIds).toEqual(["ses_scheduled"])
  })

  test("fallback: first session.idle check misses the tag, a later bounded check within budget files it", async () => {
    const sessionGet = makeSessionGetQueue([
      { data: session({ id: "ses_2", directory: "/session/scope", title: "Untitled" }) },
      { data: session({ id: "ses_2", directory: "/session/scope", title: "Deploy pipeline [Sales]" }) },
    ])
    const hooks = await plugin(makeInput(sessionGet.fn), {
      apiBaseUrl: "http://localhost:9999",
      fallbackMaxAttempts: 3,
      fallbackDelayMs: 5,
    })

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_2" } } as any,
    })

    expect(sessionGet.callCount()).toBe(2)
    expect(folderApi.postCallCount()).toBe(1)
    const folders = folderApi.getState().foldersMap["/session/scope"]
    expect(folders).toHaveLength(1)
    expect(folders[0].name).toBe("Sales")
    expect(folders[0].sessionIds).toEqual(["ses_2"])
  })

  test("fallback: never fires if the title never becomes valid within the bounded budget", async () => {
    const sessionGet = makeSessionGetQueue([{ data: session({ id: "ses_3", title: "Untitled" }) }])
    const hooks = await plugin(makeInput(sessionGet.fn), {
      apiBaseUrl: "http://localhost:9999",
      fallbackMaxAttempts: 3,
      fallbackDelayMs: 5,
    })

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_3" } } as any,
    })

    expect(sessionGet.callCount()).toBe(3)
    expect(folderApi.postCallCount()).toBe(0)
    expect(folderApi.getCallCount()).toBe(0)
  })

  test("no premature filing while title is still the default (no trailing tag)", async () => {
    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })

    await hooks.event!({
      event: {
        type: "session.updated",
        properties: { info: session({ id: "ses_4", title: "Untitled" }) },
      } as any,
    })

    expect(folderApi.getCallCount()).toBe(0)
    expect(folderApi.postCallCount()).toBe(0)
  })

  test("idempotency: repeated session.updated for an already-filed session does not duplicate", async () => {
    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })
    const info = session({ id: "ses_5", directory: "/proj", title: "Fix the bug [Tech]" })

    await hooks.event!({ event: { type: "session.updated", properties: { info } } as any })
    await hooks.event!({ event: { type: "session.updated", properties: { info } } as any })

    expect(folderApi.postCallCount()).toBe(1)
    expect(folderApi.getCallCount()).toBe(2)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders).toHaveLength(1)
    expect(folders[0].sessionIds).toEqual(["ses_5"])
  })

  test("idempotency: fallback skips a session already resolved by the primary path", async () => {
    const sessionGet = makeSessionGetQueue([{ data: session({ id: "ses_6", title: "Untitled" }) }])
    const hooks = await plugin(makeInput(sessionGet.fn), {
      apiBaseUrl: "http://localhost:9999",
      fallbackMaxAttempts: 3,
      fallbackDelayMs: 5,
    })
    const info = session({ id: "ses_6", directory: "/proj", title: "Fix the bug [Tech]" })

    await hooks.event!({ event: { type: "session.updated", properties: { info } } as any })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_6" } } as any })

    expect(sessionGet.callCount()).toBe(0)
    expect(folderApi.postCallCount()).toBe(1)
  })

  test("fail-open: an API failure during the fallback path does not throw and is logged", async () => {
    const hooks = await plugin(
      makeInput(async () => {
        throw new Error("network unreachable")
      }),
      { apiBaseUrl: "http://localhost:9999", fallbackMaxAttempts: 3, fallbackDelayMs: 5 },
    )

    await expect(
      hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_7" } } as any }),
    ).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalled()
    expect(folderApi.postCallCount()).toBe(0)
  })

  test("HTTP 200 ignored:true retries after refetching, preserving a concurrent folder change", async () => {
    // Model the real server's last-write-wins-by-timestamp check: a "concurrent
    // writer" has just stored a slightly-future updatedAt plus its own folder, so our
    // first write (computed from state we already fetched) lands stale and is
    // silently ignored with HTTP 200. The retry's delay (WRITE_RETRY_DELAY_MS) must
    // let real wall-clock time pass the stale threshold, and the retry's refetch must
    // pick up and preserve the concurrent writer's folder rather than clobbering it.
    folderApi = createFolderApiMock()
    globalThis.fetch = folderApi.fetchMock
    const initialState = folderApi.getState()
    initialState.updatedAt = Date.now() + 30
    initialState.foldersMap["/proj"] = [
      { id: "concurrent-1", name: "Other", sessionIds: ["ses_other"], createdAt: Date.now(), parentId: null },
    ]

    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })

    await hooks.event!({
      event: {
        type: "session.updated",
        properties: { info: session({ id: "ses_8", directory: "/proj", title: "Fix the bug [Tech]" }) },
      } as any,
    })

    expect(folderApi.postCallCount()).toBe(2)
    expect(folderApi.getCallCount()).toBe(2)
    const folders = folderApi.getState().foldersMap["/proj"]
    const other = folders.find((f: any) => f.name === "Other")
    const tech = folders.find((f: any) => f.name === "Tech")
    expect(other?.sessionIds).toEqual(["ses_other"])
    expect(tech?.sessionIds).toEqual(["ses_8"])
  })

  test("bounded exhaustion: writes ignored on every attempt stop after MAX_WRITE_ATTEMPTS, fail open, and leave the session retryable", async () => {
    folderApi = createFolderApiMock({ forceIgnoredWrites: 3 })
    globalThis.fetch = folderApi.fetchMock

    const hooks = await plugin(makeInput(async () => ({ data: undefined })), {
      apiBaseUrl: "http://localhost:9999",
    })
    const info = session({ id: "ses_9", directory: "/proj", title: "Fix the bug [Tech]" })

    await expect(
      hooks.event!({ event: { type: "session.updated", properties: { info } } as any }),
    ).resolves.toBeUndefined()

    expect(folderApi.postCallCount()).toBe(3)
    expect(folderApi.getCallCount()).toBe(3)
    expect(errorSpy).toHaveBeenCalled()
    expect(folderApi.getState().foldersMap["/proj"] ?? []).toHaveLength(0)

    // Recovery: the session was never added to resolvedSessions, so a later
    // session.idle fallback (or another session.updated) can still file it once
    // writes stop being ignored.
    await hooks.event!({ event: { type: "session.updated", properties: { info } } as any })
    expect(folderApi.postCallCount()).toBe(4)
    const folders = folderApi.getState().foldersMap["/proj"]
    expect(folders.find((f: any) => f.name === "Tech")?.sessionIds).toEqual(["ses_9"])
  })
})
