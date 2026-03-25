/**
 * YAML round-trip test.
 * Ensures hostile content survives serialize → parse without corruption.
 */

import { describe, it, expect } from "vitest"
import { stringify, parse } from "yaml"

const HOSTILE_TEXTS = [
  "---",
  "key: value",
  "# this looks like a comment",
  "{json: true}",
  "[array, items]",
  "null",
  "true",
  "false",
  "123",
  "1.5e10",
  "!!str exploit",
  "text with\nnewlines\nand\ttabs",
  "colon: in middle",
  "trailing colon:",
  ": leading colon",
  "emoji 🎉 and unicode: café naïve résumé",
  'single "quotes" and \'apostrophes\'',
  "back\\slash",
  "pipe | character",
  "> folded indicator",
  "| literal indicator",
  "& anchor",
  "* alias",
  "% directive",
  "@ at sign",
  "` backtick",
  "",
  " leading space",
  "trailing space ",
  "multi\n---\ndocument\n...\nseparators",
]

describe("YAML round-trip", () => {
  it("preserves hostile text in a notifications array", () => {
    const notifications = HOSTILE_TEXTS.map((text, i) => ({
      id: `test-${i}`,
      platform: "bsky",
      type: "mention",
      author: "test.bsky.social",
      postId: `post-${i}`,
      text,
      timestamp: "2026-01-01T00:00:00Z",
    }))

    const serialized = stringify({ notifications }, { lineWidth: 120 })
    const parsed = parse(serialized) as { notifications: typeof notifications }

    expect(parsed.notifications).toHaveLength(notifications.length)

    for (let i = 0; i < notifications.length; i++) {
      expect(parsed.notifications[i].text).toBe(notifications[i].text)
      expect(parsed.notifications[i].id).toBe(notifications[i].id)
    }
  })

  it("preserves hostile text in dispatch actions", () => {
    const dispatch = HOSTILE_TEXTS.map((text) => ({
      post: { text, platforms: ["bsky"] },
    }))

    const serialized = stringify({ dispatch }, { lineWidth: 120 })
    const parsed = parse(serialized) as { dispatch: typeof dispatch }

    expect(parsed.dispatch).toHaveLength(dispatch.length)

    for (let i = 0; i < dispatch.length; i++) {
      expect(parsed.dispatch[i].post.text).toBe(dispatch[i].post.text)
    }
  })
})
