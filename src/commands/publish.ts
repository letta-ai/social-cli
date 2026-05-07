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
import { resolve as pathResolve, dirname } from "node:path"
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

interface LeafletByteSlice {
  byteStart: number
  byteEnd: number
}

interface LeafletLinkFeature {
  $type: "pub.leaflet.richtext.facet#link"
  uri: string
}

interface LeafletFacet {
  index: LeafletByteSlice
  features: LeafletLinkFeature[]
}

interface LeafletTextBlock {
  $type: "pub.leaflet.blocks.text"
  plaintext: string
  facets?: LeafletFacet[]
  textSize?: "default" | "small" | "large"
}

interface LeafletHeaderBlock {
  $type: "pub.leaflet.blocks.header"
  level: number
  plaintext: string
  facets?: LeafletFacet[]
}

interface BlobRef {
  $type: "blob"
  ref: { $link: string }
  mimeType: string
  size: number
}

interface LeafletImageBlock {
  $type: "pub.leaflet.blocks.image"
  image: BlobRef
  aspectRatio: { width: number; height: number }
  alt?: string
  fullBleed?: boolean
}

type LeafletBlock = LeafletTextBlock | LeafletHeaderBlock | LeafletImageBlock

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
  return stripMarkdownInline(text).trim()
}

/**
 * Same as stripMarkdown but preserves leading/trailing whitespace.
 * Used by parseInlineWithFacets so concatenating chunks around facet spans
 * doesn't lose the spaces between them.
 */
function stripMarkdownInline(text: string): string {
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
}

/**
 * Inline markdown link parser. Walks `[text](url)` patterns, replaces them
 * with just the visible text, and emits a parallel array of richtext facets
 * with UTF-8 byte offsets for each link span. Other markdown formatting
 * (bold, italic, code) is stripped to plaintext for now.
 *
 * Returns `{ plaintext, facets }`. `facets` is empty if no links are found.
 *
 * UTF-8 byte offset note: Leaflet (and bsky) facets use byte offsets into
 * the UTF-8-encoded plaintext, NOT character/code-point offsets. We use
 * TextEncoder to get the byte length of each chunk as we build the output.
 */
function parseInlineWithFacets(input: string): {
  plaintext: string
  facets: LeafletFacet[]
} {
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
  const encoder = new TextEncoder()
  let plaintext = ""
  let byteOffset = 0
  let lastEnd = 0
  const facets: LeafletFacet[] = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(input)) !== null) {
    const between = input.slice(lastEnd, m.index)
    const stripped = stripMarkdownInline(between)
    plaintext += stripped
    byteOffset += encoder.encode(stripped).length

    const linkText = stripMarkdownInline(m[1])
    const linkUri = m[2]
    const startByte = byteOffset
    plaintext += linkText
    const endByte = startByte + encoder.encode(linkText).length
    byteOffset = endByte

    facets.push({
      index: { byteStart: startByte, byteEnd: endByte },
      features: [{ $type: "pub.leaflet.richtext.facet#link", uri: linkUri }],
    })
    lastEnd = m.index + m[0].length
  }
  // Trailing text after last match. Caller is expected to have trimmed the
  // input already, so internal whitespace is preserved verbatim.
  const tail = stripMarkdownInline(input.slice(lastEnd))
  plaintext += tail
  return { plaintext, facets }
}

/**
 * Read PNG/JPEG/WebP image headers to extract width, height, and mimeType.
 * Throws if the format isn't recognized. Supports the common cases without
 * pulling in a dependency.
 */
