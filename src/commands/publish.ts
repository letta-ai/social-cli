/**
 * publish: Publish long-form documents to ATProto via site.standard.document
 *
 * Writes a `site.standard.document` record with embedded `pub.leaflet.content`
 * to the agent's PDS. Leaflet's appview indexes records on the PDS and renders
 * them at leaflet.pub/reader (and on the publication's domain if configured).
 *
 * Schema reference (from github.com/hyperlink-academy/leaflet/lexicons):
 *   site.standard.document — wrapper (required: site, title, publishedAt)
 *     content — pub.leaflet.content (required: pages array)
 *       pages[] — pub.leaflet.pages.linearDocument (required: blocks array)
 *         blocks[] — { block: pub.leaflet.blocks.*, alignment? }
 *
 * MVP: paragraphs (`pub.leaflet.blocks.text`) and ATX headings
 * (`pub.leaflet.blocks.header`) only. Markdown formatting (bold/italic/links)
 * is stripped, not rendered as facets — followups in
 * reference/sensemaker/followups/social-cli-publish.md.
 */

import { readFileSync, existsSync } from "node:fs"
import { loadConfig, loadCredentials } from "../config.js"

interface PublishOptions {
  title?: string
  description?: string
  tags?: string
  file?: string
  content?: string
  rkey?: string
  slug?: string
  publication?: string
  dryRun?: boolean
}

interface FrontmatterFields {
  title?: string
  description?: string
  tags?: string
  slug?: string
  rkey?: string
}

interface LeafletTextBlock {
  $type: "pub.leaflet.blocks.text"
  plaintext: string
  textSize?: "default" | "small" | "large"
}

interface LeafletHeaderBlock {
  $type: "pub.leaflet.blocks.header"
  level: number
  plaintext: string
}

type LeafletBlock = LeafletTextBlock | LeafletHeaderBlock

interface LeafletPageBlock {
  $type: "pub.leaflet.pages.linearDocument#block"
  block: LeafletBlock
  alignment?: "#textAlignLeft" | "#textAlignCenter" | "#textAlignRight" | "#textAlignJustify"
}

interface LeafletLinearDocument {
  $type: "pub.leaflet.pages.linearDocument"
  id?: string
  blocks: LeafletPageBlock[]
}

interface LeafletContent {
  $type: "pub.leaflet.content"
  pages: LeafletLinearDocument[]
}

interface SiteStandardDocument {
  $type: "site.standard.document"
  site: string
  title: string
  publishedAt: string
  description?: string
  tags?: string[]
  path?: string
  textContent?: string
  content?: LeafletContent
}

interface PublishResult {
  success: boolean
  uri?: string
  cid?: string
  url?: string
  rkey?: string
  record?: SiteStandardDocument
  error?: string
}

const DEFAULT_PUBLICATION_URI =
  "at://did:plc:4j7exarb62djxycrgdfhuulr/site.standard.publication/3ml7mt7p7gq2u"
const TID_LAST_TIMESTAMP = { value: 0 }

/**
 * Generate a TID-format rkey (atproto's sortable timestamp identifier).
 * Format: 13 base32-sortable chars derived from microsecond timestamp + clock id.
 * Spec: https://atproto.com/specs/tid
 */
function generateTid(): string {
  // base32-sortable alphabet (lower 5 bits, sortable as string)
  const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz"
  // microsecond timestamp (53-bit safe integer)
  let now = Date.now() * 1000 + Math.floor((performance.now() % 1) * 1000)
  if (now <= TID_LAST_TIMESTAMP.value) {
    now = TID_LAST_TIMESTAMP.value + 1
  }
  TID_LAST_TIMESTAMP.value = now
  // 10-bit random clock identifier
  const clockId = Math.floor(Math.random() * 1024)
  // 64-bit value: top bit = 0, next 53 = timestamp, last 10 = clockId
  const bigVal = (BigInt(now) << 10n) | BigInt(clockId)
  // Encode as 13 base32 chars (65 bits but top bit is 0)
  let out = ""
  let v = bigVal
  for (let i = 0; i < 13; i++) {
    out = ALPHABET[Number(v & 31n)] + out
    v = v >> 5n
  }
  return out
}

