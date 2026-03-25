/**
 * Atomic file write: write to .tmp, then rename.
 * Prevents half-written files on crash or concurrent access.
 * Falls back to direct write for special paths (pipes, devices).
 */

import { writeFileSync, renameSync, statSync } from "node:fs"

export function writeFileAtomic(filePath: string, content: string): void {
  // Special paths (pipes, /dev/*, -) can't do tmp+rename
  if (filePath === "-" || filePath.startsWith("/dev/") || filePath.startsWith("/proc/")) {
    writeFileSync(filePath, content)
    return
  }

  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}
