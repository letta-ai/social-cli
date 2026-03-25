/**
 * annotate: Attach an annotation to a post.
 * Currently Bluesky-only (at.margin.annotation).
 */

import { getPlatformAsync } from "../platforms/index.js"

export async function annotate(opts: {
  platform: string
  id: string
  text: string
  motivation?: string
  quote?: string
}): Promise<void> {
  const platform = await getPlatformAsync(opts.platform)

  if (!platform.annotate) {
    console.error(`Platform ${opts.platform} does not support annotations`)
    process.exit(1)
  }

  const result = await platform.annotate(opts.id, opts.text, {
    motivation: opts.motivation,
    quote: opts.quote,
  })

  console.log(`Annotated: ${result.id}`)
}
