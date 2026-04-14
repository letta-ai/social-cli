#!/usr/bin/env node

/**
 * social-cli: Agent-optimized social media CLI.
 * Bluesky + X. YAML in, YAML out. Exit codes for agents.
 */

import { Command } from "commander"

function resolveUsersDir(): string | undefined {
  if (process.env.MEMORY_DIR) {
    return `${process.env.MEMORY_DIR}/reference/sensemaker/users`
  }
  process.stderr.write("[warn] MEMORY_DIR not set — user context enrichment disabled. This tool is designed for Letta agents with persistent memory.\n")
  return undefined
}

const program = new Command()
  .name("social-cli")
  .description("Agent-optimized social media CLI")
  .version("0.1.0")

// sync: Fetch notifications → inbox.yaml
program
  .command("sync")
  .description("Fetch notifications from platforms → inbox.yaml")
  .option("-p, --platform <platforms...>", "Platforms to sync (default: all)")
  .option("--unread-only", "Only fetch unread notifications", true)
  .option("-n, --limit <number>", "Max notifications per platform", "50")
  .option("-o, --output <file>", "Output file", "inbox.yaml")
  .option("--max-items <number>", "Max inbox items before truncating oldest", "200")
  .option("--users-dir <path>", "Directory of user memory files for context enrichment")
  .option("--auto-create-users", "Create missing user memory files during sync")
  .option("--reset", "Clear cursors and re-fetch all notifications from scratch")
  .option("--clear", "Clear both cursors and the local inbox for a fully fresh start")
  .action(async (opts) => {
    const [{ sync }, { loadConfig }] = await Promise.all([
      import("./commands/sync.js"),
      import("./config.js"),
    ])
    const config = loadConfig()
    await sync({
      platforms: opts.platform,
      unreadOnly: opts.unreadOnly,
      limit: parseInt(opts.limit),
      output: opts.output,
      maxItems: parseInt(opts.maxItems),
      usersDir: opts.usersDir ?? config.sync?.usersDir ?? resolveUsersDir(),
      autoCreateUsers: opts.autoCreateUsers || config.sync?.autoCreateUsers,
      reset: opts.reset,
      clear: opts.clear,
    })
  })

// dispatch: outbox-{platform}.yaml → post to platforms
program
  .command("dispatch")
  .description("Dispatch posts from platform-specific outbox YAML files")
  .argument("[file]", "Outbox file (optional, defaults to platform-specific discovery)")
  .option("-p, --platform <platform>", "Platform to dispatch from (e.g., bsky, x)")
  .option("--dry-run", "Validate only, don't post")
  .action(async (file, opts) => {
    const { dispatch } = await import("./commands/dispatch.js")
    await dispatch({ file, dryRun: opts.dryRun, platform: opts.platform })
  })

// check: Anything actionable? Exit code only.
program
  .command("check")
  .description("Check if inbox has actionable items (exit 0 = yes, 1 = no)")
  .option("-t, --threshold <number>", "Minimum items to trigger", "1")
  .option("-p, --platform <platform>", "Check a specific platform's inbox")
  .action(async (opts) => {
    const { check } = await import("./commands/check.js")
    await check({ threshold: parseInt(opts.threshold), platform: opts.platform })
  })

// search: Search posts
program
  .command("search")
  .description("Search posts on a platform")
  .argument("<query>", "Search query")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-n, --limit <number>", "Max results", "10")
  .action(async (query, opts) => {
    const { search } = await import("./commands/search.js")
    await search(query, {
      platform: opts.platform,
      limit: parseInt(opts.limit),
    })
  })

// feed: Read timeline
program
  .command("feed")
  .description("Fetch timeline or custom feed → feed.yaml")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-n, --limit <number>", "Max posts", "50")
  .option("-o, --output <file>", "Output file", "feed.yaml")
  .option("--feed <uri>", "Feed generator AT-URI (e.g. at://did:plc:.../app.bsky.feed.generator/my-feed)")
  .action(async (opts) => {
    const { feed } = await import("./commands/feed.js")
    await feed({
      platform: opts.platform,
      limit: parseInt(opts.limit),
      output: opts.output,
      feed: opts.feed,
    })
  })

