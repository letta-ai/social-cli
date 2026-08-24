import { beforeEach, describe, expect, it, vi } from "vitest"

const { meMock, userMentionTimelineMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  userMentionTimelineMock: vi.fn(),
}))

vi.mock("twitter-api-v2", () => ({
  TwitterApi: class {
    v2 = {
      me: meMock,
      userMentionTimeline: userMentionTimelineMock,
    }
  },
}))

import { x } from "./x.js"

describe("X notification cursors", () => {
  beforeEach(() => {
    process.env.X_API_KEY = "test-key"
    process.env.X_API_SECRET = "test-secret"
    process.env.X_ACCESS_TOKEN = "test-token"
    process.env.X_ACCESS_TOKEN_SECRET = "test-token-secret"
    meMock.mockReset()
    userMentionTimelineMock.mockReset()
    meMock.mockResolvedValue({ data: { id: "sensemaker" } })
    userMentionTimelineMock.mockResolvedValue({ data: { data: [] }, includes: {} })
  })

  it("uses an opaque tweet cursor as since_id", async () => {
    await x.notifications({ cursor: "2089355168643219540", limit: 10 })

    expect(userMentionTimelineMock).toHaveBeenCalledOnce()
    const [, params] = userMentionTimelineMock.mock.calls[0]
    expect(params).toMatchObject({ max_results: 10, since_id: "2089355168643219540" })
    expect(params).not.toHaveProperty("start_time")
  })

  it("uses a legacy timestamp as start_time instead of since_id", async () => {
    await x.notifications({ since: "2026-08-17T17:06:36.367Z", limit: 10 })

    expect(userMentionTimelineMock).toHaveBeenCalledOnce()
    const [, params] = userMentionTimelineMock.mock.calls[0]
    expect(params).toMatchObject({ max_results: 10, start_time: "2026-08-17T17:06:36.367Z" })
    expect(params).not.toHaveProperty("since_id")
  })
})
