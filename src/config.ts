/**
 * Configuration loading for social-cli.
 * Reads config.yaml and resolves credentials from .env files.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { config as loadDotenv } from "dotenv"
import type { HooksConfig } from "./types/hooks.js"

export interface AccountConfig {
  handle: string
  pds?: string // ATProto PDS URL (Bluesky only)
  credentials?: string // Path to .env file
}

export interface SyncConfig {
  usersDir?: string
  autoCreateUsers?: boolean
  /** Allowed platforms for sync. Empty array means require explicit --platform. */
  allowedPlatforms?: string[]
}

export interface DispatchConfig {
  /** Allowed platforms for dispatch. Empty array means allow any platform in outbox. */
  allowedPlatforms?: string[]
}

export interface StateConfig {
  /** Enable platform-specific state files (default: true) */
  platformIsolation?: boolean
  /** Directory for state files (default: cwd) */
  stateDir?: string
}

export interface Config {
  accounts: Record<string, AccountConfig>
  sync?: SyncConfig
  dispatch?: DispatchConfig
  state?: StateConfig
  hooks?: HooksConfig
}

interface RawConfig {
  accounts?: Record<string, AccountConfig>
  sync?: SyncConfig
  dispatch?: DispatchConfig
  state?: StateConfig
  hooks?: HooksConfig
  [key: string]: unknown
}

const CONFIG_PATHS = [
  resolve(process.cwd(), "config.yaml"),
  resolve(process.env.HOME ?? "~", ".config/social-cli/config.yaml"),
]

export function loadConfig(): Config {
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8")
      const parsed = (parse(raw) as RawConfig | undefined) || {}
      const accounts: Record<string, AccountConfig> = { ...(parsed.accounts || {}) }

      for (const [key, value] of Object.entries(parsed)) {
        if (key === "accounts" || key === "sync") continue
        if (value && typeof value === "object" && "handle" in value) {
          accounts[key] = value as AccountConfig
        }
      }

      return {
        accounts,
        sync: parsed.sync,
        dispatch: parsed.dispatch,
        state: parsed.state,
        hooks: parsed.hooks,
      }
    }
  }

  // Fall back to env-only config (no config.yaml)
  return { accounts: {} }
}

/**
 * Load credentials for a specific platform.
 * Checks the config's credentials path, then falls back to .env in cwd.
 */
export function loadCredentials(platform: string, config: Config): Record<string, string> {
  const account = config.accounts[platform]
  const envPaths: string[] = []

  if (account?.credentials) {
    // Resolve relative to cwd
    envPaths.push(resolve(process.cwd(), account.credentials))
  }

  // Always check cwd .env as fallback
  envPaths.push(resolve(process.cwd(), ".env"))

  for (const p of envPaths) {
    if (existsSync(p)) {
      loadDotenv({ path: p, override: true, quiet: true })
      break
    }
  }

  return process.env as Record<string, string>
}
