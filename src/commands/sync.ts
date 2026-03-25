/**
 * sync: Fetch notifications from all configured platforms → inbox.yaml
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { stringify, parse } from "yaml"
import { getPlatformAsync, availablePlatforms } from "../platforms/index.js"
import type { Notification } from "../platforms/types.js"
import { writeFileAtomic } from "../util/fs.js"

interface InboxFile {
  notifications: Notification[]
  _sync: {
    timestamp: string
    platforms: string[]
  }
}

export async function sync(opts: {
  platforms?: string[]
  unreadOnly?: boolean
  limit?: number
  output?: string
  maxItems?: number
}): Promise<void> {
  const outputPath = resolve(process.cwd(), opts.output ?? "inbox.yaml")
  const targetPlatforms = opts.platforms ?? availablePlatforms()

  // Load existing inbox to accumulate
  let existing: Notification[] = []
  const existingIds = new Set<string>()

  if (existsSync(outputPath)) {
    try {
      const raw = parse(readFileSync(outputPath, "utf-8")) as InboxFile
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
      const notifs = await platform.notifications({
        limit: opts.limit ?? 50,
        unreadOnly: opts.unreadOnly ?? true,
      })

      for (const n of notifs) {
        if (!existingIds.has(n.id)) {
          allNotifs.push(n)
          existingIds.add(n.id)
          newCount++
        }
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

  const inbox: InboxFile = {
    notifications: capped,
    _sync: {
      timestamp: new Date().toISOString(),
      platforms: targetPlatforms,
    },
  }

  writeFileAtomic(outputPath, stringify(inbox, { lineWidth: 120 }))
  let msg = `Synced ${newCount} new notifications (${capped.length} total) → ${outputPath}`
  if (dropped > 0) msg += ` (${dropped} oldest dropped, cap: ${maxItems})`
  console.log(msg)
}
