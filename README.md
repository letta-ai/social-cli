# social-cli

Agent-optimized social media CLI. Bluesky + X. YAML in, YAML out, exit codes for automation.

## Install

```bash
pnpm install
pnpm build
```

## Setup

Create a `.env` in the working directory:

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

You only need the credentials for the platforms you use.

Optional configuration lives in `config.yaml` in the working directory (or `~/.config/social-cli/config.yaml`). This is where dispatch hooks are configured.

## Commands

### Agent loop

The intended workflow for an automated agent:

```bash
social-cli sync                    # pull notifications → inbox.yaml
social-cli check || exit 0         # anything actionable? no → bail
# agent reads inbox.yaml, decides, writes outbox.yaml
social-cli dispatch                # execute decisions, archive outbox
```

### Workflow commands

| Command | Description | Exit codes |
|---------|-------------|------------|
| `sync` | Fetch notifications → `inbox.yaml`. Dedupes, caps at `--max-items`. | 0 ok, 1 error |
| `check` | Is inbox actionable? No output, exit code only. | 0 yes, 1 no |
| `dispatch [file]` | Validate and execute `outbox.yaml`. Archives after. | 0 ok, 1 invalid, 2 partial failure |

### Quick commands

```bash
social-cli post "Hello world" -p bsky
social-cli reply "Thanks" --id at://did:plc:.../app.bsky.feed.post/abc -p bsky
social-cli thread "Post 1" "Post 2" "Post 3" -p x
social-cli like at://did:plc:.../app.bsky.feed.post/abc -p bsky
social-cli delete at://did:plc:.../app.bsky.feed.post/abc -p bsky
social-cli follow alice.bsky.social -p bsky
social-cli annotate "Interesting point" --target https://example.com --quote "exact text"
```

### Read commands

```bash
social-cli search "query" -p bsky -n 10     # → stdout YAML
social-cli feed -p bsky -n 20               # → feed.yaml (or -o - for stdout)
social-cli feed --feed "at://did:.../app.bsky.feed.generator/name" -n 10  # custom feed
social-cli posts alice.bsky.social -n 10     # → stdout YAML
social-cli profile alice.bsky.social         # → stdout YAML
social-cli rate-limits                       # → stdout YAML
social-cli whoami                            # → stdout YAML (all platforms)
social-cli blog --file post.md               # publish to GreenGale
```

### Profile management

```bash
social-cli update-profile --display-name "Name" --bio "About me" -p bsky
social-cli update-profile --avatar ./photo.png -p bsky
```

### Embed data

Posts in feed, search, posts, and notification output include an `embed` field when the post has attachments:

```yaml
embed:
  type: external          # external | images | record | recordWithMedia
  uri: https://example.com/article
  title: Article Title
  description: Summary text
```

Quoted posts surface as `record` embeds with `quotedUri`, `quotedText`, and `quotedAuthor`.

## Dispatch vs Quick Commands

**Dispatch** (`sync` → `check` → write outbox → `dispatch`) is the primary workflow. It handles bookkeeping: marking notifications as processed, archiving outboxes, writing results. Use dispatch for anything driven by inbox notifications.

**Quick commands** (`post`, `reply`, `thread`, `like`) bypass the inbox pipeline. They don't mark anything as processed. Use them for original content, source replies on your own threads, and other non-inbox-driven actions.

**If you reply to an inbox notification via the `reply` quick command instead of dispatch, the notification stays in the inbox and reappears next sync.** This is the most common agent mistake.

## Outbox format

Agents write decisions as `outbox.yaml`:

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

  - annotate:
      platform: bsky
      id: "https://example.com/article"
      text: "Key observation"
      motivation: commenting
      quote: "exact text to anchor to"

  - like:
      platform: bsky
      id: "at://did:plc:xxx/app.bsky.feed.post/abc"

  - ignore:
      id: "notif_003"
      reason: "spam"
```

## Dispatch hooks

Hooks let you run scripts before or after `dispatch` actions. They are configured in `config.yaml` and currently apply to the **dispatch pipeline** — not quick commands like `post` or `reply`.

```yaml
hooks:
  preDispatch:
    - event: reply
      command: "bash hooks/example-validate-reply.sh"

  postDispatch:
    - event: thread
      command: "bash hooks/example-log-dispatch.sh"
    - event: "*"
      command: "bash hooks/example-log-dispatch.sh"

  onError:
    - event: "*"
      command: "bash hooks/example-log-dispatch.sh"
```

### Lifecycles

- `preDispatch` — synchronous, blocking. Runs once per action before dispatch.
  - exit `0`: allow action
  - exit `1`: skip action
  - exit `2`: abort remaining dispatch work
- `postDispatch` — async, fire-and-forget. Runs after a successful action.
- `onError` — async, fire-and-forget. Runs after a failed action.

Hooks match the action `event` (`reply`, `post`, `thread`, `follow`, `like`, `annotate`, `bookmark`, `highlight`) or wildcard `"*"`.

### Environment variables

Each hook receives context through environment variables:

- `SOCIAL_HOOK_EVENT`
- `SOCIAL_HOOK_PLATFORM`
- `SOCIAL_HOOK_ACTION_ID`
- `SOCIAL_HOOK_TARGET_ID`
- `SOCIAL_HOOK_TEXT`
- `SOCIAL_HOOK_OUTBOX_PATH`
- `SOCIAL_HOOK_RESULT`
- `SOCIAL_HOOK_ERROR` (only on failures)

The repo includes example scripts in `hooks/`:

- `hooks/example-validate-reply.sh`
- `hooks/example-log-dispatch.sh`

## Blog publishing

Publish long-form content to GreenGale (`app.greengale.document`):

```bash
# From file (supports frontmatter)
social-cli blog --file my-post.md

# With options
social-cli blog --file my-post.md --title "Custom Title" --slug "custom-slug"

# Inline content
social-cli blog --title "Quick Note" --content "Markdown content here"
```

Options:
- `--file` — Path to markdown file
- `--title` — Override title (or use frontmatter `title:`)
- `--slug` — Override slug (defaults to filename without date prefix)
- `--subtitle` — Optional subtitle

Frontmatter is stripped automatically:

```markdown
---
title: My Post
slug: my-post
---
# Actual content starts here
```

Published posts appear at: `https://greengale.app/{handle}/{slug}`

## Annotations

Bluesky annotations use the `at.margin.note` lexicon (W3C Web Annotation model, unified format). They work on any URL, not just ATProto posts. Annotations appear in [margin.at](https://margin.at) and Semble.

```bash
# Annotate a web page
social-cli annotate "Note about this article" --target https://example.com

# Annotate with a text anchor (highlight)
social-cli annotate "This is the key insight" \
  --target https://example.com/article \
  --quote "exact passage from the page" \
  --motivation highlighting
```

## Resilience

- **Retry with backoff**: All API calls retry 3x on network errors, 429s, and 5xx. Respects `Retry-After`.
- **Session refresh**: Bluesky re-authenticates on token expiry. No manual intervention.
- **Atomic writes**: All YAML output uses tmp+rename. No half-written files on crash.
- **Char validation**: Quick commands reject oversized text before hitting the API (300 bsky, 280 x).
- **Inbox cap**: `--max-items` (default 200) truncates oldest entries.
- **Thread resume**: If a thread fails mid-chain, `dispatch_result.yaml` includes `resumeFrom` with the index and remaining posts.
- **Continue-on-failure**: Dispatch processes all actions even if some fail. Exit 2 on partial.

## License

Apache-2.0
