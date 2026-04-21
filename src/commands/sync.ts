/**
 * sync: Fetch notifications from all configured platforms → inbox-{platform}.yaml
 * 
 * With platform isolation enabled (default), each platform's notifications
 * are written to a separate inbox file (e.g., inbox-bsky.yaml, inbox-x.yaml).
 * This prevents accidental mixed-platform pending queues and ensures
 * replay protection operates unambiguously within platform partitions.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { stringify, parse } from "yaml"
import { getPlatformAsync, availablePlatforms } from "../platforms/index.js"
import { loadConfig } from "../config.js"
import type { Notification } from "../platforms/types.js"
import { writeFileAtomic } from "../util/fs.js"
import {
  attachmentStem,
  downloadToFileWithExt,
  ensureDir,
  pickMediaUrl,
} from "../util/media.js"
import {
  getPlatformFilePath,
  getSharedFilePath,
  platformFileExists,
  sharedFileExists,
  migrateSharedToPlatformSpecific,
  discoverPlatformFiles,
  readPlatformFile,
} from "../lib/state.js"

interface InboxFile {
  notifications: Notification[]
  _sync: {
    timestamp: string
    platform: string
    unreadOnly: boolean
    usersDir?: string
    usersMatched?: number
    usersCreated?: number
    newCount: number
    totalCount: number
    dropped?: number
    /** Per-platform cursor for incremental sync. */
    cursor?: string
    /** Count of media files downloaded during this sync (when --media). */
    attachmentsFetched?: number
  }
}

/**
 * Build a lookup map from a users directory.
 * Supports two layouts:
 *   users/{handle}.md              (flat, platform-agnostic)
 *   users/{platform}/{handle}.md   (nested, platform-specific)
 *
 * Returns a nested map: platform → handle → filepath
 * The "_flat" key holds platform-agnostic entries.
 */
function buildUserIndex(usersDir: string): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>()
  index.set("_flat", new Map())
  if (!existsSync(usersDir)) return index

  const entries = readdirSync(usersDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
      // Flat: users/cameron.md
      const name = entry.name.replace(/\.md$/, "").toLowerCase()
      index.get("_flat")!.set(name, join(usersDir, entry.name))
    } else if (entry.isDirectory() && !entry.name.startsWith("_")) {
      // Nested: users/bsky/*.md, users/x/*.md
      const platformDir = join(usersDir, entry.name)
      const platformMap = new Map<string, string>()
      const files = readdirSync(platformDir).filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      for (const file of files) {
        const name = file.replace(/\.md$/, "").toLowerCase()
        platformMap.set(name, join(platformDir, file))
      }
      index.set(entry.name.toLowerCase(), platformMap)
    }
  }
  return index
}

/** Platform name → directory name mapping. */
const PLATFORM_DIR_ALIASES: Record<string, string[]> = {
  bsky: ["bsky", "bluesky", "atproto"],
  x: ["x", "twitter"],
}

function primaryPlatformDir(platform: string): string {
  return (PLATFORM_DIR_ALIASES[platform] ?? [platform])[0]
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase()
}

function userFilePath(handle: string, platform: string, usersDir: string): string {
  return join(usersDir, primaryPlatformDir(platform), `${normalizeHandle(handle)}.md`)
}

function buildUserStub(handle: string, platform: string, timestamp?: string): string {
  const normalized = normalizeHandle(handle)
  const date = timestamp ? new Date(timestamp).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
  const platformLabel = platform === "x" ? "X" : platform.toUpperCase()

  return `---
description: User block for ${normalized} on ${platformLabel}
---
# User: @${normalized}

## Interaction History
- **${date}:** Profile initialized via automated sync discovery.
`
}

function autoCreateUserFile(handle: string, platform: string, usersDir: string, timestamp?: string): string | null {
  const normalized = normalizeHandle(handle)
  if (!normalized) return null

  const filePath = userFilePath(normalized, platform, usersDir)
  if (existsSync(filePath)) return filePath

  mkdirSync(join(usersDir, primaryPlatformDir(platform)), { recursive: true })
  writeFileSync(filePath, buildUserStub(normalized, platform, timestamp), "utf-8")
  return filePath
}

/**
 * Download attached media for a set of notifications into attachmentsDir.
 * Mutates notifications in place, setting localPath on each media/embed entry.
 * Returns the count of successfully downloaded files.
 */
