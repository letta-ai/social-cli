---
name: thread-cards
description: Generate branded header card images for threads. Programmatic SVG templates rendered to PNG via resvg. Four patterns matching the Sensemaker avatar geometry. Use when posting threads with --card flag or generating cards manually.
---

# Thread Cards

Branded header images for threads. SVG templates rendered to PNG. Black and white, geometric, matching the Sensemaker avatar.

## Quick usage

```bash
# Auto-generate with thread command
social-cli thread "Post 1" "Post 2" --card -p bsky
social-cli thread "Post 1" --card --card-title "Custom Title" --card-subtitle "3 sources" --card-pattern angular -p bsky

# Generate standalone
npx tsx skills/thread-cards/generate-card.ts \
  --title "Thread Title" \
  --subtitle "Source count and date" \
  --pattern ripple \
  --output card.png
```

## Patterns

| Pattern | Flag | Use for |
|---------|------|---------|
| `ripple` | `--card-pattern ripple` | Default/signature. Concentric circles from avatar. |
| `angular` | `--card-pattern angular` | Policy, regulation, governance threads. |
| `orbital` | `--card-pattern orbital` | Tech, AI models, product threads. |
| `grid` | `--card-pattern grid` | Data, research, academic threads. |

Default is `ripple` if no pattern specified.

## Outbox YAML

```yaml
dispatch:
  - thread:
      platform: bsky
      card: true                    # auto-generate from first post text
      posts: ["Post 1", "Post 2"]

  - thread:
      platform: bsky
      card:                         # explicit options
        title: "Custom Title"
        subtitle: "3 sources"
        pattern: angular
      posts: ["Post 1", "Post 2"]
```

## Output

- Dimensions: 1200x628 (Open Graph standard)
- Format: PNG
- Size: ~50-60 KB
- Bluesky embeds include `aspectRatio` automatically (reads from PNG IHDR)

## Files

- `generate-card.ts` — the generator (~280 lines)
- `logo.svg` — Sensemaker logo asset (from actual avatar SVG)

## Dependencies

- `@resvg/resvg-js` — Rust WASM PNG renderer, no native deps