// post: Quick single post
program
  .command("post")
  .description("Post to a platform")
  .argument("<text>", "Text to post")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("--quote <id>", "Quote/repost a post by ID")
  .option("--reply-to <id>", "Post as a reply to this post ID")
  .option("-m, --media <paths...>", "Media file paths to attach")
  .action(async (text, opts) => {
    const { validateText } = await import("./util/validate.js")
    validateText(opts.platform, text)
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (opts.replyTo) {
      const result = await platform.reply(opts.replyTo, text, { quoteId: opts.quote, media: opts.media })
      console.log(`Posted (reply): ${result.id}`)
    } else {
      const result = await platform.post(text, { quoteId: opts.quote, media: opts.media })
      console.log(`Posted: ${result.id}`)
    }
  })

// reply: Quick reply
program
  .command("reply")
  .description("Reply to a post")
  .argument("<text>", "Reply text")
  .requiredOption("--id <id>", "Post ID to reply to")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-m, --media <paths...>", "Media file paths to attach")
  .action(async (text, opts) => {
    const { validateText } = await import("./util/validate.js")
    validateText(opts.platform, text)
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    const result = await platform.reply(opts.id, text, { media: opts.media })
    console.log(`Replied: ${result.id}`)
  })

// thread: Post a thread
program
  .command("thread")
  .description("Post a thread")
  .argument("<posts...>", "Thread posts (each argument is one post)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-m, --media <paths...>", "Media file paths to attach to first post")
  .option("--card", "Auto-generate a branded header card for the first post")
  .option("--card-title <title>", "Title for the card (defaults to first post text)")
  .option("--card-subtitle <subtitle>", "Subtitle for the card")
  .option("--card-pattern <pattern>", "Card pattern: ripple, angular, orbital, grid", "ripple")
  .action(async (posts, opts) => {
    const { validateTexts } = await import("./util/validate.js")
    validateTexts(opts.platform, posts)

    let mediaPaths: string[] = opts.media ?? []

    // Auto-generate a card if --card is set
    if (opts.card) {
      const { execSync } = await import("node:child_process")
      const { resolve, dirname } = await import("node:path")
      const { fileURLToPath } = await import("node:url")
      const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "thread-cards")
      const tmpCard = `/tmp/thread-card-${Date.now()}.png`
      const title = opts.cardTitle ?? posts[0].slice(0, 80)
      const subtitle = opts.cardSubtitle ?? ""
      const pattern = opts.cardPattern ?? "ripple"
      execSync(
        `npx tsx "${scriptDir}/generate-card.ts" --title "${title.replace(/"/g, '\\"')}" --subtitle "${subtitle.replace(/"/g, '\\"')}" --pattern ${pattern} --output "${tmpCard}"`,
        { stdio: "pipe" },
      )
      mediaPaths = [tmpCard, ...mediaPaths]
    }

    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    const results = await platform.thread(posts, undefined, {
      media: mediaPaths.length > 0 ? mediaPaths : undefined,
    })
    for (const r of results) console.log(`Posted: ${r.id}`)
    console.log(`Thread: ${results.length} posts`)
  })

// annotate: Attach annotation to a post
program
  .command("annotate")
  .description("Annotate a URL or post (Bluesky only)")
  .argument("[text]", "Annotation text (optional for bookmarking)")
  .requiredOption("--target <uri>", "URL or AT-URI to annotate")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("--motivation <type>", "W3C motivation", "commenting")
  .option("--quote <text>", "Exact text to anchor to")
  .action(async (text, opts) => {
    const { annotate } = await import("./commands/annotate.js")
    await annotate({
      platform: opts.platform,
      id: opts.target,
      text,
      motivation: opts.motivation,
      quote: opts.quote,
    })
  })

// bookmark: Save a post for later
program
  .command("bookmark")
  .description("Bookmark a post (Bluesky only, via at.margin.note)")
  .requiredOption("--target <uri>", "URL or AT-URI to bookmark")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-t, --text <text>", "Optional note")
  .action(async (opts) => {
    const { annotate } = await import("./commands/annotate.js")
    await annotate({
      platform: opts.platform,
      id: opts.target,
      text: opts.text,
      motivation: "bookmarking",
    })
  })