async function fetchAttachments(
  notifications: Notification[],
  platformName: string,
  attachmentsDir: string,
): Promise<number> {
  let fetched = 0
  let dirEnsured = false

  const ensure = () => {
    if (!dirEnsured) {
      ensureDir(join(attachmentsDir, platformName))
      dirEnsured = true
    }
  }

  const relPath = (abs: string) => relative(process.cwd(), abs)

  for (const notif of notifications) {
    // X media
    if (notif.media && notif.media.length > 0) {
      for (const m of notif.media) {
        if (m.localPath) continue
        const pick = pickMediaUrl(m)
        if (!pick) continue

        const fallbackExt =
          m.type === "video" || m.type === "animated_gif" ? ".mp4" : ".jpg"
        const stem = attachmentStem({
          attachmentsDir,
          platform: platformName,
          authorId: notif.authorId,
          postId: notif.postId,
          suffix: m.mediaKey,
        })

        try {
          ensure()
          const finalPath = await downloadToFileWithExt(pick.url, stem, fallbackExt)
          m.localPath = relPath(finalPath)
          fetched++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[${platformName}] media fetch failed for ${notif.postId} (${m.mediaKey}): ${msg}`)
        }
      }
    }

    // Bluesky embed images (includes recordWithMedia which populates the same field)
    if (notif.embed?.images && notif.embed.images.length > 0) {
      for (let idx = 0; idx < notif.embed.images.length; idx++) {
        const img = notif.embed.images[idx]
        if (img.localPath || !img.url) continue

        const stem = attachmentStem({
          attachmentsDir,
          platform: platformName,
          authorId: notif.authorId,
          postId: notif.postId,
          suffix: String(idx),
        })

        try {
          ensure()
          const finalPath = await downloadToFileWithExt(img.url, stem, ".jpg")
          img.localPath = relPath(finalPath)
          fetched++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[${platformName}] media fetch failed for ${notif.postId} (image ${idx}): ${msg}`)
        }
      }
    }
  }

  return fetched
}

/** Exact lookup by a single key against platform-specific then flat dirs. */
function exactLookup(
  key: string,
  platform: string,
  index: Map<string, Map<string, string>>,
): string | null {
  const lower = key.toLowerCase()

  // Check platform-specific directories first
  const dirNames = PLATFORM_DIR_ALIASES[platform] ?? [platform]
  for (const dir of dirNames) {
    const platformMap = index.get(dir)
    if (platformMap?.has(lower)) return platformMap.get(lower)!
  }

  // Fall back to flat directory
  const flat = index.get("_flat")!
  if (flat.has(lower)) return flat.get(lower)!

  return null
}

/**
 * Try to find a user file for a notification author.
 * Tries permanent ID (DID/user ID) first, then handle.
 */
function lookupUser(
  handle: string,
  authorId: string | undefined,
  platform: string,
  index: Map<string, Map<string, string>>,
): string | null {
  // Permanent ID takes priority
  if (authorId) {
    const found = exactLookup(authorId, platform, index)
    if (found) return found
  }
  // Fall back to handle
  return exactLookup(handle, platform, index)
}

