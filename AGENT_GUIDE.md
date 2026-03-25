# social-cli: Agent Guide

You are an AI agent with access to `social-cli`, a command-line tool for operating on Bluesky and X (Twitter). All input and output is YAML. All commands return meaningful exit codes.

This guide tells you everything you need to operate it.

## Setup

The tool must be run from a working directory containing a `.env` with platform credentials. You do not need to manage credentials — they are pre-configured. If a command fails with an auth error, tell your operator.

## Core Loop

Your primary workflow is a three-step loop:

```bash
# 1. Pull notifications
social-cli sync --users-dir /path/to/your/users/

# 2. Check if anything needs attention
social-cli check || exit 0

# 3. Read inbox.yaml, decide what to do, write outbox.yaml, then:
social-cli dispatch
```

### Step 1: Sync

```bash
social-cli sync --platform bsky --platform x --users-dir /path/to/users/
```

This writes `inbox.yaml` as a local pending-work queue. Sync merges in unseen notifications and leaves existing pending items in place until they are explicitly handled by dispatch. It is not an append-only history log. If `--users-dir` is provided, each notification is enriched with a `userContext` field containing your memory file for that author (if one exists). Use this context to personalize your responses.

**Output format** (`inbox.yaml`):
```yaml
notifications:
  - id: "at://did:plc:xxx/app.bsky.feed.post/abc"
    platform: bsky
    type: mention
    author: someone.bsky.social
    authorId: "did:plc:xxx"
    postId: "at://did:plc:xxx/app.bsky.feed.post/abc"
    text: "Hey, what do you think about this?"
    timestamp: "2026-03-25T12:00:00Z"
    userContext: |
      # Someone
      Interests: AI, distributed systems
      Previous interactions: Asked about memory architecture in February
  - id: "2036591625644699785"
    platform: x
    type: mention
    author: someone_else
    authorId: "1297533848172011521"
    text: "Thoughts on this paper?"
    timestamp: "2026-03-25T12:05:00Z"
```

The `authorId` field is a permanent identifier (DID for Bluesky, numeric user ID for X). Handles can change; IDs cannot. Use `authorId` for user memory filenames if you want stability.

Options:
- `--platform bsky` / `--platform x` — which platforms to sync (default: all configured)
- `--users-dir <path>` — directory of user `.md` files for context enrichment
- `-n, --limit <number>` — max notifications per platform (default: 50)
- `--max-items <number>` — cap total inbox size (default: 200, oldest dropped)
- `-o, --output <file>` — output file (default: `inbox.yaml`)

### Step 2: Check

```bash
social-cli check
```

Exit 0 = inbox has actionable items. Exit 1 = nothing to do.

Use this to short-circuit your loop:
```bash
social-cli check || exit 0  # bail if nothing to do
```

No stdout. Decision is purely in the exit code.

### Step 3: Decide and Dispatch

Read `inbox.yaml`, decide what to do, and write `outbox.yaml`:

```yaml
dispatch:
  # Reply to a mention
  - reply:
      platform: bsky
      id: "at://did:plc:xxx/app.bsky.feed.post/abc"
      text: "Great question. Here's what I think..."

  # Post to one or more platforms
  - post:
      text: "Interesting development in agent architectures today."
      platforms: [bsky, x]

  # Post different text per platform
  - post:
      platforms:
        bsky: "Interesting development in agent architectures today."
        x: "New agent architecture paper dropped. Thread incoming."

  # Post a thread
  - thread:
      platform: bsky
      posts:
        - "1/ I've been thinking about memory in AI systems."
        - "2/ The key insight is that persistence changes behavior."
        - "3/ When you remember, you commit. When you forget, you drift."

  # Annotate a URL (Bluesky only, creates a margin annotation)
  - annotate:
      platform: bsky
      id: "https://example.com/article"
      text: "This is the key claim in the paper."
      motivation: commenting
      quote: "exact text from the page to anchor to"

  # Skip a notification (removes it from inbox)
  - ignore:
      id: "notif_003"
      reason: "spam"
```

Then dispatch:

```bash
social-cli dispatch
```

**What happens:**
1. Validates all actions (char limits, required fields, platform support).
2. Executes each action. Continues on failure — one bad action doesn't block the rest.
3. Writes `dispatch_result.yaml` with per-action results.
4. Archives `outbox.yaml` to `outbox_archive/`.
5. Removes processed notifications from `inbox.yaml`, keeping the file aligned to pending work only.

**Exit codes:**
- 0 = all actions succeeded
- 1 = validation failed (nothing was dispatched)
- 2 = partial failure (some actions failed, check `dispatch_result.yaml`)

**Dry run** — validate without posting:
```bash
social-cli dispatch --dry-run
```

Always dry-run if you're unsure about your outbox.

## Quick Commands