/**
 * Slugify a title for URL paths. Lowercase, alphanumeric + hyphens only.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}

/**
 * Strip markdown formatting from a string (best effort).
 * Removes: **bold**, __bold__, *italic*, _italic_, `code`, [text](url) → text,
 * <link> autolinks → link, escape sequences.
 *
 * Future work: instead of stripping, parse these into pub.leaflet.richtext.facet
 * features. See reference/sensemaker/followups/social-cli-publish.md.
 */
function stripMarkdown(text: string): string {
  return text
    // links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // bold: **text** or __text__
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    // italic: *text* or _text_ (avoid matching inside words)
    .replace(/(?<!\w)([*_])([^*_\n]+?)\1(?!\w)/g, "$2")
    // inline code: `text`
    .replace(/`([^`]+)`/g, "$1")
    // autolink: <https://...>
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    // escaped chars: \* → *, \_ → _, etc.
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .trim()
}

/**
 * Convert a markdown body to an array of Leaflet page-blocks.
 *
 * MVP scope:
 * - ATX headings (`# heading`) → pub.leaflet.blocks.header
 * - Paragraphs (everything else, separated by blank lines) → pub.leaflet.blocks.text
 * - Blockquotes, lists, code blocks, images — flattened to plaintext for now
 *
 * Each block's plaintext has markdown formatting stripped (no facets in MVP).
 */
function markdownToBlocks(markdown: string): LeafletPageBlock[] {
  const blocks: LeafletPageBlock[] = []
  // Split on blank lines (one or more newlines with only whitespace between)
  const paragraphs = markdown.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)

  for (const para of paragraphs) {
    // Heading? ATX form: 1-6 #s + space + text
    const headingMatch = para.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (headingMatch && !para.includes("\n")) {
      blocks.push({
        $type: "pub.leaflet.pages.linearDocument#block",
        block: {
          $type: "pub.leaflet.blocks.header",
          level: headingMatch[1].length,
          plaintext: stripMarkdown(headingMatch[2]),
        },
      })
      continue
    }
    // Otherwise: text block. Collapse internal newlines to single space.
    const flat = para.replace(/\s*\n\s*/g, " ").trim()
    blocks.push({
      $type: "pub.leaflet.pages.linearDocument#block",
      block: {
        $type: "pub.leaflet.blocks.text",
        plaintext: stripMarkdown(flat),
      },
    })
  }

  return blocks
}

/**
 * Generate a UUIDv7-style identifier for the page id.
 * Leaflet uses these — the `id` field on linearDocument helps with persistence.
 */
function generateUuidV7(): string {
  const timestamp = Date.now()
  const timestampHex = timestamp.toString(16).padStart(12, "0")
  // Random bits for the rest (UUIDv7: timestamp + version + random)
  const randomHex = Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("")
  // UUIDv7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    "7" + randomHex.slice(0, 3),
    ((parseInt(randomHex[3], 16) & 0x3) | 0x8).toString(16) + randomHex.slice(4, 7),
    randomHex.slice(7, 19),
  ].join("-")
}

/**
 * Flatten page-blocks → plaintext for the document-level `textContent` field.
 * Used by indexers (leaflet-search etc.) for full-text search.
 */
function blocksToTextContent(blocks: LeafletPageBlock[]): string {
  return blocks.map(b => b.block.plaintext).join("\n")
}

/**
 * Parse YAML-ish frontmatter (key: value pairs only, no nested structures).
 * Reuses the same pattern as src/commands/blog.ts.
 */
function extractFrontmatter(content: string): { frontmatter: FrontmatterFields; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content }
  }
  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) {
    return { frontmatter: {}, body: content }
  }
  const frontmatterStr = content.slice(3, endIndex).trim()
  const body = content.slice(endIndex + 3).trim()

  const frontmatter: FrontmatterFields = {}
  for (const line of frontmatterStr.split("\n")) {
    if (!line.includes(":")) continue
    const [key, ...valueParts] = line.split(":")
    const value = valueParts.join(":").trim().replace(/^["']|["']$/g, "")
    const k = key.trim() as keyof FrontmatterFields
    if (k === "title" || k === "description" || k === "tags" || k === "slug" || k === "rkey") {
      frontmatter[k] = value
    }
  }
  return { frontmatter, body }
}

async function createSession(
  pds: string,
  handle: string,
  appPassword: string
): Promise<{ accessJwt: string; did: string }> {
  const response = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  })
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as { accessJwt: string; did: string }
  return { accessJwt: data.accessJwt, did: data.did }
}

