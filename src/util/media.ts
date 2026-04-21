/**
 * Media download helpers — shared between sync --media and the
 * standalone scripts/fetch-tweet-media.cjs helper.
 *
 * Handles HTTPS redirects, variant selection for X video, and
 * filesystem-safe path construction for AT-URIs.
 */

import { createWriteStream, unlink, mkdirSync } from "node:fs"
import { extname, join } from "node:path"
import { get as httpsGet } from "node:https"
import type { NotificationMedia } from "../platforms/types.js"

const MAX_REDIRECTS = 5

export interface MediaUrlPick {
  url: string
  source: "original" | "variant" | "preview"
}

/**
 * Pick the best URL for a NotificationMedia item.
 * Prefers the original photo URL, falls back to highest-bitrate mp4 for video,
 * then first variant, then the preview image.
 */
export function pickMediaUrl(media: NotificationMedia): MediaUrlPick | null {
  if (media.url) {
    return { url: media.url, source: "original" }
  }

  const mp4Variants = (media.variants ?? [])
    .filter((variant) => variant.url && variant.contentType === "video/mp4")
    .sort((a, b) => (b.bitRate ?? 0) - (a.bitRate ?? 0))

  if (mp4Variants.length > 0 && mp4Variants[0].url) {
    return { url: mp4Variants[0].url, source: "variant" }
  }

  const firstVariant = (media.variants ?? []).find((variant) => variant.url)
  if (firstVariant?.url) {
    return { url: firstVariant.url, source: "variant" }
  }

  if (media.previewImageUrl) {
    return { url: media.previewImageUrl, source: "preview" }
  }

  return null
}

/**
 * Download a URL to disk, following HTTPS redirects up to MAX_REDIRECTS.
 * Rejects on HTTP >= 400 or redirect loops.
 */
export function downloadMedia(url: string, outPath: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(outPath)
    const request = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`Too many redirects fetching ${url}`))
          return
        }
        const nextUrl = new URL(res.headers.location, url).toString()
        file.close(() => {
          unlink(outPath, () => {
            downloadMedia(nextUrl, outPath, redirects + 1).then(resolve, reject)
          })
        })
        res.resume()
        return
      }

      if (status >= 400) {
        file.close(() => {
          unlink(outPath, () => {
            reject(new Error(`Download failed: ${status} ${url}`))
          })
        })
        res.resume()
        return
      }

      res.pipe(file)
      file.on("finish", () => file.close(() => resolve()))
    })

    request.on("error", (err) => {
      unlink(outPath, () => reject(err))
    })

    file.on("error", (err) => {
      unlink(outPath, () => reject(err))
    })
  })
}

/**
 * Extract a filesystem-safe identifier from a post ID or AT-URI.
 * Bluesky AT-URIs look like `at://did:plc:abc/app.bsky.feed.post/3kxyz` —
 * we take the last segment (rkey) when available.
 * X post IDs are already numeric strings.
 */
export function sanitizePostId(postId: string): string {
  if (!postId) return "unknown"
  if (postId.startsWith("at://")) {
    const parts = postId.split("/").filter(Boolean)
    const last = parts[parts.length - 1]
    if (last) return last
  }
  return postId.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Infer file extension for a URL. Falls back to a sensible default for
 * Bluesky CDN URLs that lack extensions entirely.
 */
export function inferExtension(url: string, fallback = ".jpg"): string {
  try {
    const pathname = new URL(url).pathname
    const ext = extname(pathname)
    if (ext) return ext
  } catch {
    // URL parse failed, use fallback
  }
  return fallback
}

/** Ensure a directory exists (recursive mkdir). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Build a filesystem path for a downloaded attachment. */
export function attachmentPath(opts: {
  attachmentsDir: string
  platform: string
  postId: string
  suffix: string
  url: string
  fallbackExt?: string
}): string {
  const platformDir = join(opts.attachmentsDir, opts.platform)
  const sanitized = sanitizePostId(opts.postId)
  const ext = inferExtension(opts.url, opts.fallbackExt ?? ".jpg")
  return join(platformDir, `${sanitized}_${opts.suffix}${ext}`)
}
