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
})
