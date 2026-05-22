#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const https = require("node:https")
const { parse } = require("yaml")
const { config: loadDotenv } = require("dotenv")
const { TwitterApi } = require("twitter-api-v2")

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

const tweetId = process.argv[2]
const outputDir = process.argv[3] || "/tmp"

if (!tweetId) {
  console.error("Usage: fetch-tweet-media.cjs <tweet_id> [output_dir]")
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

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath)
    const request = https.get(url, (res) => {
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

;(async () => {
  const tweet = await client.v2.singleTweet(tweetId, {
    "tweet.fields": ["attachments", "author_id", "created_at"],
    expansions: ["attachments.media_keys", "author_id"],
    "media.fields": ["media_key", "type", "url", "preview_image_url", "width", "height", "alt_text"],
  })

  console.log(JSON.stringify(tweet, null, 2))

  const media = tweet.includes?.media ?? []
  for (const m of media) {
    const url = m.url || m.preview_image_url
    if (!url) continue
    const ext = path.extname(new URL(url).pathname) || ".jpg"
    const out = path.join(outputDir, `tweet_${tweetId}_${m.media_key}${ext}`)
    await download(url, out)
    console.log(`Saved: ${out}`)
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
