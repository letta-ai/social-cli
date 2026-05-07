import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stringify } from "yaml"
import type { SocialPlatform } from "../platforms/types.js"

const { runHooksMock, getPlatformAsyncMock } = vi.hoisted(() => ({
  runHooksMock: vi.fn(),
  getPlatformAsyncMock: vi.fn(),
}))

vi.mock("../hooks.js", () => ({
  runHooks: runHooksMock,
}))

vi.mock("../platforms/index.js", () => ({
  getPlatformAsync: getPlatformAsyncMock,
}))

import { dispatch } from "./dispatch.js"

function createPlatform(overrides: Partial<SocialPlatform> = {}): SocialPlatform {
  return {
    name: "test",
    post: async () => {
      throw new Error("post not implemented")
    },
    reply: async () => {
      throw new Error("reply not implemented")
    },
    thread: async () => {
      throw new Error("thread not implemented")
    },
    notifications: async () => ({ notifications: [] }),
    search: async () => [],
    feed: async () => [],
    rateLimitStatus: async () => ({
      platform: "test",
      remaining: 0,
      limit: 0,
      resetsAt: new Date(0).toISOString(),
    }),
    ...overrides,
  }
}

describe("dispatch hook alignment", () => {
  const originalCwd = process.cwd()
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "social-cli-dispatch-test-"))
    process.chdir(testDir)
    writeFileSync(join(testDir, "config.yaml"), stringify({ accounts: {} }))

    runHooksMock.mockReset()
    runHooksMock.mockResolvedValue({ results: [], blocked: false, abort: false })
    getPlatformAsyncMock.mockReset()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it("fires postDispatch hooks with the correct action for multi-platform posts", async () => {
    getPlatformAsyncMock.mockImplementation(async (platform: string) => {
      if (platform === "bsky") {
        return createPlatform({
          post: async (text: string) => ({ platform: "bsky", id: "bsky-post-1", uri: "at://bsky-post-1", text }),
          follow: async () => {},
        })
      }

      if (platform === "x") {
        return createPlatform({
          post: async (text: string) => ({ platform: "x", id: "x-post-1", text }),
        })
      }

      throw new Error(`Unexpected platform: ${platform}`)
    })

    writeFileSync(
      join(testDir, "outbox-bsky.yaml"),
      stringify({
        dispatch: [
          { post: { text: "Hello from social-cli", platforms: ["bsky", "x"] } },
          { follow: { platform: "bsky", handle: "alice.bsky.social" } },
        ],
      }),
    )

    await dispatch({ file: "outbox-bsky.yaml" })

    const postDispatchContexts = runHooksMock.mock.calls
      .filter(([, lifecycle]) => lifecycle === "postDispatch")
      .map(([, , ctx]) => ({
        event: ctx.event,
        platform: ctx.platform,
        actionId: ctx.actionId,
        targetId: ctx.targetId,
        text: ctx.text,
        result: ctx.result,
      }))

    expect(postDispatchContexts).toEqual([
      {
        event: "post",
        platform: "bsky",
        actionId: "bsky-post-1",
        targetId: undefined,
        text: "Hello from social-cli",
        result: "success",
      },
      {
        event: "post",
        platform: "x",
        actionId: "x-post-1",
        targetId: undefined,
        text: "Hello from social-cli",
        result: "success",
      },
      {
        event: "follow",
        platform: "bsky",
        actionId: "alice.bsky.social",
        targetId: undefined,
        text: "",
        result: "success",
      },
    ])
  })

  it("fires one thread hook and keeps the next action aligned", async () => {
    const bsky = createPlatform({
      thread: async (posts: string[]) => posts.map((text, idx) => ({
        platform: "bsky",
        id: `thread-${idx + 1}`,
        uri: `at://thread-${idx + 1}`,
        text,
      })),
      like: async () => {},
    })

    getPlatformAsyncMock.mockResolvedValue(bsky)

    writeFileSync(
      join(testDir, "outbox-bsky.yaml"),
      stringify({
        dispatch: [
          { thread: { platform: "bsky", posts: ["First", "Second"] } },
          { like: { platform: "bsky", id: "at://target-post" } },
        ],
      }),
    )

    await dispatch({ file: "outbox-bsky.yaml" })

    const postDispatchContexts = runHooksMock.mock.calls
      .filter(([, lifecycle]) => lifecycle === "postDispatch")
      .map(([, , ctx]) => ({
        event: ctx.event,
        platform: ctx.platform,
        actionId: ctx.actionId,
        targetId: ctx.targetId,
        text: ctx.text,
        result: ctx.result,
      }))

    expect(postDispatchContexts).toEqual([
      {
        event: "thread",
        platform: "bsky",
        actionId: "thread-1",
        targetId: undefined,
        text: "First\nSecond",
        result: "success",
      },
      {
        event: "like",
        platform: "bsky",
        actionId: undefined,
        targetId: "at://target-post",
        text: "",
        result: "success",
      },
    ])
  })

  it("fires onError hooks with the correct target platform for per-platform post failures", async () => {
    getPlatformAsyncMock.mockImplementation(async (platform: string) => {
      if (platform === "bsky") {
        return createPlatform({
          post: async (text: string) => ({ platform: "bsky", id: "bsky-post-1", uri: "at://bsky-post-1", text }),
        })
      }

      if (platform === "x") {
        return createPlatform({
          post: async () => {
            throw new Error("x post failed")
          },
        })
      }

      throw new Error(`Unexpected platform: ${platform}`)
    })

    writeFileSync(
      join(testDir, "outbox-bsky.yaml"),
      stringify({
        dispatch: [
          { post: { text: "Hello from social-cli", platforms: ["bsky", "x"] } },
        ],
      }),
    )

    await expect(dispatch({ file: "outbox-bsky.yaml" })).rejects.toThrow('process.exit unexpectedly called with "2"')

    const postDispatchContexts = runHooksMock.mock.calls
      .filter(([, lifecycle]) => lifecycle === "postDispatch")
      .map(([, , ctx]) => ({
        event: ctx.event,
        platform: ctx.platform,
        actionId: ctx.actionId,
        text: ctx.text,
        result: ctx.result,
      }))

    const errorContexts = runHooksMock.mock.calls
      .filter(([, lifecycle]) => lifecycle === "onError")
      .map(([, , ctx]) => ({
        event: ctx.event,
        platform: ctx.platform,
        actionId: ctx.actionId,
        targetId: ctx.targetId,
        text: ctx.text,
        result: ctx.result,
        error: ctx.error,
      }))

    expect(postDispatchContexts).toEqual([
      {
        event: "post",
        platform: "bsky",
        actionId: "bsky-post-1",
        text: "Hello from social-cli",
        result: "success",
      },
    ])

    expect(errorContexts).toEqual([
      {
        event: "post",
        platform: "x",
        actionId: undefined,
        targetId: undefined,
        text: "Hello from social-cli",
        result: "error",
        error: "x post failed",
      },
    ])
  })
})
