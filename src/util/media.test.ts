/**
 * Unit tests for media utility pure functions.
 * Covers URL selection, ID sanitization, and extension inference.
 */

import { describe, it, expect } from "vitest"
import {
  pickMediaUrl,
  sanitizeId,
  authorPrefix,
  extensionForContentType,
  attachmentStem,
  normalizeXMediaV2,
} from "./media.js"
import type { NotificationMedia } from "../platforms/types.js"

describe("pickMediaUrl", () => {
  it("returns the original URL for a photo", () => {
    const media: NotificationMedia = {
      mediaKey: "m1",
      type: "photo",
      url: "https://pbs.twimg.com/media/abc.jpg",
    }
    expect(pickMediaUrl(media)).toEqual({
      url: "https://pbs.twimg.com/media/abc.jpg",
      source: "original",
    })
  })

  it("picks the highest-bitrate mp4 variant for video", () => {
    const media: NotificationMedia = {
      mediaKey: "m2",
      type: "video",
      variants: [
        { contentType: "video/mp4", url: "https://lo.mp4", bitRate: 288000 },
        { contentType: "video/mp4", url: "https://hi.mp4", bitRate: 2176000 },
        { contentType: "video/mp4", url: "https://mid.mp4", bitRate: 832000 },
      ],
    }
    expect(pickMediaUrl(media)).toEqual({ url: "https://hi.mp4", source: "variant" })
  })

  it("skips HLS manifests when falling back to non-mp4 variants", () => {
    const media: NotificationMedia = {
      mediaKey: "m3",
      type: "video",
      variants: [
        { contentType: "application/x-mpegURL", url: "https://playlist.m3u8" },
      ],
      previewImageUrl: "https://preview.jpg",
    }
    // No mp4 and only HLS → skip variants, fall through to preview
    expect(pickMediaUrl(media)).toEqual({ url: "https://preview.jpg", source: "preview" })
  })

  it("matches HLS content types case-insensitively", () => {
    const media: NotificationMedia = {
      mediaKey: "m3b",
      type: "video",
      variants: [
        { contentType: "application/vnd.apple.mpegurl", url: "https://playlist.m3u8" },
      ],
    }
    expect(pickMediaUrl(media)).toBeNull()
  })

  it("falls back to a non-HLS variant when no mp4 is present", () => {
    const media: NotificationMedia = {
      mediaKey: "m4",
      type: "video",
      variants: [
        { contentType: "video/webm", url: "https://clip.webm" },
      ],
    }
    expect(pickMediaUrl(media)).toEqual({ url: "https://clip.webm", source: "variant" })
  })

  it("falls back to previewImageUrl when there is no url or variant", () => {
    const media: NotificationMedia = {
      mediaKey: "m5",
      type: "video",
      previewImageUrl: "https://preview.jpg",
    }
    expect(pickMediaUrl(media)).toEqual({ url: "https://preview.jpg", source: "preview" })
  })

  it("returns null when there is nothing downloadable", () => {
    const media: NotificationMedia = { mediaKey: "m6", type: "video" }
    expect(pickMediaUrl(media)).toBeNull()
  })
})

describe("sanitizeId", () => {
  it("extracts the rkey from a Bluesky AT-URI", () => {
    expect(sanitizeId("at://did:plc:abc123/app.bsky.feed.post/3kxyz")).toBe("3kxyz")
  })

  it("passes numeric X post IDs through unchanged", () => {
    expect(sanitizeId("2044477640585908255")).toBe("2044477640585908255")
  })

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeId("weird/id with:chars")).toBe("weird_id_with_chars")
  })

  it("returns `unknown` for empty input", () => {
    expect(sanitizeId("")).toBe("unknown")
  })

  it("handles malformed AT-URIs gracefully", () => {
    // `at://` split on `/` with Boolean filter leaves only the `at:` segment —
    // we return it rather than throwing. Not pretty but predictable.
    expect(sanitizeId("at://")).toBe("at:")
  })
})