// highlight: Highlight a passage in a post
program
  .command("highlight")
  .description("Highlight text in a post (Bluesky only, via at.margin.note)")
  .requiredOption("--target <uri>", "URL or AT-URI to highlight")
  .requiredOption("--quote <text>", "Exact text to highlight")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-t, --text <text>", "Optional note about the highlight")
  .action(async (opts) => {
    const { annotate } = await import("./commands/annotate.js")
    await annotate({
      platform: opts.platform,
      id: opts.target,
      text: opts.text,
      motivation: "highlighting",
      quote: opts.quote,
    })
  })

// repost-media: Repost media from an existing post
program
  .command("repost-media")
  .description("Repost media from an existing Bluesky post")
  .argument("<uri>", "AT-URI of the post to repost media from")
  .option("-t, --text <text>", "Optional text to include with the repost")
  .action(async (uri, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync("bsky")
    if (!platform.repostMedia) {
      console.error("repost-media not supported on this platform")
      process.exit(1)
    }
    const result = await platform.repostMedia(uri, opts.text ?? "")
    console.log(`Reposted media: ${result.id}`)
  })

// rate-limits: Show rate limit status
program
  .command("rate-limits")
  .description("Show rate limit status")
  .option("-p, --platform <platforms...>", "Platforms (default: all)")
  .action(async (opts) => {
    const { getPlatformAsync, availablePlatforms } = await import("./platforms/index.js")
    const { stringify } = await import("yaml")
    const platforms = opts.platform ?? availablePlatforms()
    const limits = []
    for (const name of platforms) {
      try {
        const p = await getPlatformAsync(name)
        limits.push(await p.rateLimitStatus())
      } catch {
        // skip unavailable
      }
    }
    process.stdout.write(stringify(limits))
  })

// delete: Delete a post
program
  .command("delete")
  .description("Delete a post by ID/URI")
  .argument("<id>", "Post ID or AT-URI")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (id, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.delete) {
      console.error(`Platform ${opts.platform} does not support delete`)
      process.exit(1)
    }
    await platform.delete(id)
    console.log(`Deleted: ${id}`)
  })

// like: Like a post
program
  .command("like")
  .description("Like a post by ID/URI")
  .argument("<id>", "Post ID or AT-URI")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (id, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.like) {
      console.error(`Platform ${opts.platform} does not support like`)
      process.exit(1)
    }
    await platform.like(id)
    console.log(`Liked: ${id}`)
  })

// whoami: Show current account info
program
  .command("whoami")
  .description("Show current account info")
  .option("-p, --platform <platforms...>", "Platforms (default: all)")
  .action(async (opts) => {
    const { getPlatformAsync, availablePlatforms } = await import("./platforms/index.js")
    const { stringify } = await import("yaml")
    const platforms = opts.platform ?? availablePlatforms()
    const profiles = []
    for (const name of platforms) {
      try {
        const p = await getPlatformAsync(name)
        if (p.whoami) profiles.push(await p.whoami())
      } catch {
        // skip unavailable
      }
    }
    process.stdout.write(stringify(profiles))
  })

// posts: Fetch a user's recent posts
program
  .command("posts")
  .description("Fetch recent posts by a user")
  .argument("<handle>", "User handle (e.g. cameron.stream, @cameron_pfiffer)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-n, --limit <number>", "Max posts", "20")
  .action(async (handle, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const { stringify } = await import("yaml")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.userPosts) {
      console.error(`Platform ${opts.platform} does not support user posts`)
      process.exit(1)
    }
    const cleanHandle = handle.replace(/^@/, "")
    const posts = await platform.userPosts(cleanHandle, parseInt(opts.limit))
    process.stdout.write(stringify(posts, { lineWidth: 120 }))
  })

// follow: Follow a user
program
  .command("follow")
  .description("Follow a user by handle")
  .argument("<handle>", "User handle (e.g. cameron.stream, @cpfiffer.bsky.social)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (handle, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.follow) {
      console.error(`Platform ${opts.platform} does not support follow`)
      process.exit(1)
    }
    const cleanHandle = handle.replace(/^@/, "")
    await platform.follow(cleanHandle)
    console.log(`Followed: ${cleanHandle}`)
  })

// block: Block a user
program
  .command("block")
  .description("Block a user by handle")
  .argument("<handle>", "User handle (e.g. spam.bsky.social, @spam.bsky.social)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (handle, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.block) {
      console.error(`Platform ${opts.platform} does not support block`)
      process.exit(1)
    }
    const cleanHandle = handle.replace(/^@/, "")
    await platform.block(cleanHandle)
    console.log(`Blocked: ${cleanHandle}`)
  })

