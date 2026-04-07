/**
 * X (Twitter) platform implementation.
 * Uses twitter-api-v2 npm package.
 * Posts via OAuth 1.0a (free tier requires user context).
 */

import { TwitterApi } from "twitter-api-v2"
import type {
  SocialPlatform,
  PostOpts,
  PostResult,
  Notification,
  NotificationMedia,
  NotifOpts,
  SearchResult,
  FeedItem,
  RateLimitInfo,
  ProfileInfo,
} from "./types.js"
import { loadConfig, loadCredentials } from "../config.js"
import { withRetry } from "../util/retry.js"

let _client: TwitterApi | null = null

function getClient(): TwitterApi {
  if (_client) return _client

  const config = loadConfig()
  loadCredentials("x", config)

  const apiKey = process.env.X_API_KEY
  const apiSecret = process.env.X_API_SECRET
  const accessToken = process.env.X_ACCESS_TOKEN
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    throw new Error("X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET required")
  }

  _client = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret: accessTokenSecret,
  })

  return _client
}

export const x: SocialPlatform = {
  name: "x",

  async post(text: string, _opts?: PostOpts): Promise<PostResult> {
    const client = getClient()
    const res = await withRetry(() => client.v2.tweet(text))
    return {
      platform: "x",
      id: res.data.id,
      text: res.data.text,
    }
  },

  async reply(targetId: string, text: string, _opts?: PostOpts): Promise<PostResult> {
    const client = getClient()
    const res = await withRetry(() => client.v2.reply(text, targetId))
    return {
      platform: "x",
      id: res.data.id,
      text: res.data.text,
    }
  },

  async thread(posts: string[], replyTo?: string): Promise<PostResult[]> {
    const client = getClient()
    const results: PostResult[] = []
    let currentReplyTo = replyTo

    for (const text of posts) {
      const res = await withRetry(() =>
        currentReplyTo ? client.v2.reply(text, currentReplyTo) : client.v2.tweet(text),
      )

      results.push({
        platform: "x",
        id: res.data.id,
        text: res.data.text,
      })
      currentReplyTo = res.data.id
    }

    return results
  },

  async notifications(opts?: NotifOpts): Promise<{ notifications: Notification[]; cursor?: string }> {
    const client = getClient()
    const limit = opts?.limit ?? 20

    // X uses mentions as the closest equivalent to notifications
    const me = await client.v2.me()
    const params: Record<string, unknown> = {
      max_results: Math.min(limit, 100),
      "tweet.fields": ["created_at", "author_id", "conversation_id", "attachments", "referenced_tweets"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id", "referenced_tweets.id.author_id"],
      "media.fields": [
        "media_key",
        "type",
        "url",
        "preview_image_url",
        "alt_text",
        "width",
        "height",
        "variants",
      ],
    }
    // Pass cursor as since_id — X returns only tweets newer than this ID
    if (opts?.cursor) params.since_id = opts.cursor

    const mentions = await withRetry(() => client.v2.userMentionTimeline(me.data.id, params))

    const authors: Record<string, string> = {}
    if (mentions.includes?.users) {
      for (const u of mentions.includes.users) {
        authors[u.id] = u.username
      }
    }

    // Build a map of referenced tweets for thread context
    const tweetsById = new Map<string, { id: string; text: string; authorId: string }>()
    if (mentions.includes?.tweets) {
      for (const t of mentions.includes.tweets) {
        tweetsById.set(t.id, {
          id: t.id,
          text: t.text,
          authorId: t.author_id ?? "",
        })
      }
    }

    const mediaByKey = new Map<string, NotificationMedia>()
    if (mentions.includes?.media) {
      for (const media of mentions.includes.media) {
        mediaByKey.set(media.media_key, {
          mediaKey: media.media_key,
          type: media.type,
          url: media.url,
          previewImageUrl: media.preview_image_url,
          altText: media.alt_text,
          width: media.width,
          height: media.height,
          variants: media.variants?.map((variant) => ({
            contentType: variant.content_type,
            url: variant.url,
            bitRate: variant.bit_rate,
          })),
        })
      }
    }

    const notifs: Notification[] = []
    for (const tweet of mentions.data?.data ?? []) {
      const media = (tweet.attachments?.media_keys ?? [])
        .map((mediaKey) => mediaByKey.get(mediaKey))
        .filter((item): item is NotificationMedia => item !== undefined)

      // Build thread context from referenced tweets (replies)
      const threadContext: { author: string; text: string }[] = []
      const referenced = tweet.referenced_tweets
      if (referenced) {
        // Find the parent tweet (replied_to)
        const parentRef = referenced.find((r) => r.type === "replied_to")
        if (parentRef) {
          const parentTweet = tweetsById.get(parentRef.id)
          if (parentTweet) {
            threadContext.push({
              author: authors[parentTweet.authorId] ?? "unknown",
              text: parentTweet.text,
            })
          }
        }
      }

      notifs.push({
        id: tweet.id,
        platform: "x",
        type: "mention",
        author: authors[tweet.author_id ?? ""] ?? "unknown",
        authorId: tweet.author_id,
        postId: tweet.id,
        text: tweet.text,
        timestamp: tweet.created_at ?? new Date().toISOString(),
        ...(media.length > 0 ? { media } : {}),
        ...(threadContext.length > 0 ? { threadContext } : {}),
      })
    }

    // Use the newest tweet's ID as the cursor for the next call
    const cursor = notifs.length > 0 ? notifs[0].id : undefined
    return { notifications: notifs, cursor }
  },

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const client = getClient()
    const apiLimit = Math.max(10, Math.min(limit, 100))
    const res = await withRetry(() => client.v2.search(query, {
      max_results: apiLimit,
      "tweet.fields": ["created_at", "author_id"],
    }))

    return (res.data?.data ?? []).map((t) => ({
      platform: "x",
      id: t.id,
      author: t.author_id ?? "unknown",
      text: t.text,
      timestamp: t.created_at ?? "",
    }))
  },

  async feed(limit = 50): Promise<FeedItem[]> {
    const client = getClient()
    const me = await client.v2.me()
    const timeline = await withRetry(() => client.v2.homeTimeline({
      max_results: Math.min(limit, 100),
      "tweet.fields": ["created_at", "author_id", "public_metrics"],
    }))

    return (timeline.data?.data ?? []).map((t) => ({
      platform: "x",
      id: t.id,
      author: t.author_id ?? "unknown",
      text: t.text,
      timestamp: t.created_at ?? "",
      likeCount: (t.public_metrics as any)?.like_count ?? 0,
      replyCount: (t.public_metrics as any)?.reply_count ?? 0,
      repostCount: (t.public_metrics as any)?.retweet_count ?? 0,
    }))
  },

  async rateLimitStatus(): Promise<RateLimitInfo> {
    // X rate limits are tracked per-endpoint.
    // Return a reasonable default; real tracking comes later.
    return {
      platform: "x",
      remaining: 50,
      limit: 50,
      resetsAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }
  },

  async delete(targetId: string): Promise<void> {
    const client = getClient()
    await withRetry(() => client.v2.deleteTweet(targetId))
  },

  async like(targetId: string): Promise<void> {
    const client = getClient()
    const me = await client.v2.me()
    await withRetry(() => client.v2.like(me.data.id, targetId))
  },

  async whoami(): Promise<ProfileInfo> {
    const client = getClient()
    const me = await client.v2.me({ "user.fields": ["public_metrics", "name", "username", "description"] })
    return {
      platform: "x",
      handle: me.data.username,
      displayName: me.data.name,
      bio: (me.data as any).description,
      followersCount: (me.data.public_metrics as any)?.followers_count,
      followingCount: (me.data.public_metrics as any)?.following_count,
      postsCount: (me.data.public_metrics as any)?.tweet_count,
    }
  },

  async userPosts(handle: string, limit = 20): Promise<FeedItem[]> {
    const client = getClient()
    const user = await withRetry(() => client.v2.userByUsername(handle))
    if (!user.data) throw new Error(`User not found: ${handle}`)
    const timeline = await withRetry(() => client.v2.userTimeline(user.data.id, {
      max_results: Math.max(10, Math.min(limit, 100)),
      "tweet.fields": ["created_at", "public_metrics"],
    }))
    return (timeline.data?.data ?? []).map((t) => ({
      platform: "x",
      id: t.id,
      author: handle,
      text: t.text,
      timestamp: t.created_at ?? "",
      likeCount: (t.public_metrics as any)?.like_count ?? 0,
      replyCount: (t.public_metrics as any)?.reply_count ?? 0,
      repostCount: (t.public_metrics as any)?.retweet_count ?? 0,
    }))
  },

  async follow(handle: string): Promise<void> {
    const client = getClient()
    const cleanHandle = handle.replace(/^@/, "")
    const target = await withRetry(() => client.v2.userByUsername(cleanHandle))
    if (!target.data) throw new Error(`User not found: ${handle}`)

    const me = await withRetry(() => client.v2.me())

    try {
      await withRetry(() => client.v2.follow(me.data.id, target.data.id))
      return
    } catch (v2Err) {
      try {
        await withRetry(() => client.v1.createFriendship({ user_id: target.data.id, follow: true }))
        return
      } catch (v1Err) {
        const v2Msg = v2Err instanceof Error ? v2Err.message : String(v2Err)
        const v1Msg = v1Err instanceof Error ? v1Err.message : String(v1Err)
        throw new Error(`X follow failed via v2 (${v2Msg}) and v1 (${v1Msg})`)
      }
    }
  },

  async profile(handle: string): Promise<ProfileInfo> {
    const client = getClient()
    const user = await withRetry(() => client.v2.userByUsername(handle, {
      "user.fields": ["public_metrics", "name", "username", "description"],
    }))
    if (!user.data) throw new Error(`User not found: ${handle}`)

    // Fetch relationship via v1 friendships/lookup
    let relationship: { following: boolean; followedBy: boolean } | undefined
    try {
      const friendships = await withRetry(() =>
        client.v1.friendships({ screen_name: handle })
      )
      if (friendships.length > 0) {
        const connections = friendships[0].connections
        relationship = {
          following: connections.includes("following"),
          followedBy: connections.includes("followed_by"),
        }
      }
    } catch {
      // v1 endpoint may not be available; relationship stays undefined
    }

    return {
      platform: "x",
      handle: user.data.username,
      displayName: user.data.name,
      bio: (user.data as any).description,
      followersCount: (user.data.public_metrics as any)?.followers_count,
      followingCount: (user.data.public_metrics as any)?.following_count,
      postsCount: (user.data.public_metrics as any)?.tweet_count,
      relationship,
    }
  },

  // X does not support annotations
}