describe("authorPrefix", () => {
  it("returns the last 8 alphanumerics of a DID", () => {
    expect(authorPrefix("did:plc:4j7exarb62djxycrgdfhuulr")).toBe("gdfhuulr")
  })

  it("returns the last 8 chars of an X numeric ID", () => {
    expect(authorPrefix("1232326955652931584")).toBe("52931584")
  })

  it("returns the whole identifier when it's shorter than 8 chars", () => {
    expect(authorPrefix("abc")).toBe("abc")
  })

  it("returns `anon` for undefined, null, or empty input", () => {
    expect(authorPrefix(undefined)).toBe("anon")
    expect(authorPrefix(null)).toBe("anon")
    expect(authorPrefix("")).toBe("anon")
  })

  it("returns `anon` when the ID has no alphanumerics", () => {
    expect(authorPrefix("---:::")).toBe("anon")
  })
})

describe("extensionForContentType", () => {
  it("prefers content-type when available", () => {
    expect(extensionForContentType("image/webp", "https://cdn.bsky.app/img/abc")).toBe(".webp")
    expect(extensionForContentType("image/png", "https://example.com/foo.jpg")).toBe(".png")
    expect(extensionForContentType("video/mp4", "https://example.com/clip")).toBe(".mp4")
  })

  it("strips content-type parameters", () => {
    expect(extensionForContentType("image/jpeg; charset=binary", "https://x.com/a")).toBe(".jpg")
  })

  it("handles case-insensitive content-types", () => {
    expect(extensionForContentType("IMAGE/PNG", "https://x.com/a")).toBe(".png")
  })

  it("falls back to URL path extension when content-type is unknown", () => {
    expect(extensionForContentType("application/octet-stream", "https://pbs.twimg.com/media/abc.png")).toBe(".png")
  })

  it("falls back to the provided default when URL has no extension", () => {
    expect(extensionForContentType(null, "https://cdn.bsky.app/img/abc")).toBe(".jpg")
    expect(extensionForContentType(null, "https://cdn.bsky.app/img/abc", ".bin")).toBe(".bin")
  })

  it("handles bad URLs without throwing", () => {
    expect(extensionForContentType(null, "not a url")).toBe(".jpg")
  })
})

describe("attachmentStem", () => {
  it("builds a platform-scoped path with author prefix + post id + suffix", () => {
    expect(
      attachmentStem({
        attachmentsDir: "attachments",
        platform: "bsky",
        authorId: "did:plc:4j7exarb62djxycrgdfhuulr",
        postId: "at://did:plc:xyz/app.bsky.feed.post/3kxyz",
        suffix: "0",
      }),
    ).toBe("attachments/bsky/gdfhuulr_3kxyz_0")
  })

  it("prevents collisions when two authors post with the same rkey", () => {
    const aliceStem = attachmentStem({
      attachmentsDir: "attachments",
      platform: "bsky",
      authorId: "did:plc:alice111aaaaaaaa",
      postId: "at://did:plc:alice/app.bsky.feed.post/3kabc",
      suffix: "0",
    })
    const bobStem = attachmentStem({
      attachmentsDir: "attachments",
      platform: "bsky",
      authorId: "did:plc:bob222bbbbbbbbb",
      postId: "at://did:plc:bob/app.bsky.feed.post/3kabc",
      suffix: "0",
    })
    expect(aliceStem).not.toBe(bobStem)
  })

  it("falls back to `anon` when author id is missing", () => {
    expect(
      attachmentStem({
        attachmentsDir: "attachments",
        platform: "x",
        authorId: undefined,
        postId: "2044477640585908255",
        suffix: "3_2044477638367186944",
      }),
    ).toBe("attachments/x/anon_2044477640585908255_3_2044477638367186944")
  })
})

describe("normalizeXMediaV2", () => {
  it("maps snake_case fields to camelCase NotificationMedia", () => {
    const raw = {
      media_key: "3_2044831075281821696",
      type: "video",
      preview_image_url: "https://pbs.twimg.com/thumb.jpg",
      width: 1224,
      height: 1080,
      variants: [
        { content_type: "video/mp4", url: "https://hi.mp4", bit_rate: 2176000 },
        { content_type: "application/x-mpegURL", url: "https://playlist.m3u8" },
      ],
    }
    expect(normalizeXMediaV2(raw)).toEqual({
      mediaKey: "3_2044831075281821696",
      type: "video",
      url: undefined,
      previewImageUrl: "https://pbs.twimg.com/thumb.jpg",
      altText: undefined,
      width: 1224,
      height: 1080,
      variants: [
        { contentType: "video/mp4", url: "https://hi.mp4", bitRate: 2176000 },
        { contentType: "application/x-mpegURL", url: "https://playlist.m3u8", bitRate: undefined },
      ],
    })
  })
})
