/**
 * Platform-specific state file management.
 * 
 * When platform isolation is enabled, state files are partitioned by platform:
 *   - inbox-{platform}.yaml (e.g., inbox-bsky.yaml, inbox-x.yaml)
 *   - outbox-{platform}.yaml (e.g., outbox-bsky.yaml, outbox-x.yaml)
 *   - sent_ledger-{platform}.yaml (e.g., sent_ledger-bsky.yaml, sent_ledger-x.yaml)
 * 
 * This prevents accidental mixed-platform pending queues and ensures
 * replay protection and pruning operate unambiguously within platform partitions.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs"
import { resolve, join, basename, dirname } from "node:path"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "../util/fs.js"

/** State file types that support platform isolation */
export type StateFileType = "inbox" | "outbox" | "sent_ledger" | "processed"

/** Configuration for platform isolation */
export interface PlatformIsolationConfig {
  /** Enable platform-specific state files (default: true) */
  enabled: boolean
  /** Directory for state files (default: cwd) */
  stateDir?: string
}

/**
 * Get the platform-specific file path for a state file.
 * 
 * Examples:
 *   - getPlatformFilePath("inbox", "bsky") → "inbox-bsky.yaml"
 *   - getPlatformFilePath("outbox", "x") → "outbox-x.yaml"
 *   - getPlatformFilePath("sent_ledger", "bsky") → "sent_ledger-bsky.yaml"
 */
export function getPlatformFilePath(
  fileType: StateFileType,
  platform: string,
  stateDir?: string
): string {
  const baseDir = stateDir ?? process.cwd()
  const filename = `${fileType}-${platform}.yaml`
  return resolve(baseDir, filename)
}

/**
 * Get the legacy shared file path for a state file.
 * Used for backward compatibility and migration.
 */
export function getSharedFilePath(
  fileType: StateFileType,
  stateDir?: string
): string {
  const baseDir = stateDir ?? process.cwd()
  return resolve(baseDir, `${fileType}.yaml`)
}

/**
 * Check if a platform-specific file exists.
 */
export function platformFileExists(
  fileType: StateFileType,
  platform: string,
  stateDir?: string
): boolean {
  const path = getPlatformFilePath(fileType, platform, stateDir)
  return existsSync(path)
}

/**
 * Check if a legacy shared file exists.
 */
export function sharedFileExists(
  fileType: StateFileType,
  stateDir?: string
): boolean {
  const path = getSharedFilePath(fileType, stateDir)
  return existsSync(path)
}

/**
 * Migrate a shared file to platform-specific files.
 * 
 * For inbox: splits notifications by platform into separate files
 * For outbox: copies to all configured platforms (each outbox is independent)
 * For sent_ledger: splits entries by platform into separate files
 * 
 * Returns the list of platforms that were migrated.
 */
export function migrateSharedToPlatformSpecific(
  fileType: StateFileType,
  platforms: string[],
  stateDir?: string
): string[] {
  const sharedPath = getSharedFilePath(fileType, stateDir)
  if (!existsSync(sharedPath)) {
    return []
  }

  const raw = parse(readFileSync(sharedPath, "utf-8"))
  const migrated: string[] = []

  if (fileType === "inbox") {
    // Split notifications by platform
    const notifications = raw?.notifications ?? []
    const syncMeta = raw?._sync ?? {}
    
    for (const platform of platforms) {
      const platformNotifs = notifications.filter(
        (n: any) => n.platform === platform
      )
      
      if (platformNotifs.length > 0 || syncMeta.cursors?.[platform]) {
        const platformPath = getPlatformFilePath(fileType, platform, stateDir)
        const platformData = {
          notifications: platformNotifs,
          _sync: {
            timestamp: syncMeta.timestamp ?? new Date().toISOString(),
            platform,
            unreadOnly: syncMeta.unreadOnly ?? true,
            newCount: 0,
            totalCount: platformNotifs.length,
            cursors: syncMeta.cursors?.[platform] 
              ? { [platform]: syncMeta.cursors[platform] }
              : {},
          },
        }
        
        writeFileAtomic(platformPath, stringify(platformData, { lineWidth: 120 }))
        migrated.push(platform)
      }
    }
  } else if (fileType === "sent_ledger") {
    // Split ledger entries by platform
    const entries = raw?.entries ?? []
    
    for (const platform of platforms) {
      const platformEntries = entries.filter(
        (e: any) => e.platform === platform
      )
      
      if (platformEntries.length > 0) {
        const platformPath = getPlatformFilePath(fileType, platform, stateDir)
        writeFileAtomic(platformPath, stringify({ entries: platformEntries }, { lineWidth: 120 }))
        migrated.push(platform)
      }
    }
  } else if (fileType === "outbox") {
    // Outbox is trickier - each platform's outbox is independent
    // We don't auto-migrate outbox as it's user-created
    // Just note that migration is needed
  }

  return migrated
}

/**
 * Discover all platform-specific files of a given type.
 * Returns the list of platforms that have files.
 */
export function discoverPlatformFiles(
  fileType: StateFileType,
  stateDir?: string
): string[] {
  const baseDir = stateDir ?? process.cwd()
  const platforms: string[] = []
  
  if (!existsSync(baseDir)) return platforms
  
  const files = readdirSync(baseDir)
  const prefix = `${fileType}-`
  const suffix = ".yaml"
  
  for (const file of files) {
    if (file.startsWith(prefix) && file.endsWith(suffix)) {
      const platform = file.slice(prefix.length, -suffix.length)
      platforms.push(platform)
    }
  }
  
  return platforms.sort()
}

/**
 * Read a platform-specific state file.
 */
export function readPlatformFile<T = any>(
  fileType: StateFileType,
  platform: string,
  stateDir?: string
): T | null {
  const path = getPlatformFilePath(fileType, platform, stateDir)
  if (!existsSync(path)) return null
  
  try {
    return parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

/**
 * Write a platform-specific state file.
 */
export function writePlatformFile<T = any>(
  fileType: StateFileType,
  platform: string,
  data: T,
  stateDir?: string
): void {
  const path = getPlatformFilePath(fileType, platform, stateDir)
  writeFileAtomic(path, stringify(data, { lineWidth: 120 }))
}

/**
 * Read a legacy shared state file.
 */
export function readSharedFile<T = any>(
  fileType: StateFileType,
  stateDir?: string
): T | null {
  const path = getSharedFilePath(fileType, stateDir)
  if (!existsSync(path)) return null
  
  try {
    return parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

/**
 * Archive a platform-specific outbox file after dispatch.
 */
export function archivePlatformOutbox(
  platform: string,
  stateDir?: string
): string | null {
  const outboxPath = getPlatformFilePath("outbox", platform, stateDir)
  if (!existsSync(outboxPath)) return null
  
  const baseDir = stateDir ?? process.cwd()
  const archiveDir = resolve(baseDir, "outbox_archive")
  mkdirSync(archiveDir, { recursive: true })
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const archivedPath = join(archiveDir, `${timestamp}_outbox-${platform}.yaml`)
  
  // Use renameSync equivalent via copy + delete would be ideal
  // but for simplicity, we'll copy and let the caller handle deletion
  copyFileSync(outboxPath, archivedPath)
  
  return archivedPath
}
