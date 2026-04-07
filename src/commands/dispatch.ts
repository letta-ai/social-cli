/**
 * dispatch: Read outbox YAML, post to platforms, write results.
 * Continue on failure — report per-action results.
 */

import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { parse, stringify } from "yaml"
import { getPlatformAsync } from "../platforms/index.js"
import { loadConfig } from "../config.js"
import { validateOutbox, type OutboxFile, type OutboxAction } from "./validate.js"
import { writeFileAtomic } from "../util/fs.js"

/**
 * Provenance information for a dispatch run.
 * Tracks the source and context of the dispatch operation.
 */
export interface ProvenanceInfo {
  /** Agent ID from config or SOCIAL_CLI_AGENT_ID env var */
  agentId?: string
  /** Current working directory where dispatch was invoked */
  cwd: string
  /** Scheduler job ID or automation source when available */
  schedulerJobId?: string
  /** Resolved platform scope from config */
  platformScope?: string[]
  /** Path to the outbox file being dispatched */
  outboxPath: string
  /** Path to the inbox file if relevant */
  inboxPath?: string
  /** Timestamp when the dispatch run started */
  dispatchTimestamp: string
  /** Whether this was a dry run (validation only) */
  dryRun: boolean
}

interface DispatchResult {
  action: string
  platform: string
  status: "ok" | "error"
  id?: string
  targetId?: string
  inboxIdsRemoved?: string[]
  archivedOutbox?: string
  error?: string
  /** Provenance information for this dispatch result */
  provenance?: ProvenanceInfo
}

interface SentLedgerEntry {
  key: string
  action: string
  platform: string
  targetId?: string
  notificationId?: string
  textHash?: string
  createdId?: string
  timestamp: string
  // Provenance fields
  /** Agent ID from config or SOCIAL_CLI_AGENT_ID env var */
  agentId?: string
  /** Current working directory where dispatch was invoked */
  cwd?: string
  /** Scheduler job ID or automation source when available */
  schedulerJobId?: string
  /** Resolved platform scope from config */
  platformScope?: string[]
  /** Path to the outbox file being dispatched */
  outboxPath?: string
  /** Path to the inbox file if relevant */
  inboxPath?: string
  /** Timestamp when the dispatch run started */
  dispatchTimestamp?: string
  /** Whether this was a dry run (validation only) */
  dryRun?: boolean
}

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex")
}

function replyKey(platform: string, targetId: string, text: string, idempotencyKey?: string): string {
  return idempotencyKey ?? `reply:${platform}:${targetId}:${hashText(text)}`
}

function replyTargetKey(platform: string, targetId: string): string {
  return `reply-target:${platform}:${targetId}`
}

function postKey(platform: string, text: string, idempotencyKey?: string): string {
  return idempotencyKey ?? `post:${platform}:${hashText(text)}`
}

function threadKey(platform: string, posts: string[], idempotencyKey?: string): string {
  return idempotencyKey ?? `thread:${platform}:${hashText(posts.join("\n\n"))}`
}

/**
 * Build provenance info for the current dispatch run.
 * Gets agent ID from env var (SOCIAL_CLI_AGENT_ID) or config.
 */
function buildProvenanceInfo(opts: {
  filePath: string
  inboxPath?: string
  platformScope?: string[]
  dryRun: boolean
  schedulerJobId?: string
}): ProvenanceInfo {
  const agentId = process.env.SOCIAL_CLI_AGENT_ID
  return {
    agentId,
    cwd: process.cwd(),
    schedulerJobId: opts.schedulerJobId,
    platformScope: opts.platformScope,
    outboxPath: opts.filePath,
    inboxPath: opts.inboxPath,
    dispatchTimestamp: new Date().toISOString(),
    dryRun: opts.dryRun,
  }
}

