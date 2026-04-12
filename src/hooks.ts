/**
 * Hook runner for social-cli dispatch pipeline.
 *
 * Loads hook config, matches events, executes hooks with env vars,
 * and returns results with blocking semantics.
 */

import { execFile } from "node:child_process"
import { resolve } from "node:path"
import type {
  HookDefinition,
  HookLifecycle,
  HooksConfig,
  HookContext,
  HookResult,
  HookRunResult,
} from "./types/hooks.js"

const DEFAULT_TIMEOUTS: Record<HookLifecycle, number> = {
  preDispatch: 30,
  postDispatch: 60,
  onError: 60,
}

/**
 * Check if a hook's event pattern matches the given action event.
 */
function matchesEvent(hookEvent: string, actionEvent: string): boolean {
  return hookEvent === "*" || hookEvent === actionEvent
}

/**
 * Build environment variables from hook context.
 */
function buildEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> }

  env.SOCIAL_HOOK_EVENT = ctx.event
  env.SOCIAL_HOOK_PLATFORM = ctx.platform
  env.SOCIAL_HOOK_ACTION_ID = ctx.actionId ?? ""
  env.SOCIAL_HOOK_TARGET_ID = ctx.targetId ?? ""
  env.SOCIAL_HOOK_TEXT = ctx.text ?? ""
  env.SOCIAL_HOOK_OUTBOX_PATH = ctx.outboxPath ?? ""
  env.SOCIAL_HOOK_RESULT = ctx.result
  if (ctx.error) env.SOCIAL_HOOK_ERROR = ctx.error

  return env
}

/**
 * Execute a single hook command.
 */
function executeHook(
  hook: HookDefinition,
  ctx: HookContext,
  timeout: number,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const env = buildEnv(ctx)

    const child = execFile(
      "bash",
      ["-c", hook.command],
      {
        env,
        timeout: timeout * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        shell: false,
      },
      (err, stdout, stderr) => {
        resolve({
          hook,
          timedOut: err?.killed === true && err?.signal === "SIGTERM",
          exitCode: err ? (err.killed ? null : (typeof err.code === "number" ? err.code : 1)) : 0,
          stdout: stdout?.trim() ?? "",
          stderr: stderr?.trim() ?? "",
        })
      },
    )

    // Prevent zombie processes
    child.on("error", () => {
      resolve({
        hook,
        timedOut: false,
        exitCode: 1,
        stdout: "",
        stderr: "Failed to spawn hook process",
      })
    })
  })
}

/**
 * Run all hooks for a given lifecycle point.
 *
 * For preDispatch: runs synchronously, returns blocking result.
 * For postDispatch/onError: runs async, logs errors.
 */
export async function runHooks(
  hooks: HooksConfig | undefined,
  lifecycle: HookLifecycle,
  ctx: HookContext,
): Promise<HookRunResult> {
  const empty: HookRunResult = { results: [], blocked: false, abort: false }

  if (!hooks) return empty

  const hookDefs = hooks[lifecycle]
  if (!hookDefs || hookDefs.length === 0) return empty

  // Filter hooks that match this event
  const matched = hookDefs.filter((h) => matchesEvent(h.event, ctx.event))
  if (matched.length === 0) return empty

  const results: HookResult[] = []
  let blocked = false
  let abort = false
  let reason: string | undefined

  for (const hook of matched) {
    const timeout = hook.timeout ?? DEFAULT_TIMEOUTS[lifecycle]

    if (lifecycle === "preDispatch") {
      // Sync: wait for result, check blocking
      const result = await executeHook(hook, ctx, timeout)
      results.push(result)

      console.log(`[hook:${lifecycle}] ${hook.command} → exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`)

      if (result.exitCode === 1) {
        blocked = true
        reason = result.stdout || result.stderr || "Hook blocked action"
        console.log(`[hook:${lifecycle}] Action blocked: ${reason}`)
        break // Don't run further hooks after block
      } else if (result.exitCode === 2) {
        blocked = true
        abort = true
        reason = result.stdout || result.stderr || "Hook aborted dispatch"
        console.error(`[hook:${lifecycle}] Dispatch aborted: ${reason}`)
        break
      }
      // exit 0 = pass through
    } else {
      // Async: fire and forget, but still collect result for logging
      executeHook(hook, ctx, timeout).then((result) => {
        results.push(result)
        if (result.exitCode !== 0 && result.exitCode !== null) {
          console.error(`[hook:${lifecycle}] ${hook.command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
        } else {
          console.log(`[hook:${lifecycle}] ${hook.command} → ok`)
        }
      }).catch(() => {
        // Silently swallow async hook errors
      })
    }
  }

  return { results, blocked, abort, reason }
}

/**
 * Load hooks config from the main config object.
 */
export function getHooksConfig(config: { hooks?: HooksConfig }): HooksConfig {
  return config.hooks ?? {}
}
