/**
 * Bluesky (ATProto) platform implementation.
 * Uses @atproto/api — the official reference SDK.
 */

import { Agent, CredentialSession, RichText, AppBskyFeedPost, ComAtprotoRepoStrongRef } from "@atproto/api"
import { createHash } from "node:crypto"
import type {
  SocialPlatform,
  PostOpts,
  PostResult,
  Notification,
  NotifOpts,
  SearchResult,
  FeedItem,
  RateLimitInfo,
  AnnotateOpts,
  ProfileInfo,
} from "./types.js"
import { loadConfig, loadCredentials } from "../config.js"
import { withRetry } from "../util/retry.js"

let _agent: Agent | null = null
let _session: CredentialSession | null = null
let _credentials: { handle: string; password: string; pds: string } | null = null

function loadBskyCredentials(): { handle: string; password: string; pds: string } {
  if (_credentials) return _credentials
  const config = loadConfig()
  loadCredentials("bsky", config)

  const handle = process.env.ATPROTO_HANDLE ?? process.env.BSKY_USERNAME ?? config.accounts.bsky?.handle
  const password = process.env.ATPROTO_APP_PASSWORD ?? process.env.BSKY_PASSWORD
  const pds = process.env.ATPROTO_PDS ?? process.env.PDS_URI ?? config.accounts.bsky?.pds ?? "https://bsky.social"

  if (!handle || !password) {
    throw new Error("ATPROTO_HANDLE and ATPROTO_APP_PASSWORD (or BSKY_USERNAME/BSKY_PASSWORD) required")
  }

  _credentials = { handle, password, pds }
  return _credentials
}

async function getAgent(): Promise<Agent> {
  const creds = loadBskyCredentials()

  if (_agent && _session) {
    // Check if session is still active. CredentialSession tracks this.
    if (_session.hasSession) return _agent
    // Session expired — try refresh, fall back to re-login
    try {
      await _session.refreshSession()
      return _agent!
    } catch {
      _agent = null
      _session = null
    }
  }

  _session = new CredentialSession(new URL(creds.pds))
  await _session.login({ identifier: creds.handle, password: creds.password })
  _agent = new Agent(_session)
  return _agent
}

/** Wrap an API call with session recovery + retry. */
async function withSession<T>(fn: (agent: Agent) => Promise<T>): Promise<T> {
  return withRetry(async () => {
    try {
      const agent = await getAgent()
      return await fn(agent)
    } catch (err: any) {
      // Session expired mid-request — force re-auth on next attempt
      if (err?.status === 401 || err?.error === "ExpiredToken") {
        _agent = null
        _session = null
      }
      throw err
    }
  })
}

