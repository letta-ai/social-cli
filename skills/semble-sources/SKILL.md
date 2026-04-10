---
name: semble-sources
description: Create public source-tracking collections on Semble after posting threads. Creates a Semble collection linking the thread post and all cited sources with notes on what claims they support. Use after posting any thread with cited sources, or when the user asks to track sources on-protocol.
---

# Semble Source Tracking

After posting a thread, create a Semble collection that links the thread and its sources. This makes sourcing publicly auditable on ATProto.

## Workflow

1. Draft a YAML file describing the thread and its sources
2. Run `cite-sources.ts` to create the Semble collection
3. Verify at `https://semble.so/profile/{handle}`

## YAML Format

```yaml
collection: "Thread Title — Sources"
description: "Source citations for thread on [topic] ([date])"
thread:
  url: https://bsky.app/profile/{handle}/post/{rkey}
  note: "Brief description of the thread's content and claims"
sources:
  - url: https://example.com/article
    note: "What specific claim this source supports"
    connectionType: SUPPORTS  # optional, defaults to SUPPORTS
  - url: https://other.com/report
    note: "What specific claim this source supports"
    connectionType: OPPOSES   # RELATED | SUPPORTS | OPPOSES | ADDRESSES | HELPFUL | EXPLAINER | LEADS_TO | SUPPLEMENTS
```

**Important:** Always include the `thread` field. The thread post itself is the anchor — it connects sources to the content they support. Without it, the collection is just a list of links with no context.

Each source `note` should explain what claim it supports, not just describe the article. Good: "Confirms supply-chain risk designation effective immediately on March 5. Notes designation historically reserved for foreign adversaries (Huawei precedent)." Bad: "Reuters article about Anthropic."

## Running

```bash
# From file
npx tsx skills/semble-sources/scripts/cite-sources.ts --input sources.yaml

# From stdin
cat sources.yaml | npx tsx skills/semble-sources/scripts/cite-sources.ts
```

Requires the same env vars as social-cli: `ATPROTO_HANDLE`, `ATPROTO_APP_PASSWORD`, `ATPROTO_PDS`.

## Dependencies

- `@cosmik.network/semble-pds-client` (installed in social-cli)
- `@atproto/identity` (peer dep, installed in social-cli)

## Notes

- Collections are publicly visible at `semble.so/profile/{handle}`
- Cards auto-fetch URL metadata (title, description, author, image)
- The Semble API at `api.semble.so` can query cards and collections programmatically
- When a `thread` is specified, connections are automatically created from each source → thread using `network.cosmik.connection` records written directly to the PDS
- Default connection type is `SUPPORTS` — override per-source with `connectionType` in YAML
- Connection types: RELATED, SUPPORTS, OPPOSES, ADDRESSES, HELPFUL, EXPLAINER, LEADS_TO, SUPPLEMENTS
- Connections are visible on each card's Semble page under the Connections tab
