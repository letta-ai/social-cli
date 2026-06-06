const DEFAULT_ITEM_KEYS = ["notifications", "posts", "results", "items", "feed"] as const

/**
 * Normalize YAML parsed from social-cli read/state commands into an item list.
 *
 * Read commands such as `feed`, `search`, and `posts` emit bare YAML arrays.
 * State files such as inboxes emit mappings like `{ notifications: [...] }`.
 * Agent helper scripts should normalize the root type before reading keyed fields
 * so an array root never crashes with an unsafe `.get`/property lookup pattern.
 */
export function normalizeReadOutputItems<T = unknown>(
  root: unknown,
  itemKeys: readonly string[] = DEFAULT_ITEM_KEYS,
): T[] {
  if (Array.isArray(root)) return root as T[]
  if (!root || typeof root !== "object") return []

  const record = root as Record<string, unknown>
  for (const key of itemKeys) {
    const value = record[key]
    if (Array.isArray(value)) return value as T[]
  }

  return []
}