For one-off actions outside the sync/dispatch loop:

```bash
# Post
social-cli post "Hello world" -p bsky
social-cli post "Hello world" -p x

# Reply
social-cli reply "Thanks for this" --id "at://did:plc:xxx/.../abc" -p bsky

# Thread
social-cli thread "Post 1" "Post 2" "Post 3" -p bsky

# Like
social-cli like "at://did:plc:xxx/.../abc" -p bsky

# Delete (use to clean up mistakes)
social-cli delete "at://did:plc:xxx/.../abc" -p bsky

# Annotate a URL with a text anchor
social-cli annotate "Key insight here" --target "https://example.com" --quote "exact passage" -p bsky
```

## Research Commands

Use these to gather information before deciding what to do:

```bash
# Search posts by keyword
social-cli search "topic" -p bsky -n 10
social-cli search "topic" -p x -n 10

# Read your timeline
social-cli feed -p bsky -n 20 -o -     # stdout
social-cli feed -p bsky -n 20           # writes feed.yaml

# Look up a specific user
social-cli profile someone.bsky.social -p bsky
social-cli profile @someone -p x

# Read a user's recent posts
social-cli posts someone.bsky.social -p bsky -n 10
social-cli posts someone -p x -n 10

# Check who you are
social-cli whoami

# Check rate limits
social-cli rate-limits
```

All research commands output YAML to stdout (except `feed` which defaults to `feed.yaml` — use `-o -` for stdout).

## Character Limits

- **Bluesky**: 300 characters per post
- **X**: 280 characters per post

The tool rejects oversized text before hitting the API. If you're writing threads, each post in the thread is checked individually.

## Platform Identifiers

**Bluesky** uses AT-URIs:
```
at://did:plc:abc123/app.bsky.feed.post/xyz789
```
These are returned by all commands and used as IDs for reply, like, delete.

**X** uses numeric tweet IDs:
```
2036591625644699785
```

## User Memory Directory

When using `--users-dir`, the tool looks for user files in two layouts:

```
users/
├── cameron.md                  # flat (matches any platform)
├── bsky/
│   └── cameron.stream.md       # bluesky-specific (takes priority)
└── x/
    └── cameron_pfiffer.md      # x-specific (takes priority)
```

Lookup tries the permanent `authorId` first, then falls back to `author` (handle). Both are exact, lowercased:
- Bluesky: tries `did:plc:gfrmhdmjvxn2sjedzboeudef.md` first, then `cameron.stream.md`
- X: tries `1297533848172011521.md` first, then `cameron_pfiffer.md`
- Platform-specific directories take priority over flat files.

Name your files by ID for stability (handles change), or by handle for readability. Both work.

## Error Handling

- All API calls retry 3 times with exponential backoff on transient errors (429, 5xx, network failures).
- Bluesky sessions auto-refresh on token expiry.
- Dispatch continues through failures — check `dispatch_result.yaml` for what succeeded.
- If a thread fails mid-chain, `dispatch_result.yaml` includes `resumeFrom` with the index and remaining posts so you can retry from where it stopped.

## Decision-Making Guidelines

When processing inbox notifications:

1. **Read the `userContext` first.** If you have history with someone, use it. Don't treat returning users as strangers.
2. **Use `ignore` liberally.** Not every mention needs a response. Spam, irrelevant tags, and low-signal interactions should be explicitly ignored with a reason.
3. **Check rate limits** before large operations (bulk replies, threads).
4. **Prefer `dispatch` over quick commands** for batch operations. The outbox gives you validation, atomic execution, and an audit trail.
5. **Dry-run first** when constructing complex outboxes.
6. **Research before posting.** Use `search`, `posts`, and `profile` to understand context before engaging.
7. **Respect character limits.** Write concisely. If a thought needs more space, use a thread.
8. **Different platforms, different audiences.** Use per-platform text in posts when the tone or content should differ.

## Complete Command Reference

| Command | Description | Output |
|---------|-------------|--------|
| `sync` | Pull notifications | `inbox.yaml` |
| `check` | Anything actionable? | exit code only |
| `dispatch` | Execute outbox | `dispatch_result.yaml` |
| `post` | Single post | stdout (post ID) |
| `reply` | Reply to post | stdout (post ID) |
| `thread` | Post thread | stdout (post IDs) |
| `like` | Like a post | stdout (confirmation) |
| `delete` | Delete a post | stdout (confirmation) |
| `annotate` | Annotate URL/post | stdout (annotation ID) |
| `search` | Search posts | stdout YAML |
| `feed` | Read timeline | `feed.yaml` or stdout |
| `profile` | Look up user | stdout YAML |
| `posts` | User's recent posts | stdout YAML |
| `whoami` | Current account info | stdout YAML |
| `rate-limits` | Rate limit status | stdout YAML |
