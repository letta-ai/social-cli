#!/usr/bin/env node

/**
 * social-cli: Agent-optimized social media CLI.
 * Bluesky + X. YAML in, YAML out. Exit codes for agents.
 */

import { Command } from "commander"

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
  .option("--reset", "Clear cursors and re-fetch all notifications from scratch")
  .option("--clear", "Clear both cursors and the local inbox for a fully fresh start")
  .action(async (opts) => {
    const { sync } = await import("./commands/sync.js")
    await sync({
      platforms: opts.platform,
      unreadOnly: opts.unreadOnly,
      limit: parseInt(opts.limit),
      output: opts.output,
      maxItems: parseInt(opts.maxItems),
      usersDir: opts.usersDir,
      reset: opts.reset,
      clear: opts.clear,
    })
  })

// dispatch: outbox.yaml → post to platforms
program
  .command("dispatch")
  .description("Dispatch posts from outbox YAML")
  .argument("[file]", "Outbox file", "outbox.yaml")
  .option("--dry-run", "Validate only, don't post")
  .action(async (file, opts) => {
    const { dispatch } = await import("./commands/dispatch.js")
    await dispatch({ file, dryRun: opts.dryRun })
  })

// check: Anything actionable? Exit code only.
program
  .command("check")
  .description("Check if inbox has actionable items (exit 0 = yes, 1 = no)")
  .option("-t, --threshold <number>", "Minimum items to trigger", "1")
  .action(async (opts) => {
    const { check } = await import("./commands/check.js")
    await check({ threshold: parseInt(opts.threshold) })
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
  .description("Fetch timeline → feed.yaml")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("-n, --limit <number>", "Max posts", "50")
  .option("-o, --output <file>", "Output file", "feed.yaml")
  .action(async (opts) => {
    const { feed } = await import("./commands/feed.js")
    await feed({
      platform: opts.platform,
      limit: parseInt(opts.limit),
      output: opts.output,
    })
  })

// post: Quick single post
program
  .command("post")
  .description("Post to a platform")
  .argument("<text>", "Text to post")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .option("--quote <id>", "Quote/repost a post by ID")
  .action(async (text, opts) => {
    const { validateText } = await import("./util/validate.js")
    validateText(opts.platform, text)
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    const result = await platform.post(text, { quoteId: opts.quote })
    console.log(`Posted: ${result.id}`)
  })

// reply: Quick reply
program
  .command("reply")
  .description("Reply to a post")
  .argument("<text>", "Reply text")
  .requiredOption("--id <id>", "Post ID to reply to")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (text, opts) => {
    const { validateText } = await import("./util/validate.js")
    validateText(opts.platform, text)
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    const result = await platform.reply(opts.id, text)
    console.log(`Replied: ${result.id}`)
  })

// thread: Post a thread
program
  .command("thread")
  .description("Post a thread")
  .argument("<posts...>", "Thread posts (each argument is one post)")
  .option("-p, --platform <platform>", "Platform", "bsky")
  .action(async (posts, opts) => {
    const { validateTexts } = await import("./util/validate.js")
    validateTexts(opts.platform, posts)
    const { getPlatformAsync } = await import("./platforms/index.js")
    const platform = await getPlatformAsync(opts.platform)
    const results = await platform.thread(posts)
    for (const r of results) console.log(`Posted: ${r.id}`)
    console.log(`Thread: ${results.length} posts`)
  })

// annotate: Attach annotation to a post
program
  .command("annotate")
  .description("Annotate a URL or post (Bluesky only)")
  .argument("<text>", "Annotation text")
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

program.parse()