// profile: Look up a user
program
  .command("profile")
  .description("Look up a user by handle")
  .argument("<handle>", "User handle (e.g. cameron.stream, @cameron_pfiffer)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (handle, opts) => {
    const { getPlatformAsync } = await import("./platforms/index.js")
    const { stringify } = await import("yaml")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.profile) {
      console.error(`Platform ${opts.platform} does not support profile lookup`)
      process.exit(1)
    }
    // Strip leading @ if present
    const cleanHandle = handle.replace(/^@/, "")
    const info = await platform.profile(cleanHandle)
    process.stdout.write(stringify(info))
  })

// update-profile: Update profile fields
program
  .command("update-profile")
  .description("Update profile (avatar, display name, bio)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("--avatar <path>", "Path to avatar image (png/jpg/webp)")
  .option("--display-name <name>", "Display name")
  .option("--bio <text>", "Bio / description")
  .action(async (opts) => {
    if (!opts.avatar && opts.displayName === undefined && opts.bio === undefined) {
      console.error("At least one of --avatar, --display-name, or --bio is required")
      process.exit(1)
    }
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    if (!platform.updateProfile) {
      console.error(`Platform ${opts.platform} does not support profile updates`)
      process.exit(1)
    }
    await platform.updateProfile({
      avatar: opts.avatar,
      displayName: opts.displayName,
      description: opts.bio,
    })
    console.log("Profile updated.")
  })

// semble: Knowledge network commands
const semble = program
  .command("semble")
  .description("Semble knowledge network — collections, cards, sources")

semble
  .command("list")
  .description("List your Semble collections")
  .option("-n, --limit <number>", "Max results", "50")
  .option("--cursor <cursor>", "Pagination cursor")
  .action(async (opts) => {
    const { listCollections } = await import("./commands/semble.js")
    await listCollections({ limit: parseInt(opts.limit), cursor: opts.cursor })
  })

semble
  .command("get")
  .description("Get a collection's details and cards")
  .argument("<collection>", "Collection rkey or AT-URI")
  .action(async (collection) => {
    const { getCollection } = await import("./commands/semble.js")
    await getCollection(collection)
  })

semble
  .command("create")
  .description("Create a new collection")
  .argument("<name>", "Collection name")
  .option("-d, --description <text>", "Collection description")
  .action(async (name, opts) => {
    const { createCollection } = await import("./commands/semble.js")
    await createCollection({ name, description: opts.description })
  })

semble
  .command("add-card")
  .description("Create a card and optionally add to a collection")
  .argument("<url>", "URL for the card")
  .option("--note <text>", "Note explaining the card")
  .option("-c, --collection <rkey>", "Collection rkey to add the card to")
  .action(async (url, opts) => {
    const { addCard } = await import("./commands/semble.js")
    await addCard({ url, note: opts.note, collection: opts.collection })
  })

semble
  .command("connect")
  .description("Create a typed connection between two URLs")
  .option("--source <url>", "Source URL")
  .option("--target <url>", "Target URL")
  .option("--type <type>", "Connection type: SUPPORTS, OPPOSES, RELATED, ADDRESSES, HELPFUL, EXPLAINER, LEADS_TO, SUPPLEMENTS", "RELATED")
  .option("--note <text>", "Explanation of the connection")
  .action(async (opts) => {
    if (!opts.source || !opts.target) {
      console.error("Error: --source and --target are required")
      process.exit(1)
    }
    const { connect } = await import("./commands/semble.js")
    await connect({ source: opts.source, target: opts.target, type: opts.type, note: opts.note })
  })

// blog: Publish long-form content to GreenGale
program
  .command("blog")
  .description("Publish long-form content to GreenGale (app.greengale.document)")
  .option("-t, --title <title>", "Post title")
  .option("-s, --slug <slug>", "URL slug (auto-generated from title if not provided)")
  .option("--subtitle <subtitle>", "Optional subtitle")
  .option("-f, --file <path>", "Markdown file to publish (frontmatter supported)")
  .option("-c, --content <text>", "Raw content (use with --title)")
  .action(async (opts) => {
    const { blog } = await import("./commands/blog.js")
    await blog({
      title: opts.title,
      slug: opts.slug,
      subtitle: opts.subtitle,
      content: opts.content,
      file: opts.file,
    })
  })

program.parse()
