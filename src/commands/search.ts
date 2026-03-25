/**
 * search: Search posts across platforms.
 */

import { stringify } from "yaml"
import { getPlatformAsync } from "../platforms/index.js"

export async function search(query: string, opts: {
  platform?: string
  limit?: number
}): Promise<void> {
  const platform = await getPlatformAsync(opts.platform ?? "bsky")
  const results = await platform.search(query, opts.limit ?? 10)
  process.stdout.write(stringify(results, { lineWidth: 120 }))
}
