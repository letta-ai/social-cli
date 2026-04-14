/**
 * Semble commands: first-class integration with the Semble knowledge network.
 *
 * Primitives:
 * - list: List collections
 * - get: Get a collection's cards and details
 * - create: Create a new collection
 * - add-card: Create a card and optionally add it to a collection
 * - connect: Create a typed connection between two URLs
 */

import { stringify } from "yaml"
import { SemblePDSClient, type StrongRef } from "@cosmik.network/semble-pds-client"
import { loadConfig, loadCredentials } from "../config.js"

/** Authenticate and return a SemblePDSClient */
async function getClient(): Promise<SemblePDSClient> {
  const config = loadConfig()
  loadCredentials("bsky", config)

  const handle = process.env.ATPROTO_HANDLE
  const password = process.env.ATPROTO_APP_PASSWORD
  const pds = process.env.ATPROTO_PDS || "https://bsky.social"

  if (!handle || !password) {
    console.error("Error: ATPROTO_HANDLE and ATPROTO_APP_PASSWORD must be set (via bsky credentials)")
    process.exit(1)
  }

  const client = new SemblePDSClient({ service: pds })
  await client.login(handle, password)
  return client
}

/** Get the rkey from an AT-URI */
function rkey(uri: string): string {
  return uri.split("/").pop() ?? uri
}

/** List all collections for the authenticated user */
export async function listCollections(opts: { limit?: number; cursor?: string }): Promise<void> {
  const client = await getClient()
  const result = await client.getMyCollections({
    limit: opts.limit ?? 50,
    cursor: opts.cursor,
  })

  const collections = result.records.map((r) => ({
    rkey: rkey(r.uri),
    name: r.value.name,
    description: r.value.description ?? null,
    accessType: r.value.accessType,
    createdAt: r.value.createdAt,
    uri: r.uri,
  }))

  process.stdout.write(stringify(collections, { lineWidth: 120 }))

  if (result.cursor) {
    process.stderr.write(`\nMore results available (cursor: ${result.cursor})\n`)
  }
}

/** Get a specific collection's details and cards */
export async function getCollection(collectionId: string): Promise<void> {
  const client = await getClient()
  const agent = client.agent
  const did = agent.session?.did

  if (!did) {
    console.error("Error: not authenticated")
    process.exit(1)
  }

  // Fetch the collection record
  const collectionUri = collectionId.startsWith("at://")
    ? collectionId
    : `at://${did}/network.cosmik.collection/${collectionId}`

  const collectionRef: StrongRef = { uri: collectionUri, cid: "" }

  let collection
  try {
    collection = await client.getCollection(collectionRef)
  } catch {
    console.error(`Error: collection not found: ${collectionId}`)
    process.exit(1)
  }

  // Fetch collection links to find cards in this collection
  const linksResult = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection: "network.cosmik.collectionLink",
    limit: 100,
  })

  // Filter links that point to this collection
  const collectionRkey = rkey(collectionUri)
  const linkedCardUris: string[] = []
  for (const link of linksResult.data.records) {
    const val = link.value as any
    if (val.collection?.uri && rkey(val.collection.uri) === collectionRkey) {
      if (val.card?.uri) linkedCardUris.push(val.card.uri)
    }
  }

  // Fetch the actual cards
  const cards: any[] = []
  for (const cardUri of linkedCardUris) {
    try {
      const cardRef: StrongRef = { uri: cardUri, cid: "" }
      const card = await client.getCard(cardRef)

      // If it's a URL card, check for note children
      const cardData: any = {
        rkey: rkey(card.uri),
        type: card.value.type,
        url: card.value.url ?? null,
        createdAt: card.value.createdAt,
      }

      // For URL cards, find attached notes
      if (card.value.type === "URL") {
        const allCards = await client.getMyCards({ limit: 100 })
        const noteCards = allCards.records.filter(
          (c) => c.value.type === "NOTE" && c.value.parentCard?.uri === card.uri,
        )
        if (noteCards.length > 0) {
          cardData.notes = noteCards.map((n) => ({
            text: n.value.content,
            createdAt: n.value.createdAt,
          }))
        }
      }

      cards.push(cardData)
    } catch {
      cards.push({ uri: cardUri, error: "failed to fetch" })
    }
  }

  // Fetch connections and filter to those involving this collection's card URLs
  const cardUrls = new Set(cards.map((c: any) => c.url).filter(Boolean))
  const connectionsResult = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection: "network.cosmik.connection",
    limit: 100,
  })

  const connections: any[] = []
  for (const conn of connectionsResult.data.records) {
    const val = conn.value as any
    // Only include connections where source or target matches a card URL in this collection
    if (cardUrls.has(val.source) || cardUrls.has(val.target)) {
      connections.push({
        rkey: rkey(conn.uri),
        source: val.source,
        target: val.target,
        type: val.connectionType,
        note: val.note ?? null,
      })
    }
  }

  const output = {
    name: collection.value.name,
    description: collection.value.description ?? null,
    rkey: collectionRkey,
    uri: collectionUri,
    url: `https://semble.so/profile/${process.env.ATPROTO_HANDLE}/collections/${collectionRkey}`,
    createdAt: collection.value.createdAt,
    cards,
    connections: connections.length > 0 ? connections : undefined,
  }

  process.stdout.write(stringify(output, { lineWidth: 120 }))
}

