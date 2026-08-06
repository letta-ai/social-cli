/**
 * Media download helpers shared between `sync --media` and the
 * `scripts/fetch-tweet-media.ts` standalone helper.
 *
 * Responsibilities:
 *  - Pick the best downloadable URL for a NotificationMedia item
 *  - Stream-download to disk with redirect + error handling
 *  - Determine the right file extension from Content-Type (with URL path
 *    and caller-supplied fallback as secondary sources)
 *  - Build collision-resistant filesystem paths for attachments
 *
 * All emitted `localPath` values are relative to the caller's current
 * working directory — the sync command runs from the repo root, so they
 * resolve naturally there. Consumers reading the inbox YAML must
 * interpret paths relative to that same directory.
 */

import { createWriteStream, unlink, mkdirSync } from "node:fs"
import { rename } from "node:fs/promises"
import { extname, join } from "node:path"
import type { IncomingMessage } from "node:http"
import { get as httpsGet } from "node:https"
import type { NotificationMedia } from "../platforms/types.js"

const MAX_REDIRECTS = 5

/** Content-type → file extension lookup for the formats we expect. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
}

/** HLS manifest content types — these are playlists, not media files, so skip. */
const HLS_CONTENT_TYPES = new Set([
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
])

export interface MediaUrlPick {
  url: string
  source: "original" | "variant" | "preview"
}

/**
 * Pick the best downloadable URL for a NotificationMedia item.
 * Prefers the original photo URL, then the highest-bitrate mp4 variant,
 * then any non-HLS variant, then the preview image.
 */
export function pickMediaUrl(media: NotificationMedia): MediaUrlPick | null {
  if (media.url) return { url: media.url, source: "original" }

  const mp4Variants = (media.variants ?? [])
    .filter((v) => v.url && v.contentType === "video/mp4")
    .sort((a, b) => (b.bitRate ?? 0) - (a.bitRate ?? 0))

  if (mp4Variants.length > 0) {
    return { url: mp4Variants[0].url as string, source: "variant" }
  }

  const binaryVariant = (media.variants ?? []).find(
    (v) => v.url && !isHlsContentType(v.contentType),
  )
  if (binaryVariant?.url) {
    return { url: binaryVariant.url, source: "variant" }
  }

  if (media.previewImageUrl) {
    return { url: media.previewImageUrl, source: "preview" }
  }

  return null
}

function isHlsContentType(ct?: string): boolean {
  if (!ct) return false
  return HLS_CONTENT_TYPES.has(ct.toLowerCase())
}

/**
 * Determine a file extension, preferring Content-Type, then the URL's path
 * extension, then the caller-supplied fallback.
 */
export function extensionForContentType(
  contentType: string | null | undefined,
  url: string,
  fallback = ".jpg",
): string {
  if (contentType) {
    const ct = contentType.split(";")[0].trim().toLowerCase()
    const mapped = CONTENT_TYPE_EXT[ct]
    if (mapped) return mapped
  }
  try {
    const ext = extname(new URL(url).pathname)
    if (ext) return ext.toLowerCase()
  } catch {
    // URL parse failed, fall through
  }
  return fallback
}

export interface DownloadResult {
  /** Raw Content-Type header (lower-cased, mime part only) from the final response. */
  contentType: string | null
}

export interface ImageInfo {
  width: number
  height: number
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

/**
 * Read image metadata from the file signature and header rather than its name.
 * Throws when the bytes are not a supported PNG, JPEG, GIF, or WebP image.
 */
export function getImageInfo(data: Buffer): ImageInfo {
  // PNG: signature followed by IHDR (width @ 16, height @ 20).
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    return checkedImageInfo(data.readUInt32BE(16), data.readUInt32BE(20), "image/png")
  }

  // JPEG: starts FFD8, then scan for any Start Of Frame marker.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset < data.length - 8) {
      if (data[offset] !== 0xff) {
        offset++
        continue
      }

      const marker = data[offset + 1]
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isStartOfFrame) {
        return checkedImageInfo(
          data.readUInt16BE(offset + 7),
          data.readUInt16BE(offset + 5),
          "image/jpeg",
        )
      }

      if (offset + 3 >= data.length) break
      const segmentLength = data.readUInt16BE(offset + 2)
      if (segmentLength < 2) break
      offset += 2 + segmentLength
    }
  }

  // GIF: logical screen width and height follow the six-byte signature.
  if (
    data.length >= 10 &&
    (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return checkedImageInfo(data.readUInt16LE(6), data.readUInt16LE(8), "image/gif")
  }

  // WebP: RIFF....WEBP followed by VP8X, VP8L, or VP8.
  if (
    data.length >= 30 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    const subtype = data.toString("ascii", 12, 16)
    if (subtype === "VP8X") {
      const width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
      const height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
      return checkedImageInfo(width, height, "image/webp")
    }
    if (subtype === "VP8L") {
      const b0 = data[21]
      const b1 = data[22]
      const b2 = data[23]
      const b3 = data[24]
      const width = (((b1 & 0x3f) << 8) | b0) + 1
      const height = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1
      return checkedImageInfo(width, height, "image/webp")
    }
    if (subtype === "VP8 ") {
      const width = data.readUInt16LE(26) & 0x3fff
      const height = data.readUInt16LE(28) & 0x3fff
      return checkedImageInfo(width, height, "image/webp")
    }
  }

  throw new Error("Unsupported image format (only PNG, JPEG, GIF, and WebP)")
}

