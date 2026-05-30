/**
 * X (Twitter) platform implementation.
 * Uses twitter-api-v2 npm package.
 * Posts via OAuth 1.0a (free tier requires user context).
 */

import { TwitterApi, type TweetV2, type UserV2 } from "twitter-api-v2"
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
  ThreadOpts,
} from "./types.js"
import { loadConfig, loadCredentials } from "../config.js"
import { withRetry } from "../util/retry.js"
import { normalizeXMediaV2 } from "../util/media.js"

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

const X_CONTEXT_TWEET_FIELDS = ["created_at", "author_id", "conversation_id", "referenced_tweets"] as const
const X_CONTEXT_EXPANSIONS = ["author_id", "referenced_tweets.id", "referenced_tweets.id.author_id"] as const
const MAX_THREAD_CONTEXT_DEPTH = 5

type XContextTweet = Pick<TweetV2, "id" | "text" | "author_id" | "conversation_id" | "referenced_tweets">

function addUsersToAuthorMap(authors: Record<string, string>, users?: UserV2[]): void {
  if (!users) return
  for (const user of users) {
    authors[user.id] = user.username
  }
}

function addTweetsToMap(tweetsById: Map<string, XContextTweet>, tweets?: TweetV2[]): void {
  if (!tweets) return
  for (const tweet of tweets) {
    tweetsById.set(tweet.id, {
      id: tweet.id,
      text: tweet.text,
      author_id: tweet.author_id,
      conversation_id: tweet.conversation_id,
      referenced_tweets: tweet.referenced_tweets,
    })
  }
}

function repliedToId(tweet: Pick<TweetV2, "referenced_tweets">): string | undefined {
  return tweet.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id
}

function quotedId(tweet: Pick<TweetV2, "referenced_tweets">): string | undefined {
  return tweet.referenced_tweets?.find((ref) => ref.type === "quoted")?.id
}

function toContextEntry(
  tweet: Pick<TweetV2, "id" | "text" | "author_id">,
  authors: Record<string, string>,
): { id: string; author: string; text: string } {
  return {
    id: tweet.id,
    author: authors[tweet.author_id ?? ""] ?? "unknown",
    text: tweet.text,
  }
}

async function hydrateContextTweets(
  client: TwitterApi,
  ids: string[],
  tweetsById: Map<string, XContextTweet>,
  authors: Record<string, string>,
): Promise<void> {
  const missingIds = [...new Set(ids)].filter((id) => id && !tweetsById.has(id))
  if (missingIds.length === 0) return

  for (let i = 0; i < missingIds.length; i += 100) {
    const batch = missingIds.slice(i, i + 100)
    const result = await withRetry(() =>
      client.v2.tweets(batch, {
        "tweet.fields": [...X_CONTEXT_TWEET_FIELDS],
        expansions: [...X_CONTEXT_EXPANSIONS],
      }),
    )

    addUsersToAuthorMap(authors, result.includes?.users)
    addTweetsToMap(tweetsById, result.data)
  }
}

function buildReplyContext(
  tweet: Pick<TweetV2, "referenced_tweets">,
  tweetsById: Map<string, XContextTweet>,
  authors: Record<string, string>,
): { id: string; author: string; text: string }[] {
  const chain: { id: string; author: string; text: string }[] = []
  const seen = new Set<string>()
  let currentId = repliedToId(tweet)

  while (currentId && !seen.has(currentId) && chain.length < MAX_THREAD_CONTEXT_DEPTH) {
    seen.add(currentId)
    const current = tweetsById.get(currentId)
    if (!current) break
    chain.unshift(toContextEntry(current, authors))
    currentId = repliedToId(current)
  }

  return chain
}

function buildThreadContext(
  tweet: Pick<TweetV2, "referenced_tweets">,
  tweetsById: Map<string, XContextTweet>,
  authors: Record<string, string>,
): { author: string; text: string }[] {
  const context = buildReplyContext(tweet, tweetsById, authors)
  const seen = new Set(context.map((entry) => entry.id))
  const quoteTweetId = quotedId(tweet)

  if (quoteTweetId) {
    const quoteTweet = tweetsById.get(quoteTweetId)
    if (quoteTweet && !seen.has(quoteTweet.id)) {
      context.push(toContextEntry(quoteTweet, authors))
    }
  }

  return context.map(({ author, text }) => ({ author, text }))
}

import type { SendTweetV2Params } from "twitter-api-v2"

type MediaIds = NonNullable<NonNullable<SendTweetV2Params["media"]>["media_ids"]>

