/**
 * Platform registry.
 * Lazily initializes platforms only when first accessed.
 */

import type { SocialPlatform } from "./types.js"

const registry: Record<string, () => SocialPlatform> = {
  bsky: () => {
    const { bluesky } = require("./bluesky.js") as typeof import("./bluesky.js")
    return bluesky
  },
  x: () => {
    const { x } = require("./x.js") as typeof import("./x.js")
    return x
  },
}

const loaded: Record<string, SocialPlatform> = {}

export function getPlatform(name: string): SocialPlatform {
  if (loaded[name]) return loaded[name]
  const factory = registry[name]
  if (!factory) throw new Error(`Unknown platform: ${name}. Available: ${Object.keys(registry).join(", ")}`)
  loaded[name] = factory()
  return loaded[name]
}

export function availablePlatforms(): string[] {
  return Object.keys(registry)
}

export async function getPlatformAsync(name: string): Promise<SocialPlatform> {
  if (loaded[name]) return loaded[name]

  if (name === "bsky") {
    const mod = await import("./bluesky.js")
    loaded[name] = mod.bluesky
  } else if (name === "x") {
    const mod = await import("./x.js")
    loaded[name] = mod.x
  } else {
    throw new Error(`Unknown platform: ${name}. Available: ${Object.keys(registry).join(", ")}`)
  }

  return loaded[name]
}
