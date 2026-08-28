import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Mock } from "bun:test"
import plugin from "../src/index.ts"

type FolderApiMock = {
  fetchMock: typeof fetch
  getCallCount: () => number
  postCallCount: () => number
  getState: () => any
}

function createFolderApiMock(): FolderApiMock {
  let state: any = { version: 1, rev: 0, foldersMap: {}, collapsedFolderIds: [] }
  let getCalls = 0
  let postCalls = 0

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
      if (body.baseRev !== state.rev) return new Response(null, { status: 409 })
      state = {
        version: body.version,
        rev: state.rev + 1,
        foldersMap: body.foldersMap,
        collapsedFolderIds: body.collapsedFolderIds,
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
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
})