export async function sync(opts: {
  platforms?: string[]
  unreadOnly?: boolean
  limit?: number
  output?: string
  maxItems?: number
  usersDir?: string
  autoCreateUsers?: boolean
  /** Clear cursors and re-fetch all notifications from scratch. */
  reset?: boolean
  /** Clear both cursors and the local inbox for a fully fresh start. */
  clear?: boolean
  /** Download attached images/videos from notifications into attachments/{platform}/. */
  media?: boolean
  /** Override attachments root directory (default: ./attachments). */
  attachmentsDir?: string
}): Promise<void> {
  // Load config for allowedPlatforms and platform isolation
  const config = loadConfig()
  const allowedPlatforms = config.sync?.allowedPlatforms
  const platformIsolation = config.state?.platformIsolation ?? true
  const stateDir = config.state?.stateDir

  // Determine target platforms
  let targetPlatforms: string[]
  if (opts.platforms && opts.platforms.length > 0) {
    // Explicit --platform flags: use those
    targetPlatforms = opts.platforms
  } else if (allowedPlatforms && allowedPlatforms.length > 0) {
    // Config has allowedPlatforms: use those
    targetPlatforms = allowedPlatforms
  } else {
    // No explicit platforms and no config allowlist: fail closed
    console.error("Error: No platform scope specified.")
    console.error("Provide --platform <platform> or set sync.allowedPlatforms in config.yaml.")
    process.exit(1)
  }

  // Validate that requested platforms are in allowed set (if configured)
  if (allowedPlatforms && allowedPlatforms.length > 0) {
    const invalid = targetPlatforms.filter((p) => !allowedPlatforms.includes(p))
    if (invalid.length > 0) {
      console.error(`Error: Platform(s) not in allowed set: ${invalid.join(", ")}`)
      console.error(`Allowed platforms: ${allowedPlatforms.join(", ")}`)
      process.exit(1)
    }
  }

  // Check for legacy shared inbox and migrate if platform isolation is enabled
  if (platformIsolation && sharedFileExists("inbox", stateDir)) {
    // Check if any platform-specific files exist
    const existingPlatformFiles = discoverPlatformFiles("inbox", stateDir)
    if (existingPlatformFiles.length === 0) {
      // Migrate shared inbox to platform-specific files
      console.log("Migrating shared inbox.yaml to platform-specific files...")
      const migrated = migrateSharedToPlatformSpecific("inbox", targetPlatforms, stateDir)
      if (migrated.length > 0) {
        console.log(`Migrated notifications to: ${migrated.map(p => `inbox-${p}.yaml`).join(", ")}`)
      }
    }
  }

  // Sync each platform to its own inbox file
  let totalNewCount = 0
  let totalPendingCount = 0

  for (const platformName of targetPlatforms) {
    const inboxPath = platformIsolation
      ? getPlatformFilePath("inbox", platformName, stateDir)
      : opts.output
        ? resolve(process.cwd(), opts.output)
        : getSharedFilePath("inbox", stateDir)

    // Load existing state for this platform
    let existing: Notification[] = []
    const existingIds = new Set<string>()
    let cursor: string | undefined

    if (!opts.clear && existsSync(inboxPath)) {
      try {
        const raw = parse(readFileSync(inboxPath, "utf-8")) as InboxFile
        // Load cursor only if not resetting
        if (!opts.reset && raw?._sync?.cursor) cursor = raw._sync.cursor
        // Load existing items only if not clearing
        existing = raw?.notifications ?? []
        for (const n of existing) existingIds.add(n.id)
      } catch {
        // Corrupt file, start fresh
      }
    }

    const allNotifs = [...existing]
    let newCount = 0

    try {
      const platform = await getPlatformAsync(platformName)
      // Fetch without passing a cursor — we filter by timestamp instead.
      // Disable unreadOnly on --clear so we get the full recent history as baseline.
      const result = await platform.notifications({
        limit: opts.limit ?? 50,
        unreadOnly: opts.clear ? false : (opts.unreadOnly ?? true),
      })

      const cutoff = cursor ? new Date(cursor).getTime() : 0

      for (const n of result.notifications) {
        const itemTime = new Date(n.timestamp).getTime()
        // Skip items older than the cutoff
        if (cutoff > 0 && itemTime <= cutoff) continue
        if (!existingIds.has(n.id)) {
          allNotifs.push(n)
          existingIds.add(n.id)
          newCount++
        }
      }

      // Track the newest timestamp seen as the cursor for next sync.
      // result.notifications are sorted newest-first, so the first item is newest.
      if (result.notifications.length > 0) {
        cursor = result.notifications[0].timestamp
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${platformName}] sync failed: ${msg}`)
      // Continue on failure - write what we have
    }

    // Cap inbox size to prevent unbounded growth
    const maxItems = opts.maxItems ?? 200
    const capped = allNotifs.slice(-maxItems)
    const dropped = allNotifs.length - capped.length
    totalPendingCount += capped.length
    totalNewCount += newCount

    // Fetch media attachments if requested
    let attachmentsFetched = 0
    if (opts.media) {
      const attachmentsDir = opts.attachmentsDir
        ? resolve(process.cwd(), opts.attachmentsDir)
        : resolve(process.cwd(), "attachments")
      attachmentsFetched = await fetchAttachments(capped, platformName, attachmentsDir)
    }

    // Enrich with user context if --users-dir provided
    let usersMatched = 0
    let usersCreated = 0
    if (opts.usersDir) {
      const userIndex = buildUserIndex(opts.usersDir)
      for (const notif of capped as Array<Notification & { userContext?: string }>) {
        if (!notif.author) continue

        let filePath = lookupUser(notif.author, notif.authorId, notif.platform, userIndex)

        if (!filePath && opts.autoCreateUsers) {
          try {
            filePath = autoCreateUserFile(notif.author, notif.platform, opts.usersDir, notif.timestamp)
            if (filePath) {
              const dir = primaryPlatformDir(notif.platform)
              if (!userIndex.has(dir)) userIndex.set(dir, new Map())
              userIndex.get(dir)!.set(normalizeHandle(notif.author), filePath)
              usersCreated++
            }
          } catch {
            // Skip files that could not be created
          }
        }

        if (filePath) {
          try {
            notif.userContext = readFileSync(filePath, "utf-8")
            usersMatched++
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    const inbox: InboxFile = {
      notifications: capped,
      _sync: {
        timestamp: new Date().toISOString(),
        platform: platformName,
        unreadOnly: opts.unreadOnly ?? true,
        newCount,
        totalCount: capped.length,
        cursor,
        ...(dropped > 0 ? { dropped } : {}),
        ...(opts.usersDir ? { usersDir: opts.usersDir, usersMatched, ...(usersCreated > 0 ? { usersCreated } : {}) } : {}),
        ...(attachmentsFetched > 0 ? { attachmentsFetched } : {}),
      },
    }

    writeFileAtomic(inboxPath, stringify(inbox, { lineWidth: 120 }))
    
    let msg = `[${platformName}] Synced ${newCount} new notifications (${capped.length} pending total) → ${inboxPath}`
    if (dropped > 0) msg += ` (${dropped} oldest dropped, cap: ${maxItems})`
    if (opts.usersDir) {
      msg += ` (${usersMatched} users matched`
      if (usersCreated > 0) msg += `, ${usersCreated} created`
      msg += `)`
    }
    if (attachmentsFetched > 0) msg += ` (${attachmentsFetched} attachment${attachmentsFetched === 1 ? "" : "s"})`
    console.log(msg)
  }

  // Summary
  console.log(`\nTotal: ${totalNewCount} new notifications across ${targetPlatforms.length} platform(s)`)
}
