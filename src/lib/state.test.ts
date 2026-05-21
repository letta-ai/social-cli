import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  DEFAULT_STATE_DIR,
  findRootRuntimeFiles,
  getPlatformFilePath,
  getSharedFilePath,
  resolveStateDir,
} from "./state.js"

describe("state paths", () => {
  const originalCwd = process.cwd()
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "social-cli-state-test-"))
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("defaults generated state to an ignored subdirectory", () => {
    expect(resolveStateDir()).toBe(join(tempDir, DEFAULT_STATE_DIR))
    expect(getPlatformFilePath("inbox", "bsky")).toBe(join(tempDir, DEFAULT_STATE_DIR, "inbox-bsky.yaml"))
    expect(getSharedFilePath("processed")).toBe(join(tempDir, DEFAULT_STATE_DIR, "processed.yaml"))
    expect(existsSync(join(tempDir, DEFAULT_STATE_DIR))).toBe(true)
  })

  it("honors explicit stateDir", () => {
    expect(getPlatformFilePath("sent_ledger", "x", "runtime")).toBe(join(tempDir, "runtime", "sent_ledger-x.yaml"))
    expect(existsSync(join(tempDir, "runtime"))).toBe(true)
  })

  it("finds generated runtime files in the repo root", () => {
    writeFileSync(join(tempDir, "inbox-bsky.yaml"), "notifications: []\n")
    writeFileSync(join(tempDir, "dispatch_result-x.yaml"), "results: []\n")
    writeFileSync(join(tempDir, "sent_ledger.yaml"), "entries: []\n")
    writeFileSync(join(tempDir, "notes.md"), "not runtime\n")

    expect(findRootRuntimeFiles()).toEqual([
      "dispatch_result-x.yaml",
      "inbox-bsky.yaml",
      "sent_ledger.yaml",
    ])
  })
})