/** Upload media files to X via v1 API and return media IDs for v2 tweets. */
async function uploadMediaX(client: TwitterApi, mediaPaths: string[]): Promise<MediaIds | undefined> {
  // X allows 1-4 media per tweet
  const paths = mediaPaths.slice(0, 4)
  if (paths.length === 0) return undefined

  const mediaIds: string[] = []
  for (const filePath of paths) {
    const mediaId = await withRetry(() => client.v1.uploadMedia(filePath))
    mediaIds.push(mediaId)
  }

  // Cast to the union tuple type X expects
  return mediaIds as unknown as MediaIds
}

export const x: SocialPlatform = {
  name: "x",

  async post(text: string, opts?: PostOpts): Promise<PostResult> {
    const client = getClient()

    const mediaIds = opts?.media && opts.media.length > 0
      ? await uploadMediaX(client, opts.media) : undefined

    const res = await withRetry(() =>
      client.v2.tweet(text, mediaIds ? { media: { media_ids: mediaIds } } : undefined),
    )
    return {
      platform: "x",
      id: res.data.id,
      text: res.data.text,
    }
  },

  async reply(targetId: string, text: string, opts?: PostOpts): Promise<PostResult> {
    const client = getClient()

    const mediaIds = opts?.media && opts.media.length > 0
      ? await uploadMediaX(client, opts.media) : undefined

    const res = await withRetry(() =>
      client.v2.reply(text, targetId, mediaIds ? { media: { media_ids: mediaIds } } : undefined),
    )
    return {
      platform: "x",
      id: res.data.id,
      text: res.data.text,
    }
  },

  async thread(posts: string[], replyTo?: string, opts?: ThreadOpts): Promise<PostResult[]> {
    const client = getClient()
    const results: PostResult[] = []
    let currentReplyTo = replyTo

    // Upload media once, attach to first post only
    const mediaIds = opts?.media && opts.media.length > 0
      ? await uploadMediaX(client, opts.media) : undefined

    for (let idx = 0; idx < posts.length; idx++) {
      const text = posts[idx]
      const mediaForPost = idx === 0 ? mediaIds : undefined

      const res = await withRetry(() =>
        currentReplyTo
          ? client.v2.reply(text, currentReplyTo!, mediaForPost ? { media: { media_ids: mediaForPost } } : undefined)
          : client.v2.tweet(text, mediaForPost ? { media: { media_ids: mediaForPost } } : undefined),
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
      "tweet.fields": [...X_CONTEXT_TWEET_FIELDS, "attachments"],
      expansions: [...X_CONTEXT_EXPANSIONS, "attachments.media_keys"],
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
    addUsersToAuthorMap(authors, mentions.includes?.users)

    const tweetsById = new Map<string, XContextTweet>()
    addTweetsToMap(tweetsById, mentions.includes?.tweets)
    addTweetsToMap(tweetsById, mentions.data?.data)

    let frontier = [...new Set(
      (mentions.data?.data ?? []).flatMap((tweet) => {
        const ids: string[] = []
        const parentId = repliedToId(tweet)
        const quoteTweetId = quotedId(tweet)
        if (parentId && !tweetsById.has(parentId)) ids.push(parentId)
        if (quoteTweetId && !tweetsById.has(quoteTweetId)) ids.push(quoteTweetId)
        return ids
      }),
    )]

    for (let depth = 0; depth < MAX_THREAD_CONTEXT_DEPTH && frontier.length > 0; depth++) {
      await hydrateContextTweets(client, frontier, tweetsById, authors)

      const nextFrontier = new Set<string>()
      for (const tweetId of frontier) {
        const tweet = tweetsById.get(tweetId)
        const parentId = tweet ? repliedToId(tweet) : undefined
        if (parentId && !tweetsById.has(parentId)) nextFrontier.add(parentId)
      }
      frontier = [...nextFrontier]
    }

    const mediaByKey = new Map<string, NotificationMedia>()
    if (mentions.includes?.media) {
      for (const media of mentions.includes.media) {
        mediaByKey.set(media.media_key, normalizeXMediaV2(media))
      }
    }

    const notifs: Notification[] = []
    for (const tweet of mentions.data?.data ?? []) {
      const media = (tweet.attachments?.media_keys ?? [])
        .map((mediaKey) => mediaByKey.get(mediaKey))
        .filter((item): item is NotificationMedia => item !== undefined)

      const threadContext = buildThreadContext(tweet, tweetsById, authors)

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
