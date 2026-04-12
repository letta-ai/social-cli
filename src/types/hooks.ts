/**
 * Hook system types for social-cli dispatch pipeline.
 *
 * Three lifecycle points:
 *   preDispatch  — sync, blocking. Exit 0=pass, 1=skip action, 2=abort dispatch.
 *   postDispatch — async, fire-and-forget. Logged but non-blocking.
 *   onError      — async. Fired after a failed action.
 */

/** Action types that hooks can match against. */
export type HookEvent =
  | "reply"
  | "post"
  | "thread"
  | "follow"
  | "like"
  | "annotate"
  | "bookmark"
  | "highlight"
  | "*"

/** The lifecycle point where a hook fires. */
export type HookLifecycle = "preDispatch" | "postDispatch" | "onError"

/** A single hook definition from config. */
export interface HookDefinition {
  /** Which action event(s) to match. "*" matches all. */
  event: HookEvent
  /** Shell command to execute. */
  command: string
  /** Timeout in seconds (default: 30 for pre, 60 for post). */
  timeout?: number
}

/** Hook configuration section in config.yaml. */
export interface HooksConfig {
  preDispatch?: HookDefinition[]
  postDispatch?: HookDefinition[]
  onError?: HookDefinition[]
}

/** Context passed to every hook via environment variables. */
export interface HookContext {
  /** The action type that triggered the hook. */
  event: string
  /** Platform (bsky, x, etc). */
  platform: string
  /** Created resource ID (post-dispatch only, empty for pre). */
  actionId?: string
  /** Parent post ID for replies. */
  targetId?: string
  /** The post/reply text content. */
  text?: string
  /** Path to the outbox file being dispatched. */
  outboxPath?: string
  /** "success" or "error". */
  result: "success" | "error"
  /** Error message (onError hooks only). */
  error?: string
}

/** Result of running a single hook. */
export interface HookResult {
  /** The hook definition that was run. */
  hook: HookDefinition
  /** Whether the hook completed within timeout. */
  timedOut: boolean
  /** Hook exit code. */
  exitCode: number | null
  /** Captured stdout. */
  stdout: string
  /** Captured stderr. */
  stderr: string
}

/** Aggregate result of running all hooks for a lifecycle point. */
export interface HookRunResult {
  /** Results for each individual hook. */
  results: HookResult[]
  /** Whether any hook requested a block (preDispatch: exit 1 or 2). */
  blocked: boolean
  /** Whether any hook requested a hard abort (exit 2). */
  abort: boolean
  /** Block/abort reason (stdout from the blocking hook). */
  reason?: string
}
