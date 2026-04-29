/**
 * Tests for extractEmbed: normalizes Bluesky post embeds into EmbedInfo.
 *
 * Regression coverage for video embeds, which were silently dropped before
 * fix/bsky-video-embed. The previous behavior caused video posts to surface
 * as text-only in `posts`/`sync` output.
 */

import { describe, it, expect } from "vitest"
import { extractEmbed } from "./bluesky.js"

describe("extractEmbed", () => {
  it("returns undefined for missing or untyped input", () => {
    expect(extractEmbed(undefined)).toBeUndefined()
    expect(extractEmbed(null)).toBeUndefined()
    expect(extractEmbed({})).toBeUndefined()
    expect(extractEmbed({ images: [] })).toBeUndefined()
  })

  it("normalizes external link embeds", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.external#view",
      external: {
        uri: "https://example.com/article",
        title: "Article title",
        description: "Some description",
      },
    })
    expect(result).toEqual({
      type: "external",
      uri: "https://example.com/article",
      title: "Article title",
      description: "Some description",
    })
  })

  it("normalizes image embeds", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.images#view",
      images: [
        { alt: "alt 1", fullsize: "https://cdn.bsky.app/img/full/1", thumb: "https://cdn.bsky.app/img/thumb/1" },
        { alt: "", thumb: "https://cdn.bsky.app/img/thumb/2" },
      ],
    })
    expect(result).toEqual({
      type: "images",
      images: [
        { alt: "alt 1", url: "https://cdn.bsky.app/img/full/1" },
        { alt: "", url: "https://cdn.bsky.app/img/thumb/2" },
      ],
    })
  })

  it("normalizes record (quote) embeds", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.record#view",
      record: {
        uri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
        value: { text: "Quoted post text" },
        author: { handle: "alice.bsky.social" },
      },
    })
    expect(result).toEqual({
      type: "record",
      quotedUri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
      quotedText: "Quoted post text",
      quotedAuthor: "alice.bsky.social",
    })
  })

  it("normalizes video embeds", () => {
    // Real-world shape from Cameron's "Letta is not a memory layer" post.
    const result = extractEmbed({
      $type: "app.bsky.embed.video#view",
      cid: "bafkreidoq6kpvrhavckscpmjtmpwke6vklcbxis42a5xcaqj6afcn5ujhu",
      playlist:
        "https://video.bsky.app/watch/did%3Aplc%3Agfrmhdmjvxn2sjedzboeudef/bafkreidoq.../playlist.m3u8",
      thumbnail:
        "https://video.bsky.app/watch/did%3Aplc%3Agfrmhdmjvxn2sjedzboeudef/bafkreidoq.../thumbnail.jpg",
      alt: "",
      aspectRatio: { height: 1920, width: 1080 },
    })
    expect(result).toEqual({
      type: "video",
      playlist:
        "https://video.bsky.app/watch/did%3Aplc%3Agfrmhdmjvxn2sjedzboeudef/bafkreidoq.../playlist.m3u8",
      thumbnail:
        "https://video.bsky.app/watch/did%3Aplc%3Agfrmhdmjvxn2sjedzboeudef/bafkreidoq.../thumbnail.jpg",
      videoAlt: undefined,
      aspectRatio: { height: 1920, width: 1080 },
    })
  })

  it("preserves video alt text when present", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.video#view",
      playlist: "https://video.bsky.app/x/playlist.m3u8",
      thumbnail: "https://video.bsky.app/x/thumbnail.jpg",
      alt: "Cameron explaining Letta architecture",
      aspectRatio: { height: 1080, width: 1920 },
    })
    expect(result?.videoAlt).toBe("Cameron explaining Letta architecture")
  })

  it("normalizes recordWithMedia + images", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.recordWithMedia#view",
      record: {
        record: {
          uri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
          value: { text: "Quoted text" },
          author: { handle: "bob.bsky.social" },
        },
      },
      media: {
        $type: "app.bsky.embed.images#view",
        images: [{ alt: "image alt", fullsize: "https://cdn.bsky.app/img/full/1" }],
      },
    })
    expect(result).toEqual({
      type: "recordWithMedia",
      quotedUri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
      quotedText: "Quoted text",
      quotedAuthor: "bob.bsky.social",
      images: [{ alt: "image alt", url: "https://cdn.bsky.app/img/full/1" }],
    })
  })

  it("normalizes recordWithMedia + video", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.recordWithMedia#view",
      record: {
        record: {
          uri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
          value: { text: "Quoted text" },
          author: { handle: "carol.bsky.social" },
        },
      },
      media: {
        $type: "app.bsky.embed.video#view",
        playlist: "https://video.bsky.app/watch/x/playlist.m3u8",
        thumbnail: "https://video.bsky.app/watch/x/thumbnail.jpg",
        alt: "Caption",
        aspectRatio: { height: 1080, width: 1920 },
      },
    })
    expect(result).toEqual({
      type: "recordWithMedia",
      quotedUri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
      quotedText: "Quoted text",
      quotedAuthor: "carol.bsky.social",
      playlist: "https://video.bsky.app/watch/x/playlist.m3u8",
      thumbnail: "https://video.bsky.app/watch/x/thumbnail.jpg",
      videoAlt: "Caption",
      aspectRatio: { height: 1080, width: 1920 },
    })
  })

  it("normalizes recordWithMedia + external link", () => {
    const result = extractEmbed({
      $type: "app.bsky.embed.recordWithMedia#view",
      record: {
        record: {
          uri: "at://did:plc:xxx/app.bsky.feed.post/3kqr",
          value: { text: "Quoted text" },
          author: { handle: "dan.bsky.social" },
        },
      },
      media: {
        $type: "app.bsky.embed.external#view",
        external: {
          uri: "https://example.com/article",
          title: "Article",
          description: "Description",
        },
      },
    })
    expect(result?.uri).toBe("https://example.com/article")
    expect(result?.title).toBe("Article")
    expect(result?.quotedAuthor).toBe("dan.bsky.social")
  })

  it("returns undefined for unrecognized embed types", () => {
    expect(extractEmbed({ $type: "app.bsky.embed.something.unknown" })).toBeUndefined()
  })
})
