/**
 * validate: Pre-flight validation of outbox YAML.
 * Used by dispatch --dry-run and as standalone.
 */

import { PLATFORM_LIMITS } from "../platforms/types.js"

export interface OutboxAction {
  reply?: {
    platform: string
    id: string
    text: string
  }
  post?: {
    text?: string
    platforms?: string[] | Record<string, string>
  }
  thread?: {
    platform: string
    posts: string[]
  }
  annotate?: {
    platform: string
    id: string
    text: string
    motivation?: string
  }
  ignore?: {
    id: string
    reason: string
  }
}

export interface OutboxFile {
  dispatch: OutboxAction[]
  /** Persistently ignore these notification IDs across all future cycles. */
  processed?: string[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validateOutbox(outbox: OutboxFile): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!outbox?.dispatch) {
    errors.push("Missing 'dispatch' key")
    return { valid: false, errors, warnings }
  }

  if (!Array.isArray(outbox.dispatch)) {
    errors.push("'dispatch' must be an array")
    return { valid: false, errors, warnings }
  }

  if (outbox.dispatch.length === 0) {
    errors.push("Empty dispatch list")
    return { valid: false, errors, warnings }
  }

  for (let i = 0; i < outbox.dispatch.length; i++) {
    const action = outbox.dispatch[i]
    const prefix = `Action ${i}`

    // Determine action type
    const types = ["reply", "post", "thread", "annotate", "ignore"].filter(
      (t) => action[t as keyof OutboxAction] !== undefined,
    )

    if (types.length === 0) {
      errors.push(`${prefix}: No recognized action type (reply, post, thread, annotate, ignore)`)
      continue
    }
    if (types.length > 1) {
      errors.push(`${prefix}: Multiple action types in one entry: ${types.join(", ")}`)
      continue
    }

    const type = types[0]

    if (type === "reply") {
      const r = action.reply!
      if (!r.platform) errors.push(`${prefix}: reply missing 'platform'`)
      if (!r.id) errors.push(`${prefix}: reply missing 'id'`)
      if (!r.text) errors.push(`${prefix}: reply missing 'text'`)
      if (r.platform && r.text) {
        const limit = PLATFORM_LIMITS[r.platform]
        if (limit && r.text.length > limit.chars) {
          errors.push(`${prefix}: reply text exceeds ${r.platform} limit (${r.text.length}/${limit.chars})`)
        }
      }
    }

    if (type === "post") {
      const p = action.post!
      if (!p.text && !p.platforms) {
        errors.push(`${prefix}: post needs 'text' or 'platforms' with per-platform text`)
      }
      // Validate char limits for each platform
      if (p.text && p.platforms && Array.isArray(p.platforms)) {
        for (const plat of p.platforms) {
          const limit = PLATFORM_LIMITS[plat]
          if (limit && p.text.length > limit.chars) {
            errors.push(`${prefix}: post text exceeds ${plat} limit (${p.text.length}/${limit.chars})`)
          }
        }
      }
      if (p.platforms && typeof p.platforms === "object" && !Array.isArray(p.platforms)) {
        for (const [plat, text] of Object.entries(p.platforms)) {
          const limit = PLATFORM_LIMITS[plat]
          if (limit && text.length > limit.chars) {
            errors.push(`${prefix}: post text for ${plat} exceeds limit (${text.length}/${limit.chars})`)
          }
        }
      }
    }

    if (type === "thread") {
      const t = action.thread!
      if (!t.platform) errors.push(`${prefix}: thread missing 'platform'`)
      if (!t.posts || !Array.isArray(t.posts) || t.posts.length === 0) {
        errors.push(`${prefix}: thread needs non-empty 'posts' array`)
      }
      if (t.platform && t.posts) {
        const limit = PLATFORM_LIMITS[t.platform]
        if (limit) {
          for (let j = 0; j < t.posts.length; j++) {
            if (t.posts[j].length > limit.chars) {
              errors.push(`${prefix}: thread post ${j} exceeds ${t.platform} limit (${t.posts[j].length}/${limit.chars})`)
            }
          }
        }
      }
    }

    if (type === "annotate") {
      const a = action.annotate!
      if (!a.platform) errors.push(`${prefix}: annotate missing 'platform'`)
      if (!a.id) errors.push(`${prefix}: annotate missing 'id'`)
      if (!a.text) errors.push(`${prefix}: annotate missing 'text'`)
      if (a.platform && a.platform !== "bsky") {
        warnings.push(`${prefix}: annotations only supported on bsky`)
      }
    }

    if (type === "ignore") {
      const ig = action.ignore!
      if (!ig.id) errors.push(`${prefix}: ignore missing 'id'`)
      if (!ig.reason) warnings.push(`${prefix}: ignore missing 'reason'`)
    }
  }

  if (outbox.processed) {
    if (!Array.isArray(outbox.processed)) {
      errors.push("'processed' must be an array of notification IDs")
    } else if (outbox.processed.length > 0 && outbox.dispatch.length === 0) {
      warnings.push("'processed' is non-empty but 'dispatch' is empty — all items will be auto-ignored")
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