function checkedImageInfo(width: number, height: number, mime: ImageInfo["mime"]): ImageInfo {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid ${mime} dimensions: ${width}x${height}`)
  }
  return { width, height, mime }
}

/**
 * Stream-download an HTTPS URL to disk, following redirects up to MAX_REDIRECTS.
 * Rejects on HTTP ≥ 400 or redirect loops. Cleans up the partial file on failure.
 */
export function downloadToFile(
  url: string,
  outPath: string,
  redirects = 0,
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(outPath)
    const request = httpsGet(url, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) {
          cleanupAndReject(file, outPath, new Error(`Too many redirects fetching ${url}`), reject)
          res.resume()
          return
        }
        const nextUrl = new URL(res.headers.location, url).toString()
        file.close(() => {
          unlink(outPath, () => {
            downloadToFile(nextUrl, outPath, redirects + 1).then(resolve, reject)
          })
        })
        res.resume()
        return
      }

      if (status >= 400) {
        cleanupAndReject(file, outPath, new Error(`Download failed: ${status} ${url}`), reject)
        res.resume()
        return
      }

      const rawCt = res.headers["content-type"]
      const contentType = typeof rawCt === "string" ? rawCt.split(";")[0].trim().toLowerCase() : null

      res.pipe(file)
      file.on("finish", () => file.close(() => resolve({ contentType })))
    })

    request.on("error", (err) => {
      unlink(outPath, () => reject(err))
    })

    file.on("error", (err) => {
      unlink(outPath, () => reject(err))
    })
  })
}

function cleanupAndReject(
  file: ReturnType<typeof createWriteStream>,
  outPath: string,
  err: Error,
  reject: (reason?: unknown) => void,
): void {
  file.close(() => {
    unlink(outPath, () => reject(err))
  })
}

/**
 * Download to `<stemPath>.tmp`, detect extension from Content-Type, then
 * atomically rename to `<stemPath><ext>`. Returns the final path on success.
 */
export async function downloadToFileWithExt(
  url: string,
  stemPath: string,
  fallbackExt = ".jpg",
): Promise<string> {
  const tmpPath = `${stemPath}.tmp`
  const { contentType } = await downloadToFile(url, tmpPath)
  const ext = extensionForContentType(contentType, url, fallbackExt)
  const finalPath = `${stemPath}${ext}`
  await rename(tmpPath, finalPath)
  return finalPath
}

/**
 * Make a filesystem-safe short identifier from a post ID or AT-URI.
 * Bluesky AT-URIs (`at://did:plc:.../app.bsky.feed.post/3kabc`) reduce to
 * their rkey. X post IDs are numeric strings passed through unchanged.
 */
export function sanitizeId(id: string): string {
  if (!id) return "unknown"
  if (id.startsWith("at://")) {
    const parts = id.split("/").filter(Boolean)
    const last = parts[parts.length - 1]
    if (last) return last
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/**
 * Derive a short collision-resistant prefix from an author identifier
 * (DID or numeric ID). The last 8 alphanumerics are enough to prevent
 * rkey-level collisions across different Bluesky authors in a single inbox.
 */
export function authorPrefix(authorId: string | undefined | null): string {
  if (!authorId) return "anon"
  const alnum = authorId.replace(/[^a-zA-Z0-9]/g, "")
  if (alnum.length === 0) return "anon"
  return alnum.slice(-8)
}

/** Recursively create a directory. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Build a filesystem stem (no extension) for an attachment. Includes an
 * author prefix so that same-rkey posts from different authors don't collide.
 */
export function attachmentStem(opts: {
  attachmentsDir: string
  platform: string
  authorId?: string | null
  postId: string
  suffix: string
}): string {
  const platformDir = join(opts.attachmentsDir, opts.platform)
  const author = authorPrefix(opts.authorId)
  const post = sanitizeId(opts.postId)
  return join(platformDir, `${author}_${post}_${opts.suffix}`)
}

/**
 * Normalize a raw media object from the X API v2 response shape
 * (snake_case) into the NotificationMedia shape used internally.
 * Used by both `src/platforms/x.ts` and `scripts/fetch-tweet-media.ts`.
 */
export function normalizeXMediaV2(raw: {
  media_key: string
  type: string
  url?: string
  preview_image_url?: string
  alt_text?: string
  width?: number
  height?: number
  variants?: { content_type?: string; url?: string; bit_rate?: number }[]
}): NotificationMedia {
  return {
    mediaKey: raw.media_key,
    type: raw.type,
    url: raw.url,
    previewImageUrl: raw.preview_image_url,
    altText: raw.alt_text,
    width: raw.width,
    height: raw.height,
    variants: raw.variants?.map((variant) => ({
      contentType: variant.content_type,
      url: variant.url,
      bitRate: variant.bit_rate,
    })),
  }
}
