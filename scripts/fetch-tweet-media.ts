#!/usr/bin/env tsx
/**
 * Standalone helper: fetch an X tweet by ID and download its attached
 * media to a directory. Used when an agent needs to inspect media on a
 * specific tweet outside the normal sync flow (feed/search/manual).
 *
 * Shares URL-picking, extension inference, and download logic with the
 * sync command via `src/util/media.ts`.
 *
 * Usage:
 *   tsx scripts/fetch-tweet-media.ts <tweet_id_or_url> [output_dir]
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadDotenv } from "dotenv"
import { parse } from "yaml"
import { TwitterApi } from "twitter-api-v2"
import {
  downloadToFileWithExt,
  ensureDir,
  normalizeXMediaV2,
  pickMediaUrl,
} from "../src/util/media.js"

function extractTweetId(input: string | undefined): string | null {
  if (!input) return null
  if (/^\d+$/.test(input)) return input
  try {
    const url = new URL(input)
    const match = url.pathname.match(/\/status\/(\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function loadCredentials(): string | null {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, "..")
  const envCandidates: string[] = []

  if (process.env.SOCIAL_CLI_ENV) {
    envCandidates.push(process.env.SOCIAL_CLI_ENV)
  }

  const configPath = join(repoRoot, "config.yaml")
  if (existsSync(configPath)) {
    const raw = (parse(readFileSync(configPath, "utf8")) as Record<string, any>) ?? {}
    const configuredPath = raw?.accounts?.x?.credentials ?? raw?.x?.credentials
    if (typeof configuredPath === "string") {
      envCandidates.push(resolve(repoRoot, configuredPath))
    }
  }

  envCandidates.push(join(repoRoot, ".env"))

  for (const envPath of envCandidates) {
    if (envPath && existsSync(envPath)) {
      loadDotenv({ path: envPath, override: true, quiet: true })
      return envPath
    }
  }

  loadDotenv({ override: true, quiet: true })
  return null
}

async function main(): Promise<void> {
  const tweetInput = process.argv[2]
  const outputDir = process.argv[3] || "/tmp"
  const tweetId = extractTweetId(tweetInput)

  if (!tweetId || !tweetInput) {
    console.error("Usage: fetch-tweet-media.ts <tweet_id_or_url> [output_dir]")
    process.exit(1)
  }

  loadCredentials()

  for (const key of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
    if (!process.env[key]) {
      console.error(`Missing required credential: ${key}`)
      process.exit(1)
    }
  }

  ensureDir(outputDir)

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY as string,
    appSecret: process.env.X_API_SECRET as string,
    accessToken: process.env.X_ACCESS_TOKEN as string,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET as string,
  })

  const tweet = await client.v2.singleTweet(tweetId, {
    "tweet.fields": ["attachments", "author_id", "created_at"],
    expansions: ["attachments.media_keys", "author_id"],
    "media.fields": [
      "media_key",
      "type",
      "url",
      "preview_image_url",
      "width",
      "height",
      "alt_text",
      "duration_ms",
      "variants",
    ],
  })

  console.log(JSON.stringify(tweet, null, 2))

  const rawMedia = tweet.includes?.media ?? []
  if (rawMedia.length === 0) {
    console.log(`No media found on tweet ${tweetId}`)
  }

  for (const raw of rawMedia) {
    const media = normalizeXMediaV2(raw as Parameters<typeof normalizeXMediaV2>[0])
    const selected = pickMediaUrl(media)
    if (!selected) {
      console.log(`Skipping ${media.mediaKey} (${media.type}): no downloadable URL`)
      continue
    }

    const fallbackExt =
      media.type === "video" || media.type === "animated_gif" ? ".mp4" : ".jpg"
    const stem = join(outputDir, `tweet_${tweetId}_${media.mediaKey}`)
    const out = await downloadToFileWithExt(selected.url, stem, fallbackExt)
    console.log(`Saved (${media.type}, ${selected.source}): ${out}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