export async function dispatch(opts: {
  file?: string
  dryRun?: boolean
  /** Optional scheduler job ID or automation source for provenance tracking */
  schedulerJobId?: string
}): Promise<void> {
  const filePath = resolve(process.cwd(), opts.file ?? "outbox.yaml")
  const dispatchTimestamp = new Date().toISOString()

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  let outbox: OutboxFile
  try {
    outbox = parse(readFileSync(filePath, "utf-8")) as OutboxFile
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // Validate
  const validation = validateOutbox(outbox)
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.error(`Warning: ${w}`)
  }
  if (!validation.valid) {
    for (const e of validation.errors) console.error(`Error: ${e}`)
    console.error(`Validation failed: ${validation.errors.length} error(s)`)
    process.exit(1)
  }

  // Load config for dispatch allowedPlatforms
  const config = loadConfig()
  const allowedPlatforms = config.dispatch?.allowedPlatforms
  const inboxPath = resolve(process.cwd(), "inbox.yaml")

  // Build provenance info for this dispatch run
  const provenance = buildProvenanceInfo({
    filePath,
    inboxPath: existsSync(inboxPath) ? inboxPath : undefined,
    platformScope: allowedPlatforms,
    dryRun: opts.dryRun ?? false,
    schedulerJobId: opts.schedulerJobId,
  })

  // Validate platform scope for each action
  if (allowedPlatforms && allowedPlatforms.length > 0) {
    for (const action of outbox.dispatch) {
      let platform: string | undefined
      if (action.reply) platform = action.reply.platform
      else if (action.thread) platform = action.thread.platform
      else if (action.annotate) platform = action.annotate.platform
      else if (action.follow) platform = action.follow.platform
      else if (action.like) platform = action.like.platform
      else if (action.post?.platforms) {
        const platforms = action.post.platforms
        platform = Array.isArray(platforms) ? platforms[0] : Object.keys(platforms)[0]
      }

      if (platform && !allowedPlatforms.includes(platform)) {
        console.error(`Error: Platform "${platform}" not in dispatch allowed set.`)
        console.error(`Allowed platforms: ${allowedPlatforms.join(", ")}`)
        process.exit(1)
      }
    }
  }


  // Load sent ledger for replay protection
  const sentLedgerPath = resolve(process.cwd(), "sent_ledger.yaml")
  let sentLedger: SentLedgerEntry[] = []
  let sentKeys = new Set<string>()
  let sentReplyTargets = new Set<string>()
  if (existsSync(sentLedgerPath)) {
    try {
      const sentData = parse(readFileSync(sentLedgerPath, "utf-8")) as { entries?: SentLedgerEntry[] }
      sentLedger = sentData?.entries ?? []
      sentKeys = new Set(sentLedger.map((entry) => entry.key))
      sentReplyTargets = new Set(
        sentLedger
          .filter((entry) => entry.action === "reply" && entry.targetId)
          .map((entry) => replyTargetKey(entry.platform, entry.targetId!)),
      )
    } catch {
      // Best effort only
    }
  }

  // Pre-dispatch deduplication, replay protection, and malformed-thread validation
  const preflightErrors: string[] = []
  const seenTargets = new Set<string>()

  for (let i = 0; i < outbox.dispatch.length; i++) {
    const action = outbox.dispatch[i]

    // Check for duplicate targets
    if (action.reply) {
      const targetKey = `reply:${action.reply.platform}:${action.reply.id}`
      if (seenTargets.has(targetKey)) {
        preflightErrors.push(`Duplicate reply target: ${action.reply.id}`)
      }
      seenTargets.add(targetKey)
    }

    if (action.follow) {
      const targetKey = `follow:${action.follow.platform}:${action.follow.handle}`
      if (seenTargets.has(targetKey)) {
        preflightErrors.push(`Duplicate follow target: ${action.follow.handle}`)
      }
      seenTargets.add(targetKey)
    }

    if (action.reply) {
      const targetKey = replyTargetKey(action.reply.platform, action.reply.id)
      if (sentReplyTargets.has(targetKey)) {
        preflightErrors.push(`Replay detected for reply target: ${action.reply.id}`)
      }
    }

    if (action.post) {
      if (action.post.text) {
        const platforms = Array.isArray(action.post.platforms)
          ? action.post.platforms
          : action.post.platforms && typeof action.post.platforms === "object"
            ? Object.keys(action.post.platforms)
            : ["bsky"]
        for (const platform of platforms) {
          const key = postKey(platform, action.post.text, action.post.idempotencyKey)
          if (sentKeys.has(key)) {
            preflightErrors.push(`Replay detected for post on ${platform}`)
          }
        }
      }
      if (action.post.platforms && typeof action.post.platforms === "object" && !Array.isArray(action.post.platforms)) {
        for (const [platform, text] of Object.entries(action.post.platforms)) {
          const key = postKey(platform, text, action.post.idempotencyKey)
          if (sentKeys.has(key)) {
            preflightErrors.push(`Replay detected for post on ${platform}`)
          }
        }
      }
    }

    // Check for malformed thread roots
    if (action.thread) {
      if (!action.thread.posts || action.thread.posts.length === 0) {
        preflightErrors.push(`Thread has no posts`)
      } else if (!action.thread.posts[0] || action.thread.posts[0].trim() === "") {
        preflightErrors.push(`Thread root has empty payload`)
      }

      const key = threadKey(action.thread.platform, action.thread.posts, action.thread.idempotencyKey)
      if (sentKeys.has(key)) {
        preflightErrors.push(`Replay detected for thread on ${action.thread.platform}`)
      }
    }
  }

  if (preflightErrors.length > 0) {
    for (const e of preflightErrors) console.error(`Preflight error: ${e}`)
    console.error(`Preflight validation failed: ${preflightErrors.length} error(s)`)
    process.exit(1)
  }

  if (opts.dryRun) {
    console.log("Dry run: validation passed.")
    process.exit(0)
  }

  // Load inbox for validation and later pruning
  // Note: inboxPath is already defined above for provenance
  let inboxNotifications: Array<{ id: string; postId?: string }> = []
  if (existsSync(inboxPath)) {
    try {
      const inbox = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: Array<{ id: string; postId?: string }> }
      inboxNotifications = inbox?.notifications ?? []
    } catch {
      // Best effort only
    }
  }

  // Load persistent processed state
  const processedPath = resolve(process.cwd(), "processed.yaml")
  let persistentProcessed: Set<string> = new Set()
  if (existsSync(processedPath)) {
    try {
      const processedData = parse(readFileSync(processedPath, "utf-8")) as { processed?: string[] }
      if (processedData?.processed) {
        persistentProcessed = new Set(processedData.processed)
      }
    } catch {
      // Best effort only
    }
  }

  // Merge persistent + outbox-provided processed IDs
  const allProcessed: Set<string> = new Set(persistentProcessed)
  if (outbox.processed) {
    for (const id of outbox.processed) allProcessed.add(id)
  }

  // Filter inbox: remove everything in the processed set before dispatch
  if (allProcessed.size > 0 && inboxNotifications.length > 0) {
    const before = inboxNotifications.length
    inboxNotifications = inboxNotifications.filter(
      (n) => !allProcessed.has(n.id) && !allProcessed.has(n.postId ?? ""),
    )
    const filtered = before - inboxNotifications.length
    if (filtered > 0) {
      console.log(`Filtered ${filtered} previously-processed notification(s) from inbox`)
    }
  }

  // Dispatch
  const results: DispatchResult[] = []
  const processedNotifIds: string[] = []
  const sentEntriesToAppend: SentLedgerEntry[] = []
  let successfulReplyCount = 0

  const getLedgerProcessedIds = (): string[] =>
    sentEntriesToAppend
      .map((entry) => entry.notificationId)
      .filter((id): id is string => Boolean(id))

  for (let i = 0; i < outbox.dispatch.length; i++) {
    const action = outbox.dispatch[i]

    if (action.ignore) {
      processedNotifIds.push(action.ignore.id)
      console.log(`Ignoring ${action.ignore.id} (${action.ignore.reason ?? "unspecified"})`)
      continue
    }

    if (action.reply) {
      const r = action.reply
      try {
        const platform = await getPlatformAsync(r.platform)
        const res = await platform.reply(r.id, r.text)
        results.push({ action: "reply", platform: r.platform, status: "ok", id: res.id, targetId: r.id })
        successfulReplyCount += 1

        const replyLedgerKey = replyKey(r.platform, r.id, r.text, r.idempotencyKey)
        sentEntriesToAppend.push({
          key: replyLedgerKey,
          action: "reply",
          platform: r.platform,
          targetId: r.id,
          notificationId: r.notificationId,
          textHash: hashText(r.text),
          createdId: res.id,
          timestamp: new Date().toISOString(),
          // Provenance fields
          agentId: provenance.agentId,
          cwd: provenance.cwd,
          schedulerJobId: provenance.schedulerJobId,
          platformScope: provenance.platformScope,
          outboxPath: provenance.outboxPath,
          inboxPath: provenance.inboxPath,
          dispatchTimestamp: provenance.dispatchTimestamp,
          dryRun: provenance.dryRun,
        })

        // Prune both the explicit notification id and inbox matches by target alias
        if (r.notificationId) processedNotifIds.push(r.notificationId)
        const matchedNotifications = inboxNotifications.filter((n) => n.id === r.id || n.postId === r.id || n.id === r.notificationId)
        for (const n of matchedNotifications) {
          processedNotifIds.push(n.id)
          if (n.postId) processedNotifIds.push(n.postId)
        }
        console.log(`Replied on ${r.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "reply", platform: r.platform, status: "error", targetId: r.id, error: msg })
        console.error(`Reply failed on ${r.platform}: ${msg}`)
      }
    }

    if (action.post) {
      const p = action.post
      // Determine platforms and text
      const targets: { platform: string; text: string }[] = []

      if (p.platforms && typeof p.platforms === "object" && !Array.isArray(p.platforms)) {
        // Per-platform text
        for (const [plat, text] of Object.entries(p.platforms)) {
          targets.push({ platform: plat, text })
        }
      } else if (p.text && p.platforms && Array.isArray(p.platforms)) {
        // Same text, multiple platforms
        for (const plat of p.platforms) {
          targets.push({ platform: plat, text: p.text })
        }
      } else if (p.text) {
        // Single platform not specified — default to bsky
        targets.push({ platform: "bsky", text: p.text })
      }

      for (const t of targets) {
        try {
          const platform = await getPlatformAsync(t.platform)
          const res = await platform.post(t.text)
          results.push({ action: "post", platform: t.platform, status: "ok", id: res.id })
          sentEntriesToAppend.push({
            key: postKey(t.platform, t.text, p.idempotencyKey),
            action: "post",
            platform: t.platform,
            textHash: hashText(t.text),
            createdId: res.id,
            timestamp: new Date().toISOString(),
            // Provenance fields
            agentId: provenance.agentId,
            cwd: provenance.cwd,
            schedulerJobId: provenance.schedulerJobId,
            platformScope: provenance.platformScope,
            outboxPath: provenance.outboxPath,
            inboxPath: provenance.inboxPath,
            dispatchTimestamp: provenance.dispatchTimestamp,
            dryRun: provenance.dryRun,
          })
          console.log(`Posted on ${t.platform}: ${res.id}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          results.push({ action: "post", platform: t.platform, status: "error", error: msg })
          console.error(`Post failed on ${t.platform}: ${msg}`)
        }
      }
    }

    if (action.thread) {
      const t = action.thread
      try {
        const platform = await getPlatformAsync(t.platform)
        const res = await platform.thread(t.posts)
        for (const r of res) {
          results.push({ action: "thread", platform: t.platform, status: "ok", id: r.id })
        }
        sentEntriesToAppend.push({
          key: threadKey(t.platform, t.posts, t.idempotencyKey),
          action: "thread",
          platform: t.platform,
          textHash: hashText(t.posts.join("\n\n")),
          createdId: res[0]?.id,
          timestamp: new Date().toISOString(),
          // Provenance fields
          agentId: provenance.agentId,
          cwd: provenance.cwd,
          schedulerJobId: provenance.schedulerJobId,
          platformScope: provenance.platformScope,
          outboxPath: provenance.outboxPath,
          inboxPath: provenance.inboxPath,
          dispatchTimestamp: provenance.dispatchTimestamp,
          dryRun: provenance.dryRun,
        })
        console.log(`Thread posted on ${t.platform}: ${res.length} posts`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Find how many posts succeeded before failure
        const okCount = results.filter(
          (r) => r.action === "thread" && r.platform === t.platform && r.status === "ok",
        ).length
        const lastOk = okCount > 0 ? results.filter(
          (r) => r.action === "thread" && r.platform === t.platform && r.status === "ok",
        ).pop() : undefined
        results.push({
          action: "thread",
          platform: t.platform,
          status: "error",
          error: msg,
          resumeFrom: okCount > 0 ? {
            index: okCount,
            parentId: lastOk?.id,
            remainingPosts: t.posts.slice(okCount),
          } : undefined,
        } as any)
        console.error(`Thread failed on ${t.platform} at post ${okCount + 1}/${t.posts.length}: ${msg}`)
      }
    }

    if (action.follow) {
      const f = action.follow
      try {
        const platform = await getPlatformAsync(f.platform)
        if (!platform.follow) {
          throw new Error(`Platform ${f.platform} does not support follow`)
        }
        const cleanHandle = f.handle.replace(/^@/, "")
        await platform.follow(cleanHandle)
        results.push({ action: "follow", platform: f.platform, status: "ok", id: cleanHandle })
        console.log(`Followed on ${f.platform}: ${cleanHandle}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "follow", platform: f.platform, status: "error", error: msg })
        console.error(`Follow failed on ${f.platform}: ${msg}`)
      }
    }

    if (action.like) {
      const l = action.like
      try {
        const platform = await getPlatformAsync(l.platform)
        if (!platform.like) {
          throw new Error(`Platform ${l.platform} does not support like`)
        }
        await platform.like(l.id)
        results.push({ action: "like", platform: l.platform, status: "ok", targetId: l.id })
        console.log(`Liked on ${l.platform}: ${l.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "like", platform: l.platform, status: "error", targetId: l.id, error: msg })
        console.error(`Like failed on ${l.platform}: ${msg}`)
      }
    }

    if (action.annotate) {
      const a = action.annotate
      try {
        const platform = await getPlatformAsync(a.platform)
        if (!platform.annotate) {
          throw new Error(`Platform ${a.platform} does not support annotations`)
        }
        const res = await platform.annotate(a.id, a.text, { motivation: a.motivation })
        results.push({ action: "annotate", platform: a.platform, status: "ok", id: res.id })
        console.log(`Annotated on ${a.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "annotate", platform: a.platform, status: "error", error: msg })
        console.error(`Annotate failed on ${a.platform}: ${msg}`)
      }
    }
  }

  // Archive outbox
  const archiveDir = resolve(process.cwd(), "outbox_archive")
  mkdirSync(archiveDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const archivedOutbox = join(archiveDir, `${timestamp}_outbox.yaml`)
  renameSync(filePath, archivedOutbox)

  if (sentEntriesToAppend.length > 0) {
    sentLedger.push(...sentEntriesToAppend)
    writeFileAtomic(
      sentLedgerPath,
      stringify({ entries: sentLedger }, { lineWidth: 120 }),
    )
  }

  if (successfulReplyCount > 0) {
    persistentProcessed = new Set([...persistentProcessed, ...processedNotifIds, ...getLedgerProcessedIds()])
  }

  // Remove processed items from inbox
  let inboxIdsRemoved: string[] = []
  if (processedNotifIds.length > 0 && existsSync(inboxPath)) {
    try {
      const inbox = parse(readFileSync(inboxPath, "utf-8")) as { notifications: any[]; _sync?: Record<string, unknown> }
      if (inbox?.notifications) {
        const processedSet = new Set(processedNotifIds)
        const before = inbox.notifications
        const remaining = before.filter((n: any) => !processedSet.has(n.id) && !processedSet.has(n.postId ?? ""))
        inboxIdsRemoved = before
          .filter((n: any) => processedSet.has(n.id) || processedSet.has(n.postId ?? ""))
          .map((n: any) => n.id)
        inbox.notifications = remaining
        if (inbox._sync) {
          inbox._sync = {
            ...inbox._sync,
            totalCount: remaining.length,
          }
        }
        writeFileAtomic(inboxPath, stringify(inbox, { lineWidth: 120 }))
      }
    } catch {
      // Best effort
    }
  }

  for (const result of results) {
    if (result.status === "ok") {
      result.archivedOutbox = archivedOutbox
      if (result.targetId) {
        result.inboxIdsRemoved = inboxIdsRemoved.filter((id) => id === result.targetId)
      }
    }
    // Add provenance to each result
    result.provenance = provenance
  }

  // Write results
  const resultPath = resolve(process.cwd(), "dispatch_result.yaml")
  writeFileAtomic(resultPath, stringify({ results, archivedOutbox, inboxIdsRemoved, provenance }, { lineWidth: 120 }))

  // Persist processed set for future cycles
  const newProcessed = new Set([...persistentProcessed, ...processedNotifIds, ...getLedgerProcessedIds()])
  writeFileAtomic(
    processedPath,
    stringify({ processed: Array.from(newProcessed).sort() }, { lineWidth: 120 }),
  )

  const ok = results.filter((r) => r.status === "ok").length
  const failed = results.filter((r) => r.status === "error").length
  console.log(`\nDispatch complete: ${ok} ok, ${failed} failed`)

  if (failed > 0) process.exit(2) // Partial failure
}
