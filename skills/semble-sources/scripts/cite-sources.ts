#!/usr/bin/env npx tsx
/**
 * cite-sources: Create a Semble collection linking a thread to its cited sources.
 *
 * Usage:
 *   npx tsx scripts/cite-sources.ts --input sources.yaml
 *   cat sources.yaml | npx tsx scripts/cite-sources.ts
 *
 * Input YAML format:
 *   collection: "Collection Name"
 *   description: "Optional collection description"
 *   thread:
 *     url: https://bsky.app/profile/handle/post/rkey
 *     note: "What this thread covers"
 *   sources:
 *     - url: https://example.com/article
 *       note: "What claim this source supports"
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { SemblePDSClient } from "@cosmik.network/semble-pds-client"
import { loadConfig, loadCredentials } from "../../../src/config.js"

type ConnectionType = "RELATED" | "SUPPORTS" | "OPPOSES" | "ADDRESSES" | "HELPFUL" | "EXPLAINER" | "LEADS_TO" | "SUPPLEMENTS"

interface SourceEntry {
  url: string
  note?: string
  /** Connection type from source to thread. Defaults to SUPPORTS. */
  connectionType?: ConnectionType
}

interface SourcesInput {
  collection: string
  description?: string
  thread?: {
    url: string
    note?: string
  }
  sources: SourceEntry[]
}

function parseArgs(): { input?: string } {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) return { input: args[i + 1] }
  }
  return {}
}

async function main() {
  const { input } = parseArgs()

  // Read input
  let yamlContent: string
  if (input) {
    yamlContent = readFileSync(resolve(process.cwd(), input), "utf-8")
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    yamlContent = Buffer.concat(chunks).toString("utf-8")
  } else {
    console.error("Usage: cite-sources.ts --input sources.yaml")
    console.error("       cat sources.yaml | cite-sources.ts")
    process.exit(1)
  }

  const data = parse(yamlContent) as SourcesInput

  if (!data.collection) {
    console.error("Error: 'collection' field is required")
    process.exit(1)
  }
  if (!data.sources || data.sources.length === 0) {
    console.error("Error: at least one source is required")
    process.exit(1)
  }

  // Authenticate
  const config = loadConfig()
  loadCredentials("bsky", config)

  const handle = process.env.ATPROTO_HANDLE
  const password = process.env.ATPROTO_APP_PASSWORD
  const pds = process.env.ATPROTO_PDS || "https://bsky.social"

  if (!handle || !password) {
    console.error("Error: ATPROTO_HANDLE and ATPROTO_APP_PASSWORD must be set")
    process.exit(1)
  }

  const client = new SemblePDSClient({ service: pds })
  await client.login(handle, password)

  // Create collection
  const collection = await client.createCollection({
    name: data.collection,
    description: data.description,
  })
  console.log(`Collection: ${data.collection}`)

  let cardCount = 0

  // createCard returns { urlCard, noteCard } — use urlCard for collection linking
  function getCardRef(result: any): any {
    return result?.urlCard ?? result
  }

  // Create thread card first (the anchor)
  if (data.thread) {
    const result = await client.createCard({
      url: data.thread.url,
      note: data.thread.note,
    })
    await client.addCardToCollection(getCardRef(result), collection)
    cardCount++
    console.log(`Thread: ${data.thread.url}`)
  }

  // Create source cards
  for (const source of data.sources) {
    const result = await client.createCard({
      url: source.url,
      note: source.note,
    })
    await client.addCardToCollection(getCardRef(result), collection)
    cardCount++

    const domain = new URL(source.url).hostname.replace("www.", "")
    console.log(`Source: ${domain}`)
  }

  // Create connections: each source → thread (via raw putRecord)
  if (data.thread && data.sources.length > 0) {
    const agent = (client as any).agent
    let connCount = 0
    for (const source of data.sources) {
      const connType = source.connectionType ?? "SUPPORTS"
      const now = new Date().toISOString()
      await agent.com.atproto.repo.createRecord({
        repo: agent.session?.did,
        collection: "network.cosmik.connection",
        record: {
          $type: "network.cosmik.connection",
          source: source.url,
          target: data.thread.url,
          connectionType: connType,
          note: source.note,
          createdAt: now,
          updatedAt: now,
        },
      })
      connCount++
    }
    console.log(`${connCount} connections (→ thread)`)
  }

  console.log(`\n${cardCount} cards → ${data.collection}`)
  console.log(`View: https://semble.so/profile/${handle}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
