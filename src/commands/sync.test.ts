import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse, stringify } from "yaml"
import type { Notification, NotifOpts, SocialPlatform } from "../platforms/types.js"

const { getPlatformAsyncMock, loadConfigMock } = vi.hoisted(() => ({
  getPlatformAsyncMock: vi.fn(),
  loadConfigMock: vi.fn(),
}))

vi.mock("../platforms/index.js", () => ({
  getPlatformAsync: getPlatformAsyncMock,
  availablePlatforms: vi.fn(),
}))

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}))

import { legacyTimestampCursor, sync } from "./sync.js"

function notification(id: string, timestamp: string): Notification {
  return {
    id,
    platform: "x",
    type: "mention",
    author: "alice",
    postId: id,
    text: id,
    timestamp,
  }
}

function platform(notifications: (opts?: NotifOpts) => Promise<{ notifications: Notification[]; cursor?: string }>): SocialPlatform {
  return {
    name: "x",
    post: async () => { throw new Error("post not implemented") },
    reply: async () => { throw new Error("reply not implemented") },
    thread: async () => { throw new Error("thread not implemented") },
    notifications,
    search: async () => [],
    feed: async () => [],
    rateLimitStatus: async () => ({ platform: "x", remaining: 0, limit: 0, resetsAt: new Date(0).toISOString() }),
  }
}

describe("sync notification cursors", () => {
  const originalCwd = process.cwd()
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "social-cli-sync-test-"))
    process.chdir(testDir)
    mkdirSync(join(testDir, "state"))
    getPlatformAsyncMock.mockReset()
    loadConfigMock.mockReset()
    loadConfigMock.mockReturnValue({ accounts: {}, state: { stateDir: "state" } })
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it("recognizes only valid ISO timestamp cursors as legacy state", () => {
    expect(legacyTimestampCursor("2026-08-17T17:06:36.367Z")).toBe("2026-08-17T17:06:36.367Z")
    expect(legacyTimestampCursor("2026-08-17T17:06:36+00:00")).toBe("2026-08-17T17:06:36+00:00")
    expect(legacyTimestampCursor("2089355168643219540")).toBeUndefined()
    expect(legacyTimestampCursor("2026-08-17")).toBeUndefined()
    expect(legacyTimestampCursor("not-a-cursor")).toBeUndefined()
  })

  it("migrates a legacy timestamp without passing it as an opaque cursor", async () => {
    const legacyCursor = "2026-08-17T17:06:36.367Z"
    const notificationsMock = vi.fn().mockResolvedValue({
      notifications: [notification("200", "2026-08-17T17:07:00.000Z")],
      cursor: "200",
    })
    getPlatformAsyncMock.mockResolvedValue(platform(notificationsMock))

    writeFileSync(join(testDir, "state", "inbox-x.yaml"), stringify({
      notifications: [notification("199", legacyCursor)],
      _sync: { cursor: legacyCursor },
    }))

    await sync({ platforms: ["x"] })

    expect(notificationsMock).toHaveBeenCalledWith({
      limit: 50,
      unreadOnly: true,
      cursor: undefined,
      since: legacyCursor,
    })
    const inbox = parse(readFileSync(join(testDir, "state", "inbox-x.yaml"), "utf-8"))
    expect(inbox.notifications.map((item: Notification) => item.id)).toEqual(["199", "200"])
    expect(inbox._sync).toMatchObject({ cursor: "200", newCount: 1, totalCount: 2 })
  })

  it("passes opaque cursors through and preserves them when no newer cursor is returned", async () => {
    const notificationsMock = vi.fn().mockResolvedValue({ notifications: [] })
    getPlatformAsyncMock.mockResolvedValue(platform(notificationsMock))

    writeFileSync(join(testDir, "state", "inbox-x.yaml"), stringify({
      notifications: [],
      _sync: { cursor: "2089355168643219540" },
    }))

    await sync({ platforms: ["x"], limit: 10 })

    expect(notificationsMock).toHaveBeenCalledWith({
      limit: 10,
      unreadOnly: true,
      cursor: "2089355168643219540",
      since: undefined,
    })
    const inbox = parse(readFileSync(join(testDir, "state", "inbox-x.yaml"), "utf-8"))
    expect(inbox._sync.cursor).toBe("2089355168643219540")
  })

  it("preserves legacy state when the platform fetch fails", async () => {
    const legacyCursor = "2026-08-17T17:06:36.367Z"
    const notificationsMock = vi.fn().mockRejectedValue(new Error("credits depleted"))
    getPlatformAsyncMock.mockResolvedValue(platform(notificationsMock))

    writeFileSync(join(testDir, "state", "inbox-x.yaml"), stringify({
      notifications: [notification("199", legacyCursor)],
      _sync: { cursor: legacyCursor },
    }))

    await sync({ platforms: ["x"] })

    const inbox = parse(readFileSync(join(testDir, "state", "inbox-x.yaml"), "utf-8"))
    expect(inbox.notifications.map((item: Notification) => item.id)).toEqual(["199"])
    expect(inbox._sync).toMatchObject({ cursor: legacyCursor, newCount: 0, totalCount: 1 })
  })
})
