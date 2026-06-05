import { describe, expect, it } from "vitest"
import { validateOutbox } from "./validate.js"

describe("validateOutbox post actions", () => {
  it("accepts a singular platform when post text is present", () => {
    const result = validateOutbox({
      dispatch: [
        {
          post: {
            platform: "x",
            text: "hello from x",
          },
        },
      ],
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("rejects a singular platform without post text", () => {
    const result = validateOutbox({
      dispatch: [
        {
          post: {
            platform: "x",
          },
        },
      ],
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Action 0: post needs 'text' or 'platforms' with per-platform text")
  })

  it("rejects mixed singular and plural platform selectors", () => {
    const result = validateOutbox({
      dispatch: [
        {
          post: {
            platform: "x",
            platforms: ["bsky"],
            text: "ambiguous target",
          },
        },
      ],
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Action 0: post cannot have both 'platform' and 'platforms'")
  })

  it("accepts media alt text aligned with attached media", () => {
    const result = validateOutbox({
      dispatch: [
        {
          post: {
            platform: "bsky",
            text: "hello with media",
            media: ["/tmp/card.png"],
            mediaAlt: ["Card reading: hello with media"],
          },
        },
      ],
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("warns when media has no mediaAlt", () => {
    const result = validateOutbox({
      dispatch: [
        {
          thread: {
            platform: "bsky",
            posts: ["hello"],
            media: ["/tmp/card.png"],
          },
        },
      ],
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toContain("Action 0: thread has media but no mediaAlt; attached images will post without alt text")
  })

  it("rejects mediaAlt without media", () => {
    const result = validateOutbox({
      dispatch: [
        {
          reply: {
            platform: "bsky",
            id: "at://target",
            text: "hello",
            mediaAlt: ["orphan alt"],
          },
        },
      ],
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Action 0: reply 'mediaAlt' requires 'media'")
  })
})
