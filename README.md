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
social-cli annotate "Interesting point" --target https://example.com --quote "exact text"
```

### Read commands

```bash
social-cli search "query" -p bsky -n 10     # → stdout YAML
social-cli feed -p bsky -n 20               # → feed.yaml (or -o - for stdout)
social-cli rate-limits                       # → stdout YAML
social-cli whoami                            # → stdout YAML (all platforms)
```

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

  - ignore:
      id: "notif_003"
      reason: "spam"
```

## Annotations

Bluesky annotations use the `at.margin.annotation` lexicon (W3C Web Annotation model). They work on any URL, not just ATProto posts. Annotations appear in [margin.at](https://margin.at) and Semble.

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
