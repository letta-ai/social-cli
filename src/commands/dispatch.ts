/**
 * dispatch: Read outbox YAML, post to platforms, write results.
 * Continue on failure — report per-action results.
 */

import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"
import { parse, stringify } from "yaml"
import { getPlatformAsync } from "../platforms/index.js"
import { validateOutbox, type OutboxFile, type OutboxAction } from "./validate.js"
import { writeFileAtomic } from "../util/fs.js"

interface DispatchResult {
  action: string
  platform: string
  status: "ok" | "error"
  id?: string
  targetId?: string
  inboxIdsRemoved?: string[]
  archivedOutbox?: string
  error?: string
}

export async function dispatch(opts: {
  file?: string
  dryRun?: boolean
}): Promise<void> {
  const filePath = resolve(process.cwd(), opts.file ?? "outbox.yaml")

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

  if (opts.dryRun) {
    console.log("Dry run: validation passed.")
    process.exit(0)
  }

  // Load inbox for validation and later pruning
  const inboxPath = resolve(process.cwd(), "inbox.yaml")
  let inboxNotifications: Array<{ id: string; postId?: string }> = []
  if (existsSync(inboxPath)) {
    try {
      const inbox = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: Array<{ id: string; postId?: string }> }
      inboxNotifications = inbox?.notifications ?? []
    } catch {
      // Best effort only
    }
  }

  // Dispatch
  const results: DispatchResult[] = []
  const processedNotifIds: string[] = []

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
        // Only prune from inbox if the target came from there
        const targetExistsInInbox = inboxNotifications.some((n) => n.id === r.id || n.postId === r.id)
        if (targetExistsInInbox) processedNotifIds.push(r.id)
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

  // Remove processed items from inbox
  let inboxIdsRemoved: string[] = []
  if (processedNotifIds.length > 0 && existsSync(inboxPath)) {
    try {
      const inbox = parse(readFileSync(inboxPath, "utf-8")) as { notifications: any[]; _sync?: Record<string, unknown> }
      if (inbox?.notifications) {
        const processedSet = new Set(processedNotifIds)
        const before = inbox.notifications
        const remaining = before.filter((n: any) => !processedSet.has(n.id) && !processedSet.has(n.postId))
        inboxIdsRemoved = before
          .filter((n: any) => processedSet.has(n.id) || processedSet.has(n.postId))
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
  }

  // Write results
  const resultPath = resolve(process.cwd(), "dispatch_result.yaml")
  writeFileAtomic(resultPath, stringify({ results, archivedOutbox, inboxIdsRemoved }, { lineWidth: 120 }))

  const ok = results.filter((r) => r.status === "ok").length
  const failed = results.filter((r) => r.status === "error").length
  console.log(`\nDispatch complete: ${ok} ok, ${failed} failed`)

  if (failed > 0) process.exit(2) // Partial failure
}
