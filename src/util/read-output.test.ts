import { describe, expect, it } from "vitest"
import { normalizeReadOutputItems } from "./read-output.js"

describe("normalizeReadOutputItems", () => {
  it("returns bare arrays from feed/search/posts output", () => {
    const items = [{ id: "post-1" }, { id: "post-2" }]

    expect(normalizeReadOutputItems(items)).toEqual(items)
  })

  it("returns notifications from inbox mappings", () => {
    const notifications = [{ id: "notif-1" }]

    expect(normalizeReadOutputItems({ notifications, _sync: { cursor: "abc" } })).toEqual(notifications)
  })

  it("returns posts/results/items/feed arrays from wrapped mappings", () => {
    expect(normalizeReadOutputItems({ posts: [{ id: "post-1" }] })).toEqual([{ id: "post-1" }])
    expect(normalizeReadOutputItems({ results: [{ id: "result-1" }] })).toEqual([{ id: "result-1" }])
    expect(normalizeReadOutputItems({ items: [{ id: "item-1" }] })).toEqual([{ id: "item-1" }])
    expect(normalizeReadOutputItems({ feed: [{ id: "feed-1" }] })).toEqual([{ id: "feed-1" }])
  })

  it("returns an empty list for missing or non-array item fields", () => {
    expect(normalizeReadOutputItems(undefined)).toEqual([])
    expect(normalizeReadOutputItems(null)).toEqual([])
    expect(normalizeReadOutputItems("not yaml data")).toEqual([])
    expect(normalizeReadOutputItems({ notifications: { id: "wrong-shape" } })).toEqual([])
    expect(normalizeReadOutputItems({ _sync: { cursor: "abc" } })).toEqual([])
  })

  it("supports explicit key priority for custom helpers", () => {
    const root = {
      primary: [{ id: "primary" }],
      notifications: [{ id: "notification" }],
    }

    expect(normalizeReadOutputItems(root, ["primary", "notifications"])).toEqual([{ id: "primary" }])
  })
})
