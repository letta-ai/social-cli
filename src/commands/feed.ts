/**
 * feed: Fetch timeline from a platform → feed.yaml
 */

import { resolve } from "node:path"
import { stringify } from "yaml"
import { getPlatformAsync } from "../platforms/index.js"
import { writeFileAtomic } from "../util/fs.js"

export async function feed(opts: {
  platform?: string
  limit?: number
  output?: string
}): Promise<void> {
  const platform = await getPlatformAsync(opts.platform ?? "bsky")
  const items = await platform.feed(opts.limit ?? 50)
  const output = opts.output ?? "feed.yaml"
  const content = stringify(items, { lineWidth: 120 })

  if (output === "-") {
    process.stdout.write(content)
  } else {
    const outputPath = resolve(process.cwd(), output)
    writeFileAtomic(outputPath, content)
    console.log(`Fetched ${items.length} posts → ${outputPath}`)
  }
}
