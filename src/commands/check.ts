/**
 * check: Is there anything actionable?
 * Exit 0 = yes, exit 1 = no. No stdout.
 * Agents use exit code to decide whether to process.
 * 
 * With platform isolation, checks all platform-specific inbox files.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { loadConfig } from "../config.js"
import {
  getPlatformFilePath,
  getSharedFilePath,
  discoverPlatformFiles,
  sharedFileExists,
} from "../lib/state.js"

export async function check(opts: {
  threshold?: number
  /** Check a specific platform's inbox */
  platform?: string
}): Promise<void> {
  const threshold = opts.threshold ?? 1
  const config = loadConfig()
  const platformIsolation = config.state?.platformIsolation ?? true
  const stateDir = config.state?.stateDir

  if (opts.platform) {
    // Check a specific platform's inbox
    const inboxPath = platformIsolation
      ? getPlatformFilePath("inbox", opts.platform, stateDir)
      : getSharedFilePath("inbox", stateDir)

    if (!existsSync(inboxPath)) {
      process.exit(1)
    }

    try {
      const raw = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: any[] }
      const count = raw?.notifications?.length ?? 0
      process.exit(count >= threshold ? 0 : 1)
    } catch {
      process.exit(1)
    }
  }

  // Check all platform inboxes
  if (platformIsolation) {
    const platforms = discoverPlatformFiles("inbox", stateDir)
    
    if (platforms.length === 0) {
      // Fall back to legacy shared inbox
      if (sharedFileExists("inbox", stateDir)) {
        const inboxPath = getSharedFilePath("inbox", stateDir)
        try {
          const raw = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: any[] }
          const count = raw?.notifications?.length ?? 0
          process.exit(count >= threshold ? 0 : 1)
        } catch {
          process.exit(1)
        }
      }
      process.exit(1)
    }

    let totalCount = 0
    for (const platform of platforms) {
      const inboxPath = getPlatformFilePath("inbox", platform, stateDir)
      try {
        const raw = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: any[] }
        totalCount += raw?.notifications?.length ?? 0
      } catch {
        // Skip unreadable files
      }
    }

    process.exit(totalCount >= threshold ? 0 : 1)
  } else {
    // Legacy mode: check shared inbox
    const inboxPath = getSharedFilePath("inbox", stateDir)

    if (!existsSync(inboxPath)) {
      process.exit(1)
    }

    try {
      const raw = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: any[] }
      const count = raw?.notifications?.length ?? 0
      process.exit(count >= threshold ? 0 : 1)
    } catch {
      process.exit(1)
    }
  }
}
