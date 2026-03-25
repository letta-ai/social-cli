/**
 * Configuration loading for social-cli.
 * Reads config.yaml and resolves credentials from .env files.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { parse } from "yaml"
import { config as loadDotenv } from "dotenv"

export interface AccountConfig {
  handle: string
  pds?: string // ATProto PDS URL (Bluesky only)
  credentials?: string // Path to .env file
}

export interface Config {
  accounts: Record<string, AccountConfig>
}

const CONFIG_PATHS = [
  resolve(process.cwd(), "config.yaml"),
  resolve(process.env.HOME ?? "~", ".config/social-cli/config.yaml"),
]

export function loadConfig(): Config {
  for (const p of CONFIG_PATHS) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8")
      return parse(raw) as Config
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
