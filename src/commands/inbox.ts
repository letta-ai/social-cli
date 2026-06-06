/**
 * inbox: helpers for generated inbox surfaces that are not ordinary platform
 * notifications. `own-replies` scans recent account-owned posts and turns
 * external replies under those posts into normal inbox notifications.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse, stringify } from "yaml"
import { getPlatformAsync, availablePlatforms } from "../platforms/index.js"
import type { Notification, OwnPostReply } from "../platforms/types.js"
import { loadConfig } from "../config.js"
import {
  getPlatformFilePath,
  readPlatformFile,
  writePlatformFile,
} from "../lib/state.js"

interface InboxFile {
  notifications?: Notification[]
  _sync?: Record<string, unknown>
}

interface ProcessedFile {
  processed?: string[]
}

interface SentLedgerFile {
  entries?: Array<{
    notificationId?: string
    targetId?: string
    createdId?: string
  }>
}

export interface OwnRepliesInboxOpts {
  platforms?: string[]
  handle?: string
  limit?: number
  repliesLimit?: number
  depth?: number
  unhandled?: boolean
  write?: boolean
  quiet?: boolean
  stateDir?: string
}

export interface OwnRepliesPlatformResult {
  platform: string
  notifications: Notification[]
  added: number
  skippedProcessed: number
  alreadyInInbox: number
  inboxPath?: string
}

export interface OwnRepliesResult {
  results: OwnRepliesPlatformResult[]
  notifications: Notification[]
}

function readYamlFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

export function ownPostReplyToNotification(reply: OwnPostReply): Notification {
  return {
    id: reply.id,
    platform: reply.platform,
    type: "own_reply",
    author: reply.author,
    authorId: reply.authorId,
    postId: reply.id,
    text: reply.text,
    timestamp: reply.timestamp || new Date().toISOString(),
    threadContext: reply.threadContext?.map(({ author, text }) => ({ author, text })),
    embed: reply.embed,
    ownPostId: reply.ownPostId,
    ownPostText: reply.ownPostText,
    rootId: reply.rootId,
    parentId: reply.parentId,
    parentAuthor: reply.parentAuthor,
  }
}

function loadHandledIds(platform: string, stateDir?: string): Set<string> {
  const processedPath = getPlatformFilePath("processed", platform, stateDir)
  const sentLedgerPath = getPlatformFilePath("sent_ledger", platform, stateDir)
  const handled = new Set<string>()

  const processed = readYamlFile<ProcessedFile>(processedPath)
  for (const id of processed?.processed ?? []) handled.add(id)

  const ledger = readYamlFile<SentLedgerFile>(sentLedgerPath)
  for (const entry of ledger?.entries ?? []) {
    if (entry.notificationId) handled.add(entry.notificationId)
    if (entry.targetId) handled.add(entry.targetId)
    if (entry.createdId) handled.add(entry.createdId)
  }

  return handled
}

function notificationHandled(n: Notification, handled: Set<string>): boolean {
  return handled.has(n.id) || handled.has(n.postId)
}

function mergeInbox(
  platform: string,
  notifications: Notification[],
  stateDir?: string,
): { added: number; alreadyInInbox: number; inboxPath: string } {
  const inboxPath = getPlatformFilePath("inbox", platform, stateDir)
  const existing = readPlatformFile<InboxFile>("inbox", platform, stateDir) ?? {}
  const current = existing.notifications ?? []
  const seen = new Set<string>()
  for (const n of current) {
    seen.add(n.id)
    if (n.postId) seen.add(n.postId)
  }

  const additions = notifications.filter((n) => !seen.has(n.id) && !seen.has(n.postId))
  const now = new Date().toISOString()
  const nextNotifications = [...current, ...additions]

  writePlatformFile<InboxFile>("inbox", platform, {
    notifications: nextNotifications,
    _sync: {
      ...(existing._sync ?? {}),
      timestamp: now,
      platform,
      source: "own-replies",
      unreadOnly: false,
      newCount: additions.length,
      totalCount: nextNotifications.length,
    },
  }, stateDir)

  return {
    added: additions.length,
    alreadyInInbox: notifications.length - additions.length,
    inboxPath,
  }
}

export async function ownRepliesInbox(opts: OwnRepliesInboxOpts = {}): Promise<OwnRepliesResult> {
  const config = loadConfig()
  const platformIsolation = config.state?.platformIsolation ?? true
  const stateDir = opts.stateDir ?? config.state?.stateDir
  if (!platformIsolation && opts.write) {
    // The command can still emit YAML in legacy shared-state mode, but merging
    // cross-platform generated inboxes into one shared file is ambiguous.
    throw new Error("inbox own-replies --write requires platform-isolated state")
  }

  const platforms = opts.platforms?.length ? opts.platforms : availablePlatforms()
  const results: OwnRepliesPlatformResult[] = []
  const allNotifications: Notification[] = []

  for (const platformName of platforms) {
    const platform = await getPlatformAsync(platformName)
    if (!platform.ownPostReplies) {
      results.push({
        platform: platformName,
        notifications: [],
        added: 0,
        skippedProcessed: 0,
        alreadyInInbox: 0,
      })
      continue
    }

    const replies = await platform.ownPostReplies({
      handle: opts.handle,
      limit: opts.limit,
      repliesLimit: opts.repliesLimit,
      depth: opts.depth,
    })
    let notifications = replies.map(ownPostReplyToNotification)
    let skippedProcessed = 0

    if (opts.unhandled) {
      const handled = loadHandledIds(platformName, stateDir)
      const before = notifications.length
      notifications = notifications.filter((n) => !notificationHandled(n, handled))
      skippedProcessed = before - notifications.length
    }

    let added = 0
    let alreadyInInbox = 0
    let inboxPath: string | undefined
    if (opts.write) {
      const merged = mergeInbox(platformName, notifications, stateDir)
      added = merged.added
      alreadyInInbox = merged.alreadyInInbox
      inboxPath = merged.inboxPath
    }

    results.push({
      platform: platformName,
      notifications,
      added,
      skippedProcessed,
      alreadyInInbox,
      inboxPath,
    })
    allNotifications.push(...notifications)
  }

  return { results, notifications: allNotifications }
}

export async function ownRepliesInboxCommand(opts: OwnRepliesInboxOpts & { output?: string } = {}): Promise<void> {
  const result = await ownRepliesInbox(opts)

  if (opts.write) {
    const totalAdded = result.results.reduce((sum, item) => sum + item.added, 0)
    if (opts.quiet && totalAdded === 0) return
    process.stdout.write(stringify({ results: result.results.map((item) => ({
      platform: item.platform,
      count: item.notifications.length,
      added: item.added,
      alreadyInInbox: item.alreadyInInbox,
      skippedProcessed: item.skippedProcessed,
      inboxPath: item.inboxPath,
    })) }, { lineWidth: 120 }))
    return
  }

  if (opts.quiet && result.notifications.length === 0) return

  const yaml = stringify(result.notifications, { lineWidth: 120 })
  if (opts.output && opts.output !== "-") {
    const { writeFileAtomic } = await import("../util/fs.js")
    writeFileAtomic(resolve(process.cwd(), opts.output), yaml)
  } else {
    process.stdout.write(yaml)
  }
}
