/**
 * Text validation for quick commands.
 * Checks platform char limits before posting.
 */

import { PLATFORM_LIMITS } from "../platforms/types.js"

export function validateText(platform: string, text: string): void {
  const limit = PLATFORM_LIMITS[platform]
  if (!limit) return // unknown platform, let the API decide

  if (text.length > limit.chars) {
    console.error(`Text exceeds ${platform} limit: ${text.length}/${limit.chars} chars`)
    process.exit(1)
  }
}

export function validateTexts(platform: string, texts: string[]): void {
  for (let i = 0; i < texts.length; i++) {
    const limit = PLATFORM_LIMITS[platform]
    if (!limit) return
    if (texts[i].length > limit.chars) {
      console.error(`Post ${i + 1} exceeds ${platform} limit: ${texts[i].length}/${limit.chars} chars`)
      process.exit(1)
    }
  }
}