/** Create a new Semble collection */
export async function createCollection(opts: { name: string; description?: string }): Promise<void> {
  const client = await getClient()
  const collection = await client.createCollection({
    name: opts.name,
    description: opts.description,
  })
  const handle = process.env.ATPROTO_HANDLE
  const collectionRkey = rkey(collection.uri)
  console.log(`Collection: ${opts.name}`)
  console.log(`rkey: ${collectionRkey}`)
  console.log(`uri: ${collection.uri}`)
  console.log(`url: https://semble.so/profile/${handle}/collections/${collectionRkey}`)
}

/** Create a card and optionally add it to a collection */
export async function addCard(opts: { url: string; note?: string; collection?: string }): Promise<void> {
  const client = await getClient()
  const result = await client.createCard({
    url: opts.url,
    note: opts.note,
  })
  const cardRef = result?.urlCard ?? result
  const cardRkey = rkey(cardRef.uri)

  const domain = new URL(opts.url).hostname.replace("www.", "")
  console.log(`Card: ${domain}`)
  console.log(`rkey: ${cardRkey}`)

  if (opts.collection) {
    const did = client.agent.session?.did
    if (!did) {
      console.error("Error: not authenticated")
      process.exit(1)
    }
    const collectionUri = opts.collection.startsWith("at://")
      ? opts.collection
      : `at://${did}/network.cosmik.collection/${opts.collection}`

    // Need the CID for the collection ref — fetch it
    const collectionRecord = await client.agent.com.atproto.repo.getRecord({
      repo: did,
      collection: "network.cosmik.collection",
      rkey: rkey(collectionUri),
    })
    const collectionRef: StrongRef = { uri: collectionUri, cid: collectionRecord.data.cid ?? "" }
    await client.addCardToCollection(cardRef, collectionRef)
    console.log(`Added to collection: ${rkey(collectionUri)}`)
  }
}

/** Create a typed connection between two URLs */
export async function connect(opts: {
  source: string
  target: string
  type: string
  note?: string
}): Promise<void> {
  const client = await getClient()
  const agent = client.agent
  const now = new Date().toISOString()

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.session?.did ?? "",
    collection: "network.cosmik.connection",
    record: {
      $type: "network.cosmik.connection",
      source: opts.source,
      target: opts.target,
      connectionType: opts.type,
      note: opts.note,
      createdAt: now,
      updatedAt: now,
    },
  })

  console.log(`Connection: ${opts.source} → ${opts.target}`)
  console.log(`Type: ${opts.type}`)
  console.log(`rkey: ${rkey(result.data.uri)}`)
}
