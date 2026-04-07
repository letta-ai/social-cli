/**
 * blog: Publish long-form content to GreenGale (app.greengale.document)
 */

import { readFileSync, existsSync } from "node:fs"
import { basename } from "node:path"
import { loadConfig, loadCredentials } from "../config.js"

interface BlogOptions {
  title: string
  slug?: string
  subtitle?: string
  content?: string
  file?: string
  platform?: string
}

interface GreenGaleRecord {
  $type: "app.greengale.document"
  title: string
  content: string
  url: string
  path: string
  publishedAt: string
  theme: { preset: string }
  visibility: string
  subtitle?: string
}

interface PublishResult {
  success: boolean
  uri?: string
  cid?: string
  url?: string
  error?: string
}

function extractFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content }
  }

  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterStr = content.slice(3, endIndex).trim()
  const body = content.slice(endIndex + 3).trim()

  const frontmatter: Record<string, string> = {}
  for (const line of frontmatterStr.split("\n")) {
    if (line.includes(":")) {
      const [key, ...valueParts] = line.split(":")
      const value = valueParts.join(":").trim().replace(/^["']|["']$/g, "")
      frontmatter[key.trim()] = value
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
    body: JSON.stringify({
      identifier: handle,
      password: appPassword,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`)
  }

  const data = await response.json()
  return {
    accessJwt: (data as any).accessJwt,
    did: (data as any).did,
  }
}

async function publishToGreenGale(options: BlogOptions): Promise<PublishResult> {
  // Load config and credentials
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

  // Get content
  let content: string
  let title = options.title
  let slug = options.slug

  if (options.file) {
    if (!existsSync(options.file)) {
      return { success: false, error: `File not found: ${options.file}` }
    }
    const fileContent = readFileSync(options.file, "utf-8")
    const { frontmatter, body } = extractFrontmatter(fileContent)
    content = body
    if (!title && frontmatter.title) title = frontmatter.title
    if (!slug && frontmatter.slug) slug = frontmatter.slug
    if (!slug) {
      // Generate slug from filename
      slug = basename(options.file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")
    }
  } else if (options.content) {
    content = options.content
  } else {
    return { success: false, error: "No content provided (use --file or --content)" }
  }

  if (!title) {
    return { success: false, error: "No title provided (use --title or frontmatter)" }
  }

  if (!slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  }

  try {
    const session = await createSession(pds, handle, appPassword)

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    const record: GreenGaleRecord = {
      $type: "app.greengale.document",
      title,
      content,
      url: `https://greengale.app/${handle}/${slug}`,
      path: `/${handle}/${slug}`,
      publishedAt: now,
      theme: { preset: "github-dark" },
      visibility: "public",
    }

    if (options.subtitle) {
      record.subtitle = options.subtitle
    }

    const response = await fetch(`${pds}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.greengale.document",
        rkey: slug,
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

    return {
      success: true,
      uri: result.uri,
      cid: result.cid,
      url: `https://greengale.app/${handle}/${slug}`,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function blog(opts: BlogOptions): Promise<void> {
  const result = await publishToGreenGale(opts)

  if (result.success) {
    console.log(`Published: ${result.url}`)
    console.log(`URI: ${result.uri}`)
    console.log(`CID: ${result.cid}`)
    process.exit(0)
  } else {
    console.error(`Error: ${result.error}`)
    process.exit(1)
  }
}
