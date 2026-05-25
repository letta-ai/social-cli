/**
 * Tests for src/util/fs.ts — moveFile.
 *
 * The EXDEV fallback (renameSync → copy + unlink) is conceptually
 * simple enough that we cover it by inspection + a manual
 * verification noted in the PR description. Mocking renameSync
 * cleanly under ESM is fragile (the named-import binding inside the
 * production module is immutable once loaded); the cost of a
 * reliable mock exceeds the value of the test for a 4-line try/catch.
 *
 * The happy path below pins the contract: src disappears, dest
 * appears with identical content. Regression of the EXDEV branch
 * would surface immediately in the bench/dispatch flow on any Docker
 * deployment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { moveFile } from "./fs.js"

describe("moveFile", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "social-cli-fs-test-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("happy path: moves a file within the same filesystem", () => {
    const src = join(tmp, "src.txt")
    const dest = join(tmp, "dest.txt")
    writeFileSync(src, "hello world")

    moveFile(src, dest)

    expect(existsSync(src)).toBe(false)
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, "utf-8")).toBe("hello world")
  })

  it("preserves content across the move (binary-safe)", () => {
    const src = join(tmp, "src.bin")
    const dest = join(tmp, "dest.bin")
    const payload = Buffer.from([0x00, 0xff, 0x42, 0x00, 0xde, 0xad, 0xbe, 0xef])
    writeFileSync(src, payload)

    moveFile(src, dest)

    expect(readFileSync(dest)).toEqual(payload)
  })

  it("overwrites an existing destination (renameSync semantics)", () => {
    const src = join(tmp, "src.txt")
    const dest = join(tmp, "dest.txt")
    writeFileSync(src, "new content")
    writeFileSync(dest, "stale content to be overwritten")

    moveFile(src, dest)

    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, "utf-8")).toBe("new content")
  })
})