function getImageInfo(data: Buffer): {
  width: number
  height: number
  mime: string
} {
  // PNG: 8-byte signature, then IHDR chunk at bytes 8-23 (width @ 16, height @ 20)
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      mime: "image/png",
    }
  }
  // JPEG: starts FFD8, scan for SOFn marker (FFC0..FFCF except DHT/DAC/DRI)
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i < data.length - 8) {
      if (data[i] !== 0xff) {
        i++
        continue
      }
      const marker = data[i + 1]
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSOF) {
        return {
          height: data.readUInt16BE(i + 5),
          width: data.readUInt16BE(i + 7),
          mime: "image/jpeg",
        }
      }
      // Skip this segment
      const segLen = data.readUInt16BE(i + 2)
      i += 2 + segLen
    }
  }
  // WebP: "RIFF....WEBP" header, then VP8 / VP8L / VP8X chunk
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    const subtype = data.toString("ascii", 12, 16)
    if (subtype === "VP8X") {
      const width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
      const height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
      return { width, height, mime: "image/webp" }
    }
    if (subtype === "VP8L") {
      const b0 = data[21]
      const b1 = data[22]
      const b2 = data[23]
      const b3 = data[24]
      const width = (((b1 & 0x3f) << 8) | b0) + 1
      const height = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1
      return { width, height, mime: "image/webp" }
    }
    if (subtype === "VP8 ") {
      const width = data.readUInt16LE(26) & 0x3fff
      const height = data.readUInt16LE(28) & 0x3fff
      return { width, height, mime: "image/webp" }
    }
  }
  throw new Error("Unsupported image format (only PNG, JPEG, WebP)")
}

/**
 * Upload a blob to the agent's PDS via com.atproto.repo.uploadBlob.
 * Returns the BlobRef that can be embedded in a record.
 */
