/**
 * sync: Fetch notifications from all configured platforms → inbox.yaml
 */

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { stringify, parse } from "yaml"
import { getPlatformAsync, availablePlatforms } from "../platforms/index.js"
import type { Notification } from "../platforms/types.js"
import { writeFileAtomic } from "../util/fs.js"

interface InboxFile {
  notifications: Notification[]
  _sync: {
    timestamp: string
    platforms: string[]
    unreadOnly: boolean
    usersDir?: string
    usersMatched?: number
    newCount: number
    totalCount: number
    dropped?: number
    /** Per-platform cursors for incremental sync. */
    cursors?: Record<string, string>
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
  /** Clear cursors and re-fetch all notifications from scratch. */
  reset?: boolean
  /** Clear both cursors and the local inbox for a fully fresh start. */
  clear?: boolean
}): Promise<void> {
  const outputPath = resolve(process.cwd(), opts.output ?? "inbox.yaml")
  const targetPlatforms = opts.platforms ?? availablePlatforms()

  // --clear: wipe everything and start from scratch
  let existing: Notification[] = []
  const existingIds = new Set<string>()
  let cursors: Record<string, string> = {}

  if (!opts.clear && existsSync(outputPath)) {
    try {
      const raw = parse(readFileSync(outputPath, "utf-8")) as InboxFile
      // Load cursors only if not resetting
      if (!opts.reset && raw?._sync?.cursors) cursors = raw._sync.cursors
      // Load existing items only if not clearing
      existing = raw?.notifications ?? []
      for (const n of existing) existingIds.add(n.id)
    } catch {
      // Corrupt file, start fresh
    }
  }

  const allNotifs = [...existing]
  let newCount = 0

  for (const name of targetPlatforms) {
    try {
      const platform = await getPlatformAsync(name)
      // Fetch without passing a cursor — we filter by timestamp instead.
      // Disable unreadOnly on --clear so we get the full recent history as baseline.
      const result = await platform.notifications({
        limit: opts.limit ?? 50,
        unreadOnly: opts.clear ? false : (opts.unreadOnly ?? true),
      })

      const cutoff = cursors[name] ? new Date(cursors[name]).getTime() : 0

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
        cursors[name] = result.notifications[0].timestamp
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${name}] sync failed: ${msg}`)
      // Continue on failure
    }
  }

  // Cap inbox size to prevent unbounded growth
  const maxItems = opts.maxItems ?? 200
  const capped = allNotifs.slice(-maxItems)
  const dropped = allNotifs.length - capped.length

  // Enrich with user context if --users-dir provided
  let usersMatched = 0
  if (opts.usersDir) {
    const userIndex = buildUserIndex(opts.usersDir)
    for (const notif of capped as Array<Notification & { userContext?: string }>) {
      if (!notif.author) continue
      const filePath = lookupUser(notif.author, notif.authorId, notif.platform, userIndex)
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
      platforms: targetPlatforms,
      unreadOnly: opts.unreadOnly ?? true,
      newCount,
      totalCount: capped.length,
      cursors,
      ...(dropped > 0 ? { dropped } : {}),
      ...(opts.usersDir ? { usersDir: opts.usersDir, usersMatched } : {}),
    },
  }

  writeFileAtomic(outputPath, stringify(inbox, { lineWidth: 120 }))
  let msg = `Synced ${newCount} new notifications (${capped.length} pending total) → ${outputPath}`
  if (dropped > 0) msg += ` (${dropped} oldest dropped, cap: ${maxItems})`
  if (opts.usersDir) msg += ` (${usersMatched} users matched)`
  console.log(msg)
}