export const bluesky: SocialPlatform = {
  name: "bsky",

  async post(text: string, opts?: PostOpts): Promise<PostResult> {
    return withSession(async (agent) => {
      const rt = new RichText({ text })
      await rt.detectFacets(agent)

      let embed: any = undefined
      if (opts?.quoteId) {
        const quoted = (await agent.app.bsky.feed.getPosts({ uris: [opts.quoteId] })).data.posts[0]
        if (quoted) {
          embed = {
            $type: "app.bsky.embed.record",
            record: { cid: quoted.cid, uri: quoted.uri },
          }
        }
      }

      const res = await agent.post({ text: rt.text, facets: rt.facets, embed })
      return { platform: "bsky", id: res.uri, uri: res.uri, text }
    })
  },

  async reply(targetId: string, text: string, opts?: PostOpts): Promise<PostResult> {
    return withSession(async (agent) => {
      const rt = new RichText({ text })
      await rt.detectFacets(agent)

      // Fetch parent post to build reply ref
      const parent = (await agent.app.bsky.feed.getPosts({ uris: [targetId] })).data.posts[0]
      if (!parent) throw new Error(`Post not found: ${targetId}`)

      const parentRef = { cid: parent.cid, uri: parent.uri }
      const record = parent.record as AppBskyFeedPost.Record
      const rootRef = record.reply?.root ?? parentRef

      const res = await agent.post({
        text: rt.text,
        facets: rt.facets,
        reply: { parent: parentRef, root: rootRef },
      })

      return { platform: "bsky", id: res.uri, uri: res.uri, text }
    })
  },

  async thread(posts: string[]): Promise<PostResult[]> {
    // Thread uses withSession for initial auth, but individual posts
    // are retried individually to avoid re-posting successful ones.
    const agent = await getAgent()
    const results: PostResult[] = []
    let parentRef: ComAtprotoRepoStrongRef.Main | null = null
    let rootRef: ComAtprotoRepoStrongRef.Main | null = null

    for (const text of posts) {
      const rt = new RichText({ text })
      await rt.detectFacets(agent)

      const postData: any = { text: rt.text, facets: rt.facets }
      if (parentRef && rootRef) {
        postData.reply = { parent: parentRef, root: rootRef }
      }

      const res = await withRetry(() => agent.post(postData))
      const ref = { cid: res.cid, uri: res.uri }

      if (!rootRef) rootRef = ref
      parentRef = ref

      results.push({ platform: "bsky", id: res.uri, uri: res.uri, text })
    }

    return results
  },

  async notifications(opts?: NotifOpts): Promise<{ notifications: Notification[]; cursor?: string }> {
    return withSession(async (agent) => {
    const limit = opts?.limit ?? 50
    const params: Record<string, unknown> = { limit }
    if (opts?.cursor) params.cursor = opts.cursor
    const res = await agent.app.bsky.notification.listNotifications(params)

    const notifs: Notification[] = []
    for (const n of res.data.notifications) {
      // Skip passive engagement
      if (n.reason === "like" || n.reason === "repost") continue
      if (opts?.unreadOnly && n.isRead) continue

      const record = n.record as any
      const item: Notification = {
        id: n.uri,
        platform: "bsky",
        type: n.reason,
        author: n.author.handle,
        authorId: n.author.did,
        postId: n.uri,
        text: record?.text ?? "",
        timestamp: n.indexedAt,
      }

      // Fetch thread context for replies/quotes/mentions
      if (["reply", "quote", "mention"].includes(n.reason)) {
        try {
          const threadRes = await agent.app.bsky.feed.getPostThread({
            uri: n.uri,
            depth: 0,
            parentHeight: 5,
          })
          const context: { author: string; text: string }[] = []
          let curr = threadRes.data.thread as any
          while (curr?.parent) {
            curr = curr.parent
            if (curr?.post?.record?.text) {
              context.unshift({
                author: curr.post.author.handle,
                text: curr.post.record.text,
              })
            }
          }
          if (context.length > 0) item.threadContext = context
        } catch {
          // Thread context is best-effort
        }
      }

      notifs.push(item)
    }

    return { notifications: notifs, cursor: res.data.cursor }
    })
  },

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    return withSession(async (agent) => {
      const res = await agent.app.bsky.feed.searchPosts({ q: query, limit })
      return res.data.posts.map((p) => ({
        platform: "bsky",
        id: p.uri,
        author: p.author.handle,
        text: (p.record as any).text ?? "",
        timestamp: p.indexedAt,
      }))
    })
  },

  async feed(limit = 50): Promise<FeedItem[]> {
    return withSession(async (agent) => {
      const res = await agent.getTimeline({ limit })
      return res.data.feed.map((item) => ({
        platform: "bsky",
        id: item.post.uri,
        author: item.post.author.handle,
        text: (item.post.record as any).text ?? "",
        timestamp: item.post.indexedAt,
        likeCount: item.post.likeCount ?? 0,
        replyCount: item.post.replyCount ?? 0,
        repostCount: item.post.repostCount ?? 0,
      }))
    })
  },

  async rateLimitStatus(): Promise<RateLimitInfo> {
    // ATProto doesn't expose rate limits the same way.
    // Return a generous default. Real limits are per-PDS.
    return {
      platform: "bsky",
      remaining: 100,
      limit: 100,
      resetsAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }
  },

  async annotate(targetId: string, text: string, opts?: AnnotateOpts): Promise<PostResult> {
    return withSession(async (agent) => {
    // Convert AT-URI to bsky.app HTTP URL for Margin compatibility
    let targetUri = targetId
    if (targetUri.startsWith("at://")) {
      const parts = targetUri.replace("at://", "").split("/")
      if (parts.length >= 3) {
        targetUri = `https://bsky.app/profile/${parts[0]}/post/${parts[2]}`
      }
    }

    const sourceHash = createHash("sha256").update(targetUri).digest("hex")
    const record: Record<string, any> = {
      $type: "at.margin.annotation",
      createdAt: new Date().toISOString(),
      target: {
        source: targetUri,
        sourceHash,
      },
      body: { value: text },
      motivation: opts?.motivation ?? "commenting",
    }

    if (opts?.quote) {
      record.target.selector = {
        type: "TextQuoteSelector",
        exact: opts.quote,
      }
    }

    const session = (agent as any).session ?? (agent as any)._session
    const did = agent.did ?? session?.did
    if (!did) throw new Error("Cannot determine DID for annotation")

    const res = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: "at.margin.annotation",
      record,
    })

    return { platform: "bsky", id: res.data.uri, uri: res.data.uri, text }
    })
  },

  async delete(targetId: string): Promise<void> {
    return withSession(async (agent) => {
      // AT-URI format: at://did/collection/rkey
      if (!targetId.startsWith("at://")) {
        throw new Error("Bluesky delete requires an AT-URI (at://...)")
      }
      const parts = targetId.replace("at://", "").split("/")
      if (parts.length < 3) throw new Error(`Invalid AT-URI: ${targetId}`)
      const [repo, collection, rkey] = parts
      await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey })
    })
  },

  async like(targetId: string): Promise<void> {
    return withSession(async (agent) => {
      const posts = await agent.app.bsky.feed.getPosts({ uris: [targetId] })
      const post = posts.data.posts[0]
      if (!post) throw new Error(`Post not found: ${targetId}`)
      await agent.like(post.uri, post.cid)
    })
  },

  async whoami(): Promise<ProfileInfo> {
    return withSession(async (agent) => {
      const profile = await agent.app.bsky.actor.getProfile({ actor: agent.did! })
      return {
        platform: "bsky",
        handle: profile.data.handle,
        displayName: profile.data.displayName,
        bio: profile.data.description,
        did: profile.data.did,
        followersCount: profile.data.followersCount,
        followingCount: profile.data.followsCount,
        postsCount: profile.data.postsCount,
      }
    })
  },

  async userPosts(handle: string, limit = 20): Promise<FeedItem[]> {
    return withSession(async (agent) => {
      const res = await agent.app.bsky.feed.getAuthorFeed({ actor: handle, limit })
      return res.data.feed.map((item) => ({
        platform: "bsky",
        id: item.post.uri,
        author: item.post.author.handle,
        text: (item.post.record as any).text ?? "",
        timestamp: item.post.indexedAt,
        likeCount: item.post.likeCount ?? 0,
        replyCount: item.post.replyCount ?? 0,
        repostCount: item.post.repostCount ?? 0,
      }))
    })
  },

  async profile(handle: string): Promise<ProfileInfo> {
    return withSession(async (agent) => {
      const profile = await agent.app.bsky.actor.getProfile({ actor: handle })
      return {
        platform: "bsky",
        handle: profile.data.handle,
        displayName: profile.data.displayName,
        bio: profile.data.description,
        did: profile.data.did,
        followersCount: profile.data.followersCount,
        followingCount: profile.data.followsCount,
        postsCount: profile.data.postsCount,
      }
    })
  },
}
