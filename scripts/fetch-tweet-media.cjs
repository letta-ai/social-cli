#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const https = require("node:https")
const { parse } = require("yaml")
const { config: loadDotenv } = require("dotenv")
const { TwitterApi } = require("twitter-api-v2")

function extractTweetId(input) {
  if (!input) return null

  if (/^\d+$/.test(input)) {
    return input
  }

  try {
    const url = new URL(input)
    const match = url.pathname.match(/\/status\/(\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function loadCredentials() {
  const repoRoot = path.resolve(__dirname, "..")
  const envCandidates = []

  if (process.env.SOCIAL_CLI_ENV) {
    envCandidates.push(process.env.SOCIAL_CLI_ENV)
  }

  const configPath = path.join(repoRoot, "config.yaml")
  if (fs.existsSync(configPath)) {
    const raw = parse(fs.readFileSync(configPath, "utf8")) || {}
    const configuredPath = raw?.accounts?.x?.credentials || raw?.x?.credentials
    if (configuredPath) {
      envCandidates.push(path.resolve(repoRoot, configuredPath))
    }
  }

  envCandidates.push(path.join(repoRoot, ".env"))

  for (const envPath of envCandidates) {
    if (envPath && fs.existsSync(envPath)) {
      loadDotenv({ path: envPath, override: true, quiet: true })
      return envPath
    }
  }

  loadDotenv({ override: true, quiet: true })
  return null
}

const tweetInput = process.argv[2]
const outputDir = process.argv[3] || "/tmp"
const tweetId = extractTweetId(tweetInput)

if (!tweetId || !tweetInput) {
  console.error("Usage: fetch-tweet-media.cjs <tweet_id_or_url> [output_dir]")
  process.exit(1)
}

loadCredentials()

for (const key of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
  if (!process.env[key]) {
    console.error(`Missing required credential: ${key}`)
    process.exit(1)
  }
}

fs.mkdirSync(outputDir, { recursive: true })

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
})

function download(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath)
    const request = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects >= 5) {
          reject(new Error(`Too many redirects fetching ${url}`))
          return
        }

        const nextUrl = new URL(res.headers.location, url).toString()
        file.close(() => {
          fs.unlink(outPath, () => {
            download(nextUrl, outPath, redirects + 1).then(resolve, reject)
          })
        })
        res.resume()
        return
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Download failed: ${res.statusCode} ${url}`))
        return
      }
      res.pipe(file)
      file.on("finish", () => file.close(resolve))
    })

    request.on("error", (err) => {
      fs.unlink(outPath, () => reject(err))
    })

    file.on("error", (err) => {
      fs.unlink(outPath, () => reject(err))
    })
  })
}

function pickMediaUrl(media) {
  if (media.url) {
    return { url: media.url, source: "original" }
  }

  const mp4Variants = (media.variants || [])
    .filter((variant) => typeof variant?.url === "string" && variant.content_type === "video/mp4")
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))

  if (mp4Variants.length > 0) {
    return { url: mp4Variants[0].url, source: "variant" }
  }

  const firstVariant = (media.variants || []).find((variant) => typeof variant?.url === "string")
  if (firstVariant) {
    return { url: firstVariant.url, source: "variant" }
  }

  if (media.preview_image_url) {
    return { url: media.preview_image_url, source: "preview" }
  }

  return null
}

;(async () => {
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

  const media = tweet.includes?.media ?? []
  if (media.length === 0) {
    console.log(`No media found on tweet ${tweetId}`)
  }

  for (const m of media) {
    const selected = pickMediaUrl(m)
    if (!selected) {
      console.log(`Skipping ${m.media_key} (${m.type}): no downloadable URL`)
      continue
    }

    const ext = path.extname(new URL(selected.url).pathname)
      || (m.type === "video" || m.type === "animated_gif" ? ".mp4" : ".jpg")
    const out = path.join(outputDir, `tweet_${tweetId}_${m.media_key}${ext}`)
    await download(selected.url, out)
    console.log(`Saved (${m.type}, ${selected.source}): ${out}`)
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
