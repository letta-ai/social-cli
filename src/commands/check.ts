/**
 * check: Is there anything actionable?
 * Exit 0 = yes, exit 1 = no. No stdout.
 * Agents use exit code to decide whether to process.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"

export async function check(opts: {
  threshold?: number
}): Promise<void> {
  const threshold = opts.threshold ?? 1
  const inboxPath = resolve(process.cwd(), "inbox.yaml")

  if (!existsSync(inboxPath)) {
    process.exit(1)
  }

  try {
    const raw = parse(readFileSync(inboxPath, "utf-8")) as { notifications?: any[] }
    const count = raw?.notifications?.length ?? 0
    process.exit(count >= threshold ? 0 : 1)
  } catch {
    process.exit(1)
  }
}
