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

import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, renameSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "../util/fs.js"

/** State file types that support platform isolation */
export type StateFileType = "inbox" | "outbox" | "sent_ledger" | "processed" | "dispatch_result"

/** Configuration for platform isolation */
export interface PlatformIsolationConfig {
  /** Enable platform-specific state files (default: true) */
  enabled: boolean
  /** Directory for state files (default: .social-cli/state under cwd) */
  stateDir?: string
}

/** Default directory for generated runtime state. */
export const DEFAULT_STATE_DIR = ".social-cli/state"

/**
 * Resolve the state directory for generated runtime files.
 *
 * Defaulting to an ignored subdirectory keeps sync/dispatch output out of the
 * repository root so agents do not accidentally stage inboxes, ledgers, or
 * dispatch results.
 */
function sanitizeStateSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "default"
}

export function defaultStateDir(): string {
  if (process.env.SOCIAL_CLI_STATE_DIR) return process.env.SOCIAL_CLI_STATE_DIR
  if (process.env.AGENT_ID) return join(DEFAULT_STATE_DIR, "agents", sanitizeStateSegment(process.env.AGENT_ID))
  return DEFAULT_STATE_DIR
}

export function resolveStateDir(stateDir?: string): string {
  return resolve(process.cwd(), stateDir ?? defaultStateDir())
}

function ensureStateDir(stateDir?: string): string {
  const baseDir = resolveStateDir(stateDir)
  mkdirSync(baseDir, { recursive: true })
  return baseDir
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
  const baseDir = ensureStateDir(stateDir)
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
  const baseDir = ensureStateDir(stateDir)
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
  const baseDir = resolveStateDir(stateDir)
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
 * Remove notifications from a platform's inbox by matching post IDs.
 *
 * Matches on both `id` and `postId` fields of each notification (mirrors how
 * dispatch prunes the inbox). Used by ad-hoc commands like `reply` that bypass
 * the dispatch pipeline but still respond to inbox items, so the inbox doesn't
 * keep showing those notifications as pending.
 *
 * Best-effort: silently returns [] if the inbox file is missing, malformed,
 * or cannot be written. Never throws.
 *
 * @returns the list of notification ids that were removed
 */
export function pruneInboxByPostId(
  platform: string,
  postIds: string[],
  stateDir?: string
): string[] {
  if (postIds.length === 0) return []

  const path = getPlatformFilePath("inbox", platform, stateDir)
  if (!existsSync(path)) return []

  try {
    const inbox = parse(readFileSync(path, "utf-8")) as {
      notifications?: Array<{ id: string; postId?: string }>
      _sync?: Record<string, unknown>
    }
    if (!inbox?.notifications?.length) return []

    const matchSet = new Set(postIds)
    const before = inbox.notifications
    const removed = before.filter(
      (n) => matchSet.has(n.id) || matchSet.has(n.postId ?? ""),
    )
    if (removed.length === 0) return []

    const remaining = before.filter(
      (n) => !matchSet.has(n.id) && !matchSet.has(n.postId ?? ""),
    )
    inbox.notifications = remaining
    if (inbox._sync) {
      inbox._sync = { ...inbox._sync, totalCount: remaining.length }
    }
    writeFileAtomic(path, stringify(inbox, { lineWidth: 120 }))
    return removed.map((n) => n.id)
  } catch {
    return []
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
  
  const baseDir = ensureStateDir(stateDir)
  const archiveDir = resolve(baseDir, "outbox_archive")
  mkdirSync(archiveDir, { recursive: true })
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const archivedPath = join(archiveDir, `${timestamp}_outbox-${platform}.yaml`)
  
  // Use renameSync equivalent via copy + delete would be ideal
  // but for simplicity, we'll copy and let the caller handle deletion
  copyFileSync(outboxPath, archivedPath)
  
  return archivedPath
}

const ROOT_RUNTIME_PATTERNS = [
  /^inbox(?:-[^.]+)?\.ya?ml$/,
  /^outbox(?:-[^.]+)?\.ya?ml$/,
  /^processed(?:-[^.]+)?\.ya?ml$/,
  /^sent_ledger(?:-[^.]+)?\.ya?ml$/,
  /^dispatch_result(?:-[^.]+)?\.ya?ml$/,
  /^feed\.ya?ml$/,
  /^[a-z]+_feed\.ya?ml$/,
  /^[a-z]+_inbox\.ya?ml$/,
]

/**
 * Find generated runtime files that still live in the repo root.
 * Useful for doctor-style warnings after the default state dir moved.
 */
export function findRootRuntimeFiles(cwd = process.cwd()): string[] {
  if (!existsSync(cwd)) return []
  return readdirSync(cwd)
    .filter((file) => ROOT_RUNTIME_PATTERNS.some((pattern) => pattern.test(file)))
    .sort()
}


export function rootRuntimeWarning(stateDir?: string): string | null {
  const files = findRootRuntimeFiles()
  if (files.length === 0) return null

  const preview = files.slice(0, 5).join(", ")
  const suffix = files.length > 5 ? `, and ${files.length - 5} more` : ""
  return `[warn] Found ${files.length} legacy runtime state file(s) in repo root (${preview}${suffix}). `
    + `Current stateDir is ${resolveStateDir(stateDir)}. `
    + "Run `social-cli doctor --migrate` to move generated state into the configured state directory."
}

export interface RuntimeFileMigration {
  from: string
  to: string
}

/**
 * Move legacy root-level runtime files into the configured state directory.
 *
 * Existing destination files are never overwritten; those source files remain
 * in place so the user can inspect/merge them manually.
 */
export function migrateRootRuntimeFiles(cwd = process.cwd(), stateDir?: string): RuntimeFileMigration[] {
  const targetDir = ensureStateDir(stateDir)
  const migrated: RuntimeFileMigration[] = []

  for (const file of findRootRuntimeFiles(cwd)) {
    const from = resolve(cwd, file)
    const to = resolve(targetDir, file)
    if (existsSync(to)) continue
    renameSync(from, to)
    migrated.push({ from, to })
  }

  return migrated
}
