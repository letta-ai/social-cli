---
name: blog
description: Publish long-form markdown content to GreenGale (ATProtocol-native blogging). Use when asked to publish a blog post, write an article, or post long-form content.
version: 0.1.0
license: MIT
---

# Blog Publishing Skill

Publish markdown posts to GreenGale via ATProtocol (`app.greengale.document`).

## When to Use

- User wants to publish a blog post
- Long-form content needs to go to GreenGale
- Creating documentation or articles

## Commands

```bash
# From file (recommended)
node dist/cli.js blog --file path/to/post.md

# With overrides
node dist/cli.js blog --file post.md --title "Custom Title" --slug "custom-slug"

# Inline content
node dist/cli.js blog --title "Quick Note" --content "Markdown here"
```

## Options

| Option | Description |
|--------|-------------|
| `--file` | Path to markdown file |
| `--title` | Post title (or from frontmatter) |
| `--slug` | URL slug (defaults to filename) |
| `--subtitle` | Optional subtitle |

## Frontmatter Support

Posts can include YAML frontmatter:

```markdown
---
title: My Post Title
slug: my-post-slug
---
# Content starts here

Your markdown content...
```

Frontmatter is automatically stripped before publishing.

## Output

Returns on success:
- `Published: https://greengale.app/{handle}/{slug}`
- `URI: at://did:plc:.../app.greengale.document/{slug}`
- `CID: bafyrei...`

## Requirements

Set in `.env`:
- `ATPROTO_HANDLE` — Your ATProto handle
- `ATPROTO_APP_PASSWORD` — App password
- `ATPROTO_PDS` — Your PDS URL (optional, defaults to bsky.social)

## Notes

- GreenGale indexes from the firehose — no separate publish step needed
- Posts use `github-dark` theme by default
- Records are written directly to your PDS via XRPC