async function uploadBlob(
  pds: string,
  accessJwt: string,
  data: Buffer,
  mime: string
): Promise<BlobRef> {
  const response = await fetch(`${pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      "Content-Type": mime,
    },
    body: data,
  })
  if (!response.ok) {
    throw new Error(`uploadBlob failed: ${response.status} ${await response.text()}`)
  }
  const result = (await response.json()) as { blob: BlobRef }
  return result.blob
}

/**
 * Convert a markdown body to an array of Leaflet page-blocks.
 *
 * Supports:
 * - ATX headings (`# heading`) → pub.leaflet.blocks.header
 * - Paragraphs (everything else, separated by blank lines) → pub.leaflet.blocks.text
 * - Inline links `[text](url)` → richtext facets on text/header blocks
 * - Standalone image lines `![alt](path)` → pub.leaflet.blocks.image
 *   (path resolved relative to `basePath`; blob uploaded to PDS)
 *
 * Other markdown (bold, italic, code, lists, blockquotes, code blocks) is
 * stripped to plaintext for now.
 */
async function markdownToBlocks(
  markdown: string,
  opts: { pds: string; accessJwt: string; basePath: string }
): Promise<LeafletPageBlock[]> {
  const blocks: LeafletPageBlock[] = []
  // Split on blank lines (one or more newlines with only whitespace between)
  const paragraphs = markdown.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)

  for (const para of paragraphs) {
    // Standalone image: ![alt](path) — must be the entire paragraph
    const imageMatch = para.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (imageMatch) {
      const alt = imageMatch[1]
      const imgRelPath = imageMatch[2]
      const imgAbsPath = imgRelPath.startsWith("/")
        ? imgRelPath
        : pathResolve(opts.basePath, imgRelPath)
      if (!existsSync(imgAbsPath)) {
        throw new Error(`Image not found: ${imgAbsPath} (from \`${imgRelPath}\`)`)
      }
      const imgData = readFileSync(imgAbsPath)
      const info = getImageInfo(imgData)
      const blob = await uploadBlob(opts.pds, opts.accessJwt, imgData, info.mime)
      const imageBlock: LeafletImageBlock = {
        $type: "pub.leaflet.blocks.image",
        image: blob,
        aspectRatio: { width: info.width, height: info.height },
      }
      if (alt) imageBlock.alt = alt
      blocks.push({
        $type: "pub.leaflet.pages.linearDocument#block",
        block: imageBlock,
      })
      continue
    }

    // Heading? ATX form: 1-6 #s + space + text
    const headingMatch = para.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (headingMatch && !para.includes("\n")) {
      const { plaintext, facets } = parseInlineWithFacets(headingMatch[2])
      const headerBlock: LeafletHeaderBlock = {
        $type: "pub.leaflet.blocks.header",
        level: headingMatch[1].length,
        plaintext,
      }
      if (facets.length > 0) headerBlock.facets = facets
      blocks.push({
        $type: "pub.leaflet.pages.linearDocument#block",
        block: headerBlock,
      })
      continue
    }
    // Otherwise: text block. Collapse internal newlines to single space.
    const flat = para.replace(/\s*\n\s*/g, " ").trim()
    const { plaintext, facets } = parseInlineWithFacets(flat)
    const textBlock: LeafletTextBlock = {
      $type: "pub.leaflet.blocks.text",
      plaintext,
    }
    if (facets.length > 0) textBlock.facets = facets
    blocks.push({
      $type: "pub.leaflet.pages.linearDocument#block",
      block: textBlock,
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

/**
 * Fetch a site.standard.publication record and return its `url` field, if any.
 * Used to construct rendered document URLs that match the publisher's chosen
 * domain (e.g. sensemaker.leaflet.pub) rather than the deep permalink.
 *
 * Parses an at-uri of the form at://{did}/{collection}/{rkey} and calls
 * com.atproto.repo.getRecord on the appropriate PDS. Returns null on any
 * error so callers can fall back to the deep permalink.
 */
async function fetchPublicationUrl(pds: string, publicationUri: string): Promise<string | null> {
  const match = publicationUri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  const [, repo, collection, rkey] = match
  const params = new URLSearchParams({ repo, collection, rkey })
  const response = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
  if (!response.ok) return null
  const data = (await response.json()) as { value?: { url?: string } }
  return data.value?.url ?? null
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
  const publicationUri = opts.publication ?? process.env.LEAFLET_PUBLICATION_URI
  if (!publicationUri) {
    return {
      success: false,
      error:
        "No publication specified. Pass --publication <at-uri> or set LEAFLET_PUBLICATION_URI env var. " +
        "Create a publication at https://leaflet.pub/new and find its AT-URI in your PDS.",
    }
  }

  // Establish session early so we can upload image blobs while parsing.
  // (Skipped in dry-run; image blocks would require an upload, so we error
  // on dry-run with images for now.)
  const session = opts.dryRun
    ? null
    : await createSession(pds, handle, appPassword)

  // Resolve a base path for relative image references. If publishing from a
  // file, that's the file's directory; otherwise, current working directory.
  const basePath = opts.file ? dirname(pathResolve(opts.file)) : process.cwd()

  // Build blocks + content. If the body contains image lines but we're in
  // dry-run mode, fall back: emit a warning and skip blob upload by using a
  // placeholder accessJwt (markdownToBlocks will throw on actual upload).
  let blocks: LeafletPageBlock[]
  try {
    blocks = await markdownToBlocks(body, {
      pds,
      accessJwt: session?.accessJwt ?? "",
      basePath,
    })
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
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

  // Session was created above (skipped only in dry-run, which returns earlier).
  if (!session) {
    return { success: false, error: "Internal error: missing session for write" }
  }
  try {
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
    // Construct rendered URL. Prefer the publication's own `url` field
    // (typically a Leaflet subdomain like sensemaker.leaflet.pub or a
    // custom domain) so the link points at the publisher's chosen home.
    // Fall back to the deep /lish/{did}/{pub-rkey}/{doc-rkey} permalink
    // if the publication record doesn't expose a URL or can't be fetched.
    const pubRkey = publicationUri.split("/").pop() ?? ""
    const fallbackUrl = `https://leaflet.pub/lish/${session.did}/${pubRkey}/${rkey}`
    const pubDomain = await fetchPublicationUrl(pds, publicationUri).catch(() => null)
    const url = pubDomain ? `${pubDomain.replace(/\/$/, "")}/${rkey}` : fallbackUrl
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
