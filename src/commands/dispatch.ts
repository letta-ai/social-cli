/**
 * dispatch: Read outbox-{platform}.yaml, post to platforms, write results.
 * 
 * With platform isolation enabled (default), dispatch reads from platform-specific
 * outbox files and writes to platform-specific sent_ledger files.
 * 
 * Usage:
 *   dispatch                  - Dispatch from all platform outboxes
 *   dispatch --platform bsky  - Dispatch only from bsky outbox
 *   dispatch outbox.yaml     - Dispatch from a specific file (legacy mode)
 * 
 * Continue on failure — report per-action results.
 */

import { readFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { createHash } from "node:crypto"
import { parse, stringify } from "yaml"
import { getPlatformAsync } from "../platforms/index.js"
import type { PostOpts } from "../platforms/types.js"
import { loadConfig } from "../config.js"
import { validateOutbox, type OutboxFile, type OutboxAction } from "./validate.js"
import { writeFileAtomic } from "../util/fs.js"
import { runHooks } from "../hooks.js"
import type { HookContext } from "../types/hooks.js"
import {
  getPlatformFilePath,
  getSharedFilePath,
  platformFileExists,
  sharedFileExists,
  migrateSharedToPlatformSpecific,
  discoverPlatformFiles,
  readPlatformFile,
  writePlatformFile,
  readSharedFile,
} from "../lib/state.js"

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
  /** Platform being dispatched (for platform-specific dispatch) */
  platform?: string
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

function postKey(platform: string, text: string, idempotencyKey?: string, quoteId?: string, replyTo?: string): string {
  const suffix = quoteId ? `:q:${quoteId}` : replyTo ? `:r:${replyTo}` : ""
  return idempotencyKey ?? `post:${platform}:${hashText(text)}${suffix}`
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
  platform?: string
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
    platform: opts.platform,
  }
}

/**
 * Build hook context from an outbox action and optional result.
 */
function buildHookContext(
  action: OutboxAction,
  platform: string,
  outboxPath: string,
  opts?: { actionId?: string; result?: "success" | "error"; error?: string; text?: string },
): HookContext {
  let event = "post"
  let text = opts?.text ?? ""
  let targetId: string | undefined

  if (action.reply) { event = "reply"; text = action.reply.text; targetId = action.reply.id }
  else if (action.thread) { event = "thread"; text = action.thread.posts.join("\n") }
  else if (action.post) { event = "post"; text = action.post.text ?? "" }
  else if (action.follow) { event = "follow" }
  else if (action.like) { event = "like"; targetId = action.like.id }
  else if (action.annotate) { event = "annotate"; text = action.annotate.text; targetId = action.annotate.id }
  else if (action.bookmark) { event = "bookmark"; targetId = action.bookmark.id }
  else if (action.highlight) { event = "highlight"; targetId = action.highlight.id }

  return {
    event,
    platform,
    actionId: opts?.actionId,
    targetId,
    text,
    outboxPath,
    result: opts?.result ?? "success",
    error: opts?.error,
  }
}

/**
 * Dispatch for a single platform.
 */
