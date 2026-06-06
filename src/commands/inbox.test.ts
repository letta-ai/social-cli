import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse, stringify } from "yaml"
import type { OwnPostReply, SocialPlatform } from "../platforms/types.js"

const { getPlatformAsyncMock, availablePlatformsMock } = vi.hoisted(() => ({
  getPlatformAsyncMock: vi.fn(),
  availablePlatformsMock: vi.fn(),
}))

vi.mock("../platforms/index.js", () => ({
  getPlatformAsync: getPlatformAsyncMock,
  availablePlatforms: availablePlatformsMock,
}))

import { ownPostReplyToNotification, ownRepliesInbox } from "./inbox.js"

function createPlatform(replies: OwnPostReply[]): SocialPlatform {
  return {
    name: "bsky",
    post: async () => { throw new Error("post not implemented") },
    reply: async () => { throw new Error("reply not implemented") },
    thread: async () => { throw new Error("thread not implemented") },
    notifications: async () => ({ notifications: [] }),
    search: async () => [],
    feed: async () => [],
    rateLimitStatus: async () => ({ platform: "bsky", remaining: 0, limit: 0, resetsAt: new Date(0).toISOString() }),
    ownPostReplies: async () => replies,
  }
}

describe("inbox own-replies", () => {
  const originalCwd = process.cwd()
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "social-cli-own-replies-test-"))
    process.chdir(testDir)
    writeFileSync(join(testDir, "config.yaml"), stringify({ accounts: {}, state: { stateDir: "state" } }))
    getPlatformAsyncMock.mockReset()
    availablePlatformsMock.mockReset()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  it("converts own-post replies to normal notifications", () => {
    expect(ownPostReplyToNotification({
      platform: "bsky",
      id: "at://reply",
      author: "alice.example",
      authorId: "did:plc:alice",
      text: "hello",
      timestamp: "2026-01-01T00:00:00Z",
      ownPostId: "at://own/post",
      ownPostText: "root",
      rootId: "at://own/post",
      parentId: "at://own/post",
      parentAuthor: "void.example",
      threadContext: [{ id: "at://own/post", author: "void.example", text: "root" }],
    })).toEqual({
      id: "at://reply",
      platform: "bsky",
      type: "own_reply",
      author: "alice.example",
      authorId: "did:plc:alice",
      postId: "at://reply",
      text: "hello",
      timestamp: "2026-01-01T00:00:00Z",
      threadContext: [{ author: "void.example", text: "root" }],
      embed: undefined,
      ownPostId: "at://own/post",
      ownPostText: "root",
      rootId: "at://own/post",
      parentId: "at://own/post",
      parentAuthor: "void.example",
    })
  })

  it("filters handled replies and merges new ones into the platform inbox", async () => {
    const replies: OwnPostReply[] = [
      {
        platform: "bsky",
        id: "at://reply/processed",
        author: "alice.example",
        text: "already handled",
        timestamp: "2026-01-01T00:00:00Z",
        ownPostId: "at://own/one",
      },
      {
        platform: "bsky",
        id: "at://reply/existing",
        author: "bob.example",
        text: "already in inbox",
        timestamp: "2026-01-01T00:00:01Z",
        ownPostId: "at://own/two",
      },
      {
        platform: "bsky",
        id: "at://reply/new",
        author: "carol.example",
        text: "new reply",
        timestamp: "2026-01-01T00:00:02Z",
        ownPostId: "at://own/three",
        parentId: "at://own/three",
      },
    ]
    getPlatformAsyncMock.mockResolvedValue(createPlatform(replies))

    mkdirSync(join(testDir, "state"), { recursive: true })
    writeFileSync(join(testDir, "state", "processed-bsky.yaml"), stringify({ processed: ["at://reply/processed"] }))
    writeFileSync(join(testDir, "state", "sent_ledger-bsky.yaml"), stringify({
      entries: [{ createdId: "at://own/three" }],
    }))
    writeFileSync(join(testDir, "state", "inbox-bsky.yaml"), stringify({
      notifications: [ownPostReplyToNotification(replies[1])],
      _sync: { platform: "bsky", totalCount: 1 },
    }))

    const result = await ownRepliesInbox({ platforms: ["bsky"], unhandled: true, write: true, stateDir: "state" })

    expect(result.results).toMatchObject([
      {
        platform: "bsky",
        added: 1,
        alreadyInInbox: 1,
        skippedProcessed: 1,
      },
    ])
    expect(result.notifications.map((n) => n.id)).toEqual(["at://reply/existing", "at://reply/new"])

    const inbox = parse(readFileSync(join(testDir, "state", "inbox-bsky.yaml"), "utf-8"))
    expect(inbox.notifications.map((n: any) => n.id)).toEqual(["at://reply/existing", "at://reply/new"])
    expect(inbox._sync).toMatchObject({ source: "own-replies", newCount: 1, totalCount: 2 })
  })

  it("uses all available platforms by default", async () => {
    availablePlatformsMock.mockReturnValue(["bsky"])
    getPlatformAsyncMock.mockResolvedValue(createPlatform([]))

    await ownRepliesInbox({ stateDir: "state" })

    expect(getPlatformAsyncMock).toHaveBeenCalledWith("bsky")
  })
})