async function publishDocument(opts: PublishOptions): Promise<PublishResult> {
  const config = loadConfig()
  loadCredentials("bsky", config)

  const pds = process.env.ATPROTO_PDS || "https://bsky.social"
  const handle = process.env.ATPROTO_HANDLE
  const appPassword = process.env.ATPROTO_APP_PASSWORD

  if (!handle || !appPassword) {
    return {
      success: false,
      error: "Missing ATPROTO_HANDLE or ATPROTO_APP_PASSWORD environment variables",
    }
  }

  // Resolve content + metadata
  let body: string
  let title = opts.title
  let description = opts.description
  let tagsRaw = opts.tags
  let slug = opts.slug
  let rkey = opts.rkey

  if (opts.file) {
    if (!existsSync(opts.file)) {
      return { success: false, error: `File not found: ${opts.file}` }
    }
    const fileContent = readFileSync(opts.file, "utf-8")
    const parsed = extractFrontmatter(fileContent)
    body = parsed.body
    title = title ?? parsed.frontmatter.title
    description = description ?? parsed.frontmatter.description
    tagsRaw = tagsRaw ?? parsed.frontmatter.tags
    slug = slug ?? parsed.frontmatter.slug
    rkey = rkey ?? parsed.frontmatter.rkey
  } else if (opts.content) {
    body = opts.content
  } else {
    return { success: false, error: "No content provided (use --file or --content)" }
  }

  if (!title) {
    return { success: false, error: "No title provided (use --title or frontmatter)" }
  }

  // Defaults
  if (!slug) slug = slugify(title)
  if (!rkey) rkey = generateTid()
  const publicationUri = opts.publication ?? process.env.PUBLICATION_URI ?? DEFAULT_PUBLICATION_URI

  // Build blocks + content
  const blocks = markdownToBlocks(body)
  if (blocks.length === 0) {
    return { success: false, error: "No content blocks parsed from body" }
  }
  const textContent = blocksToTextContent(blocks)

  // Tags array (comma-separated → trimmed array, drop empties)
  const tags = tagsRaw
    ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean)
    : undefined

  const now = new Date().toISOString()

  const record: SiteStandardDocument = {
    $type: "site.standard.document",
    site: publicationUri,
    title,
    publishedAt: now,
    path: `/${slug}`,
    textContent,
    content: {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          id: generateUuidV7(),
          blocks,
        },
      ],
    },
  }
  if (description) record.description = description
  if (tags && tags.length > 0) record.tags = tags

  if (opts.dryRun) {
    return {
      success: true,
      record,
      rkey,
    }
  }

  try {
    const session = await createSession(pds, handle, appPassword)
    const response = await fetch(`${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: session.did,
        collection: "site.standard.document",
        rkey,
        record,
      }),
    })

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to publish: ${response.status} ${await response.text()}`,
      }
    }

    const result = (await response.json()) as { uri: string; cid: string }
    // Construct rendered URL on Leaflet's appview.
    // Pattern: leaflet.pub/lish/{did}/{publication-rkey}/{document-rkey}
    // Requires a matching pub.leaflet.publication record at {publication-rkey}.
    const pubRkey = publicationUri.split("/").pop() ?? ""
    const url = `https://leaflet.pub/lish/${session.did}/${pubRkey}/${rkey}`
    return {
      success: true,
      uri: result.uri,
      cid: result.cid,
      rkey,
      url,
      record,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function publish(opts: PublishOptions): Promise<void> {
  const result = await publishDocument(opts)

  if (opts.dryRun) {
    if (!result.success) {
      console.error(`Error: ${result.error}`)
      process.exit(1)
    }
    console.log("[dry-run] rkey:", result.rkey)
    console.log("[dry-run] record:")
    console.log(JSON.stringify(result.record, null, 2))
    process.exit(0)
  }

  if (result.success) {
    console.log(`Published.`)
    console.log(`URI: ${result.uri}`)
    console.log(`CID: ${result.cid}`)
    console.log(`rkey: ${result.rkey}`)
    if (result.url) {
      console.log(`URL: ${result.url}`)
    }
    process.exit(0)
  } else {
    console.error(`Error: ${result.error}`)
    process.exit(1)
  }
}