async function dispatchPlatform(
  platform: string,
  opts: {
    dryRun?: boolean
    schedulerJobId?: string
    explicitFile?: string
  }
): Promise<{ ok: number; failed: number; results: DispatchResult[] }> {
  const config = loadConfig()
  const platformIsolation = config.state?.platformIsolation ?? true
  const stateDir = config.state?.stateDir
  const allowedPlatforms = config.dispatch?.allowedPlatforms

  // Validate platform is in allowed set
  if (allowedPlatforms && allowedPlatforms.length > 0) {
    if (!allowedPlatforms.includes(platform)) {
      console.error(`Error: Platform "${platform}" not in dispatch allowed set.`)
      console.error(`Allowed platforms: ${allowedPlatforms.join(", ")}`)
      process.exit(1)
    }
  }

  // Determine outbox path
  const outboxPath = opts.explicitFile
    ? resolve(process.cwd(), opts.explicitFile)
    : platformIsolation
      ? getPlatformFilePath("outbox", platform, stateDir)
      : getSharedFilePath("outbox", stateDir)

  if (!existsSync(outboxPath)) {
    console.log(`[${platform}] No outbox file found at ${outboxPath}, skipping.`)
    return { ok: 0, failed: 0, results: [] }
  }

  // Load outbox
  let outbox: OutboxFile
  try {
    outbox = parse(readFileSync(outboxPath, "utf-8")) as OutboxFile
  } catch (err) {
    console.error(`[${platform}] Failed to parse ${outboxPath}: ${err instanceof Error ? err.message : err}`)
    return { ok: 0, failed: 1, results: [] }
  }

  // Validate
  const validation = validateOutbox(outbox)
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.error(`[${platform}] Warning: ${w}`)
  }
  if (!validation.valid) {
    for (const e of validation.errors) console.error(`[${platform}] Error: ${e}`)
    console.error(`[${platform}] Validation failed: ${validation.errors.length} error(s)`)
    return { ok: 0, failed: 1, results: [] }
  }

  // Determine inbox path
  const inboxPath = platformIsolation
    ? getPlatformFilePath("inbox", platform, stateDir)
    : getSharedFilePath("inbox", stateDir)

  // Build provenance info
  const provenance = buildProvenanceInfo({
    filePath: outboxPath,
    inboxPath: existsSync(inboxPath) ? inboxPath : undefined,
    platformScope: allowedPlatforms,
    dryRun: opts.dryRun ?? false,
    schedulerJobId: opts.schedulerJobId,
    platform,
  })

  // Validate platform scope for each action
  if (allowedPlatforms && allowedPlatforms.length > 0) {
    for (const action of outbox.dispatch) {
      let actionPlatform: string | undefined
      if (action.reply) actionPlatform = action.reply.platform
      else if (action.thread) actionPlatform = action.thread.platform
      else if (action.annotate) actionPlatform = action.annotate.platform
      else if (action.bookmark) actionPlatform = action.bookmark.platform
      else if (action.highlight) actionPlatform = action.highlight.platform
      else if (action.follow) actionPlatform = action.follow.platform
      else if (action.like) actionPlatform = action.like.platform
      else if (action.post?.platforms) {
        const platforms = action.post.platforms
        actionPlatform = Array.isArray(platforms) ? platforms[0] : Object.keys(platforms)[0]
      }

      if (actionPlatform && !allowedPlatforms.includes(actionPlatform)) {
        console.error(`[${platform}] Error: Platform "${actionPlatform}" not in dispatch allowed set.`)
        console.error(`Allowed platforms: ${allowedPlatforms.join(", ")}`)
        process.exit(1)
      }
    }
  }

  // Load sent ledger for replay protection
  const sentLedgerPath = platformIsolation
    ? getPlatformFilePath("sent_ledger", platform, stateDir)
    : getSharedFilePath("sent_ledger", stateDir)
  
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
        for (const plat of platforms) {
          const key = postKey(plat, action.post.text, action.post.idempotencyKey, action.post.quoteId, action.post.replyTo)
          if (sentKeys.has(key)) {
            preflightErrors.push(`Replay detected for post on ${plat}`)
          }
        }
      }
      if (action.post.platforms && typeof action.post.platforms === "object" && !Array.isArray(action.post.platforms)) {
        for (const [plat, text] of Object.entries(action.post.platforms)) {
          const key = postKey(plat, text, action.post.idempotencyKey, action.post.quoteId, action.post.replyTo)
          if (sentKeys.has(key)) {
            preflightErrors.push(`Replay detected for post on ${plat}`)
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
    for (const e of preflightErrors) console.error(`[${platform}] Preflight error: ${e}`)
    console.error(`[${platform}] Preflight validation failed: ${preflightErrors.length} error(s)`)
    process.exit(1)
  }

  if (opts.dryRun) {
    console.log(`[${platform}] Dry run: validation passed.`)
    return { ok: 0, failed: 0, results: [] }
  }

  // Load inbox for validation and later pruning
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
  const processedPath = platformIsolation
    ? getPlatformFilePath("processed", platform, stateDir)
    : resolve(process.cwd(), "processed.yaml")
  
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
      console.log(`[${platform}] Filtered ${filtered} previously-processed notification(s) from inbox`)
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
      console.log(`[${platform}] Ignoring ${action.ignore.id} (${action.ignore.reason ?? "unspecified"})`)
      continue
    }

    // Pre-dispatch hooks: synchronous, blocking
    const preCtx = buildHookContext(action, platform, outboxPath)
    const preResult = await runHooks(config.hooks, "preDispatch", preCtx)
    if (preResult.abort) {
      console.error(`[${platform}] Dispatch aborted by pre-dispatch hook: ${preResult.reason}`)
      results.push({ action: preCtx.event, platform, status: "error", error: `Aborted by hook: ${preResult.reason}` })
      // Abort remaining actions — archive what we have
      break
    }
    if (preResult.blocked) {
      console.log(`[${platform}] Action blocked by pre-dispatch hook: ${preResult.reason}`)
      results.push({ action: preCtx.event, platform, status: "error", error: `Blocked by hook: ${preResult.reason}` })
      continue
    }

    if (action.reply) {
      const r = action.reply
      try {
        const plat = await getPlatformAsync(r.platform)
        const res = await plat.reply(r.id, r.text)
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
        console.log(`[${platform}] Replied on ${r.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "reply", platform: r.platform, status: "error", targetId: r.id, error: msg })
        console.error(`[${platform}] Reply failed on ${r.platform}: ${msg}`)
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
          const plat = await getPlatformAsync(t.platform)
          let res
          if (p.replyTo) {
            // Route through reply when replyTo is specified
            const replyOpts: PostOpts = {}
            if (p.quoteId) replyOpts.quoteId = p.quoteId
            res = await plat.reply(p.replyTo, t.text, replyOpts)
          } else {
            const postOpts: PostOpts = {}
            if (p.quoteId) postOpts.quoteId = p.quoteId
            res = await plat.post(t.text, postOpts)
          }
          results.push({ action: "post", platform: t.platform, status: "ok", id: res.id })
          sentEntriesToAppend.push({
            key: postKey(t.platform, t.text, p.idempotencyKey, p.quoteId, p.replyTo),
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
          console.log(`[${platform}] Posted on ${t.platform}: ${res.id}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          results.push({ action: "post", platform: t.platform, status: "error", error: msg })
          console.error(`[${platform}] Post failed on ${t.platform}: ${msg}`)
        }
      }
    }

    if (action.thread) {
      const t = action.thread
      try {
        // Resolve media: explicit paths + auto-generated card
        let mediaPaths: string[] = t.media ?? []
        if (t.card) {
          const { execSync } = await import("node:child_process")
          const { resolve: resolvePath, dirname } = await import("node:path")
          const { fileURLToPath } = await import("node:url")
          const scriptDir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "thread-cards")
          const tmpCard = `/tmp/thread-card-${Date.now()}.png`
          const cardOpts = typeof t.card === "object" ? t.card : {}
          const title = (cardOpts.title ?? t.posts[0].slice(0, 80)).replace(/"/g, '\\"')
          const subtitle = (cardOpts.subtitle ?? "").replace(/"/g, '\\"')
          const pattern = cardOpts.pattern ?? "ripple"
          execSync(
            `npx tsx "${scriptDir}/generate-card.ts" --title "${title}" --subtitle "${subtitle}" --pattern ${pattern} --output "${tmpCard}"`,
            { stdio: "pipe" },
          )
          mediaPaths = [tmpCard, ...mediaPaths]
        }

        const plat = await getPlatformAsync(t.platform)
        const res = await plat.thread(t.posts, t.replyTo, {
          media: mediaPaths.length > 0 ? mediaPaths : undefined,
        })
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
        console.log(`[${platform}] Thread posted on ${t.platform}: ${res.length} posts`)
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
        console.error(`[${platform}] Thread failed on ${t.platform} at post ${okCount + 1}/${t.posts.length}: ${msg}`)
      }
    }

    if (action.follow) {
      const f = action.follow
      try {
        const plat = await getPlatformAsync(f.platform)
        if (!plat.follow) {
          throw new Error(`Platform ${f.platform} does not support follow`)
        }
        const cleanHandle = f.handle.replace(/^@/, "")
        await plat.follow(cleanHandle)
        results.push({ action: "follow", platform: f.platform, status: "ok", id: cleanHandle })
        console.log(`[${platform}] Followed on ${f.platform}: ${cleanHandle}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "follow", platform: f.platform, status: "error", error: msg })
        console.error(`[${platform}] Follow failed on ${f.platform}: ${msg}`)
      }
    }

    if (action.like) {
      const l = action.like
      try {
        const plat = await getPlatformAsync(l.platform)
        if (!plat.like) {
          throw new Error(`Platform ${l.platform} does not support like`)
        }
        await plat.like(l.id)
        results.push({ action: "like", platform: l.platform, status: "ok", targetId: l.id })
        console.log(`[${platform}] Liked on ${l.platform}: ${l.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "like", platform: l.platform, status: "error", targetId: l.id, error: msg })
        console.error(`[${platform}] Like failed on ${l.platform}: ${msg}`)
      }
    }

    if (action.annotate) {
      const a = action.annotate
      try {
        const plat = await getPlatformAsync(a.platform)
        if (!plat.annotate) {
          throw new Error(`Platform ${a.platform} does not support annotations`)
        }
        const res = await plat.annotate(a.id, a.text, { motivation: a.motivation })
        results.push({ action: "annotate", platform: a.platform, status: "ok", id: res.id })
        console.log(`[${platform}] Annotated on ${a.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "annotate", platform: a.platform, status: "error", error: msg })
        console.error(`[${platform}] Annotate failed on ${a.platform}: ${msg}`)
      }
    }

    if (action.bookmark) {
      const b = action.bookmark
      try {
        const plat = await getPlatformAsync(b.platform)
        if (!plat.annotate) {
          throw new Error(`Platform ${b.platform} does not support annotations`)
        }
        const res = await plat.annotate(b.id, b.text ?? "", { motivation: "bookmarking" })
        results.push({ action: "bookmark", platform: b.platform, status: "ok", id: res.id })
        console.log(`[${platform}] Bookmarked on ${b.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "bookmark", platform: b.platform, status: "error", error: msg })
        console.error(`[${platform}] Bookmark failed on ${b.platform}: ${msg}`)
      }
    }

    if (action.highlight) {
      const h = action.highlight
      try {
        const plat = await getPlatformAsync(h.platform)
        if (!plat.annotate) {
          throw new Error(`Platform ${h.platform} does not support annotations`)
        }
        const res = await plat.annotate(h.id, h.text ?? "", { motivation: "highlighting", quote: h.quote })
        results.push({ action: "highlight", platform: h.platform, status: "ok", id: res.id })
        console.log(`[${platform}] Highlighted on ${h.platform}: ${res.id}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ action: "highlight", platform: h.platform, status: "error", error: msg })
        console.error(`[${platform}] Highlight failed on ${h.platform}: ${msg}`)
      }
    }
  }

  // Post-dispatch and on-error hooks (async, fire-and-forget)
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const action = outbox.dispatch[i]
    if (!action) continue

    if (result.status === "ok") {
      const postCtx = buildHookContext(action, platform, outboxPath, {
        actionId: result.id,
        result: "success",
      })
      runHooks(config.hooks, "postDispatch", postCtx)
    } else {
      const errCtx = buildHookContext(action, platform, outboxPath, {
        result: "error",
        error: result.error,
      })
      runHooks(config.hooks, "onError", errCtx)
    }
  }

  // Archive outbox
  const archiveDir = resolve(process.cwd(), "outbox_archive")
  mkdirSync(archiveDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const archivedOutbox = join(archiveDir, `${timestamp}_outbox-${platform}.yaml`)
  renameSync(outboxPath, archivedOutbox)

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
  const resultPath = resolve(process.cwd(), `dispatch_result-${platform}.yaml`)
  writeFileAtomic(resultPath, stringify({ results, archivedOutbox, inboxIdsRemoved, provenance }, { lineWidth: 120 }))

  // Persist processed set for future cycles
  const newProcessed = new Set([...persistentProcessed, ...processedNotifIds, ...getLedgerProcessedIds()])
  writeFileAtomic(
    processedPath,
    stringify({ processed: Array.from(newProcessed).sort() }, { lineWidth: 120 }),
  )

  const ok = results.filter((r) => r.status === "ok").length
  const failed = results.filter((r) => r.status === "error").length
  console.log(`[${platform}] Dispatch complete: ${ok} ok, ${failed} failed`)

  return { ok, failed, results }
}

export async function dispatch(opts: {
  file?: string
  dryRun?: boolean
  /** Optional scheduler job ID or automation source for provenance tracking */
  schedulerJobId?: string
  /** Platform to dispatch (for platform-specific dispatch) */
  platform?: string
}): Promise<void> {
  const config = loadConfig()
  const platformIsolation = config.state?.platformIsolation ?? true
  const stateDir = config.state?.stateDir
  const allowedPlatforms = config.dispatch?.allowedPlatforms ?? []

  // If explicit file is provided, use legacy single-file dispatch
  if (opts.file) {
    // Legacy mode: dispatch from a specific file
    const filePath = resolve(process.cwd(), opts.file)
    
    // Determine platform from filename if it matches pattern
    let platform: string | undefined
    const match = basename(filePath).match(/^outbox-(.+)\.yaml$/)
    if (match) {
      platform = match[1]
    } else {
      // Use the first allowed platform or default to bsky
      platform = allowedPlatforms[0] ?? "bsky"
    }

    const result = await dispatchPlatform(platform, {
      dryRun: opts.dryRun,
      schedulerJobId: opts.schedulerJobId,
      explicitFile: opts.file,
    })

    if (result.failed > 0) process.exit(2)
    return
  }

  // Platform-specific dispatch
  if (opts.platform) {
    // Dispatch from a specific platform's outbox
    const result = await dispatchPlatform(opts.platform, {
      dryRun: opts.dryRun,
      schedulerJobId: opts.schedulerJobId,
    })

    if (result.failed > 0) process.exit(2)
    return
  }

  // Discover all platform outboxes
  let platforms: string[]
  if (platformIsolation) {
    platforms = discoverPlatformFiles("outbox", stateDir)
    if (platforms.length === 0) {
      // Check for legacy shared outbox
      if (sharedFileExists("outbox", stateDir)) {
        console.log("Using legacy shared outbox.yaml (consider migrating to platform-specific files)")
        const platform = allowedPlatforms[0] ?? "bsky"
        const result = await dispatchPlatform(platform, {
          dryRun: opts.dryRun,
          schedulerJobId: opts.schedulerJobId,
        })
        if (result.failed > 0) process.exit(2)
        return
      }
      console.log("No outbox files found.")
      return
    }
  } else {
    // Legacy mode: use shared outbox
    if (!sharedFileExists("outbox", stateDir)) {
      console.log("No outbox.yaml found.")
      return
    }
    const platform = allowedPlatforms[0] ?? "bsky"
    const result = await dispatchPlatform(platform, {
      dryRun: opts.dryRun,
      schedulerJobId: opts.schedulerJobId,
    })
    if (result.failed > 0) process.exit(2)
    return
  }

  // Dispatch from all platform outboxes
  let totalOk = 0
  let totalFailed = 0

  for (const platform of platforms) {
    const result = await dispatchPlatform(platform, {
      dryRun: opts.dryRun,
      schedulerJobId: opts.schedulerJobId,
    })
    totalOk += result.ok
    totalFailed += result.failed
  }

  console.log(`\nTotal dispatch: ${totalOk} ok, ${totalFailed} failed across ${platforms.length} platform(s)`)

  if (totalFailed > 0) process.exit(2)
}
