# social-cli

A unified CLI to connect AI agents to the social web. Bluesky, X, Semble, margin annotations, and blog publishing — all through one tool. YAML in, YAML out.

Built for [Letta](https://letta.com) agents, works with anything that can shell out.

## Install

```bash
git clone https://github.com/letta-ai/social-cli.git
cd social-cli
pnpm install
pnpm build
```

## Setup

Create a `config.yaml` in your working directory (or `~/.config/social-cli/config.yaml`):

```yaml
accounts:
  bsky:
    handle: you.bsky.social
    credentials: .env  # path to .env file with secrets
  x:
    handle: you
    credentials: .env
```

Create a `.env` with platform credentials:

```bash
# Bluesky / ATProto
ATPROTO_HANDLE=you.bsky.social
ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
ATPROTO_PDS=https://bsky.social        # optional, defaults to bsky.social

# X / Twitter (OAuth 1.0a)
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
X_BEARER_TOKEN=...                      # optional, for app-only endpoints
```

You only need the credentials for the platforms you use. Semble, margin annotations, and GreenGale blog publishing all use your Bluesky credentials.

## How it works

social-cli has two modes: an **agent loop** for automated notification handling, and **quick commands** for direct actions.

### Agent loop

```bash
social-cli sync -p bsky -p x          # pull notifications → inbox.yaml
social-cli check || exit 0            # anything actionable? no → bail
# agent reads inbox.yaml, decides, writes outbox.yaml
social-cli dispatch                    # execute decisions, mark processed
```

The agent loop handles bookkeeping — marking notifications as processed, deduplicating, archiving outboxes. Agents read `inbox.yaml`, write decisions to `outbox.yaml`, and `dispatch` executes them.

### Quick commands

For actions that don't come from notifications:

```bash
social-cli post "Hello world" -p bsky
social-cli post "Hello world" -p x
social-cli reply "Thanks" --id <post-id> -p bsky
social-cli thread "Post 1" "Post 2" "Post 3" -p x
social-cli thread "Post 1" "Post 2" -p bsky -m header.png  # media on first post
social-cli like <post-id> -p bsky
social-cli follow alice.bsky.social -p bsky
social-cli block spammer.bsky.social -p bsky
social-cli delete <post-id> -p bsky
```

Quick commands don't touch the inbox pipeline. **If you reply to a notification with `reply` instead of `dispatch`, the notification stays unprocessed and reappears next sync.** This is the most common agent mistake.

## Reading

```bash
social-cli search "query" -p bsky -n 10     # search posts → stdout YAML
social-cli search "query" -p x -n 10        # works on X too
social-cli feed -p bsky -n 20               # timeline → feed.yaml (or -o - for stdout)
social-cli feed --feed "at://did:.../app.bsky.feed.generator/name" -n 10  # custom feed
social-cli posts alice.bsky.social -n 10     # user's recent posts → stdout YAML
social-cli profile alice.bsky.social         # user profile → stdout YAML
social-cli whoami                            # your account info (all platforms)
social-cli rate-limits                       # rate limit status
```

All read commands output YAML to stdout (except `feed` which defaults to a file).

## Outbox format

Agents write decisions to `outbox.yaml` for dispatch:

```yaml
dispatch:
  - reply:
      platform: bsky
      id: "at://did:plc:xxx/app.bsky.feed.post/abc"
      text: "Thanks for the mention"

  - post:
      text: "Hello from social-cli"
      platforms: [bsky, x]

  - thread:
      platform: bsky
      posts:
        - "Thread post 1"
        - "Thread post 2"

  - like:
      platform: bsky
      id: "at://did:plc:xxx/app.bsky.feed.post/abc"

  - ignore:
      id: "notif_003"
      reason: "spam"

  - annotate:
      platform: bsky
      id: "https://example.com/article"
      text: "Key observation"
      motivation: commenting
      quote: "exact text to anchor to"
```

## Platforms

### Bluesky + X

The core social platforms. Post, reply, thread, like, follow, search, and read feeds. Character limits: 300 (Bluesky), 280 (X). Media attachments supported on both via `-m`.

### Semble

[Semble](https://semble.so) is a social knowledge network built on ATProto. Build collections of sources, annotate them with notes, and create typed connections between URLs.

```bash
# Read
social-cli semble list                          # list your collections
social-cli semble get <rkey>                    # collection details + cards + connections

# Write
social-cli semble create "Collection Name" -d "Description"
social-cli semble add-card https://example.com --note "What this source shows" -c <rkey>
social-cli semble connect \
  --source https://example.com/article \
  --target https://example.com/thread \
  --type SUPPORTS \
  --note "Article supports the thread's main claim"
```

Connection types: `SUPPORTS`, `OPPOSES`, `RELATED`, `ADDRESSES`, `HELPFUL`, `EXPLAINER`, `LEADS_TO`, `SUPPLEMENTS`.

Semble records are ATProto records on your PDS (`network.cosmik.collection`, `network.cosmik.card`, `network.cosmik.connection`). Uses the same Bluesky credentials. Collections visible at `semble.so/profile/{handle}/collections/{rkey}`.

### Margin annotations

Annotations use the `at.margin.note` lexicon (W3C Web Annotation model). They work on any URL, not just ATProto posts. Visible in [margin.at](https://margin.at) and Semble.

```bash
social-cli annotate "Note about this" --target https://example.com
social-cli bookmark --target https://example.com
social-cli highlight --target https://example.com --quote "exact passage"
```

### Blog publishing

Publish long-form content to [GreenGale](https://greengale.app) (`app.greengale.document`):

```bash
social-cli blog --file my-post.md
social-cli blog --file my-post.md --title "Title" --slug "url-slug"
social-cli blog --title "Quick Note" --content "Markdown content here"
```

Supports frontmatter (`title`, `slug`, `subtitle`). Published at `greengale.app/{handle}/{slug}`.

## Embed data

Posts in feed, search, posts, and notification output include `embed` when the post has attachments:

```yaml
embed:
  type: external          # external | images | record | recordWithMedia
  uri: https://example.com/article
  title: Article Title
  description: Summary text
```

Quoted posts surface as `record` embeds with `quotedUri`, `quotedText`, and `quotedAuthor`.

### Attachments

Notification embeds and X media include remote URLs but aren't downloaded by default. Pass `--media` to `sync` and attached images/videos are saved under `attachments/{platform}/` and annotated with a `localPath` field so agents can read them directly:

```bash
social-cli sync -p bsky -p x --media
```

```yaml
embed:
  type: images
  images:
    - alt: "..."
      url: https://cdn.bsky.app/img/feed_fullsize/plain/...
      localPath: attachments/bsky/3kxyz_0.jpg
media:
  - mediaKey: 3_2045193021470420992
    type: photo
    url: https://pbs.twimg.com/media/HGH8N5XaMAA-Eba.jpg
    localPath: attachments/x/2045193025136308393_3_2045193021470420992.jpg
```

Scope is notifications only — feed, search, and profile lookups keep the remote URLs but skip the download. Fetch those on demand with `curl` (Bluesky) or `node scripts/fetch-tweet-media.cjs <tweet-id> <out-dir>` (X). The `attachments/` directory is gitignored.

## Profile management

```bash
social-cli update-profile --display-name "Name" --bio "About me" -p bsky
social-cli update-profile --avatar ./photo.png -p bsky
```

## Resilience

- **Retry with backoff**: All API calls retry 3x on network errors, 429s, and 5xx. Respects `Retry-After` headers and rate limit reset timestamps per platform.
- **Session refresh**: Bluesky re-authenticates on token expiry automatically.
- **Atomic writes**: All YAML output uses tmp+rename. No half-written files on crash.
- **Char validation**: Quick commands reject oversized text before hitting the API.
- **Inbox cap**: `--max-items` (default 200) truncates oldest entries to prevent unbounded growth.
- **Thread resume**: If a thread fails mid-chain, `dispatch_result.yaml` includes `resumeFrom` with the index and remaining posts.
- **Continue-on-failure**: Dispatch processes all actions even if some fail. Exit code 2 on partial failure.
- **Replay detection**: Dispatch prevents posting the same reply twice to the same target.

## License

Apache-2.0
