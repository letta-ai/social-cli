/**
 * Atomic file write: write to .tmp, then rename.
 * Prevents half-written files on crash or concurrent access.
 * Falls back to direct write for special paths (pipes, devices).
 */

import { writeFileSync, renameSync, copyFileSync, unlinkSync, statSync } from "node:fs"

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

/**
 * Move a file across the filesystem.
 *
 * `renameSync` is the fast path when source and destination live on the
 * same filesystem. When they don't — Docker volume vs overlay layer,
 * tmpfs vs disk, /tmp on its own mount, etc. — the syscall returns
 * EXDEV and `renameSync` throws. Fall back to copy + unlink so the move
 * still completes.
 *
 * Used by archive flows where the source typically lives under an
 * operator-supplied state dir on one filesystem and the destination
 * (an `outbox_archive/` subdir under process.cwd()) sits on another.
 */
export function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(src, dest)
      unlinkSync(src)
      return
    }
    throw err
  }
}
