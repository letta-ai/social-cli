/**
 * Platform abstraction layer for social-cli.
 * Each platform implements this interface.
 */

export interface PostOpts {
  /** Quote/repost a target post. */
  quoteId?: string
  /** Media attachment paths. */
  media?: string[]
}

export interface PostResult {
  platform: string
  id: string
  uri?: string
  text: string
}

export interface AnnotateOpts {
  /** W3C motivation: commenting, highlighting, describing. */
  motivation?: string
  /** Exact text to anchor the annotation to. */
  quote?: string
}

export interface NotificationMediaVariant {
  contentType: string
  url: string
  bitRate?: number
}

export interface NotificationMedia {
  mediaKey: string
  type: string
  url?: string
  previewImageUrl?: string
  altText?: string
  width?: number
  height?: number
  variants?: NotificationMediaVariant[]
}

export interface Notification {
  id: string
  platform: string
  type: string // reply, mention, quote, follow, like
  author: string
  authorId?: string // permanent ID (DID for Bluesky, user ID for X)
  postId: string
  text: string
  timestamp: string
  threadContext?: { author: string; text: string }[]
  userContext?: string
  media?: NotificationMedia[]
  embed?: EmbedInfo
  /** True if the account owner has blocked this author. */
  blocked?: boolean
}

export interface EmbedInfo {
  type: "external" | "images" | "record" | "recordWithMedia"
  /** External link URL. */
  uri?: string
  /** External link title. */
  title?: string
  /** External link description. */
  description?: string
  /** Attached images. */
  images?: { alt: string; url?: string }[]
  /** Quoted post AT-URI. */
  quotedUri?: string
  /** Quoted post text (truncated). */
  quotedText?: string
  /** Quoted post author handle. */
  quotedAuthor?: string
}

export interface SearchResult {
  platform: string
  id: string
  author: string
  text: string
  timestamp: string
  embed?: EmbedInfo
}

export interface FeedItem {
  platform: string
  id: string
  author: string
  text: string
  timestamp: string
  likeCount?: number
  replyCount?: number
  repostCount?: number
  embed?: EmbedInfo
}

export interface RateLimitInfo {
  platform: string
  remaining: number
  limit: number
  resetsAt: string
}

export interface NotifResult {
  notifications: Notification[]
  /** Opaque cursor to pass back on next call to fetch subsequent pages / newer items. */
  cursor?: string
}

export interface NotifOpts {
  limit?: number
  /** Only fetch unread. */
  unreadOnly?: boolean
  /** Cursor from a previous NotifResult — resumes from that point. */
  cursor?: string
}

export interface ProfileInfo {
  platform: string
  handle: string
  displayName?: string
  bio?: string
  did?: string // ATProto DID
  followersCount?: number
  followingCount?: number
  postsCount?: number
}

export interface SocialPlatform {
  name: string
  post(text: string, opts?: PostOpts): Promise<PostResult>
  reply(targetId: string, text: string, opts?: PostOpts): Promise<PostResult>
  thread(posts: string[]): Promise<PostResult[]>
  notifications(opts?: NotifOpts): Promise<NotifResult>
  search(query: string, limit?: number): Promise<SearchResult[]>
  feed(limit?: number, feedUri?: string): Promise<FeedItem[]>
  rateLimitStatus(): Promise<RateLimitInfo>

  /** Delete a post by ID/URI. */
  delete?(targetId: string): Promise<void>
  /** Like a post by ID/URI. */
  like?(targetId: string): Promise<void>
  /** Get current account info. */
  whoami?(): Promise<ProfileInfo>
  /** Look up a user by handle. */
  profile?(handle: string): Promise<ProfileInfo>
  /** Fetch recent posts by a user. */
  userPosts?(handle: string, limit?: number): Promise<FeedItem[]>
  /** Attach an annotation to a URL/post. Bluesky-specific. */
  annotate?(targetId: string, text: string, opts?: AnnotateOpts): Promise<PostResult>
  /** Follow a user by handle or DID. */
  follow?(handle: string): Promise<void>
  /** Get list of blocked user DIDs. */
  getBlocklist?(): Promise<string[]>
  /** Update profile fields (avatar, display name, bio). */
  updateProfile?(opts: { avatar?: string; displayName?: string; description?: string }): Promise<void>
}

/** Per-platform character limits. */
export const PLATFORM_LIMITS: Record<string, { chars: number; threads: boolean }> = {
  bsky: { chars: 300, threads: true },
  x: { chars: 280, threads: true },
}
