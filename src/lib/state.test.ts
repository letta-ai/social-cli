import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  DEFAULT_STATE_DIR,
  defaultStateDir,
  defaultStateId,
  findRootRuntimeFiles,
  migrateRootRuntimeFiles,
  getPlatformFilePath,
  getSharedFilePath,
  resolveStateDir,
} from "./state.js"

describe("state paths", () => {
  const originalCwd = process.cwd()
  let tempDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "social-cli-state-test-"))
    process.chdir(tempDir)
  })

  function expectedStateId(): string {
    return process.env.SOCIAL_CLI_STATE_ID
      ?? process.env.SOCIAL_CLI_AGENT_ID
      ?? process.env.AGENT_ID
      ?? "default"
  }

  afterEach(() => {
    process.chdir(originalCwd)
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("defaults generated state to an ignored subdirectory", () => {
    expect(defaultStateDir()).toBe(join(DEFAULT_STATE_DIR, expectedStateId()))
    expect(resolveStateDir()).toBe(join(tempDir, DEFAULT_STATE_DIR, expectedStateId()))
    expect(getPlatformFilePath("inbox", "bsky")).toBe(join(tempDir, DEFAULT_STATE_DIR, expectedStateId(), "inbox-bsky.yaml"))
    expect(getSharedFilePath("processed")).toBe(join(tempDir, DEFAULT_STATE_DIR, expectedStateId(), "processed.yaml"))
    expect(existsSync(join(tempDir, DEFAULT_STATE_DIR, expectedStateId()))).toBe(true)
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

  it("migrates root runtime files into the state directory without overwriting", () => {
    writeFileSync(join(tempDir, "inbox-bsky.yaml"), "notifications: []\n")
    writeFileSync(join(tempDir, "notes.md"), "not runtime\n")

    const migrated = migrateRootRuntimeFiles()

    expect(migrated).toHaveLength(1)
    expect(migrated[0].from).toBe(join(tempDir, "inbox-bsky.yaml"))
    expect(migrated[0].to).toBe(join(tempDir, DEFAULT_STATE_DIR, expectedStateId(), "inbox-bsky.yaml"))
    expect(existsSync(join(tempDir, "inbox-bsky.yaml"))).toBe(false)
    expect(existsSync(join(tempDir, DEFAULT_STATE_DIR, expectedStateId(), "inbox-bsky.yaml"))).toBe(true)
    expect(existsSync(join(tempDir, "notes.md"))).toBe(true)
  })

  it("does not overwrite existing files during migration", () => {
    const stateFile = getPlatformFilePath("inbox", "bsky")
    writeFileSync(join(tempDir, "inbox-bsky.yaml"), "root: true\n")
    writeFileSync(stateFile, "state: true\n")

    expect(migrateRootRuntimeFiles()).toEqual([])
    expect(existsSync(join(tempDir, "inbox-bsky.yaml"))).toBe(true)
    expect(existsSync(stateFile)).toBe(true)
  })


  it("supports generic non-Letta state IDs", () => {
    delete process.env.AGENT_ID
    process.env.SOCIAL_CLI_STATE_ID = "claude/reviewer 1"

    expect(defaultStateId()).toBe("claude/reviewer 1")
    expect(defaultStateDir()).toBe(join(DEFAULT_STATE_DIR, "claude-reviewer-1"))
    expect(getPlatformFilePath("inbox", "x")).toBe(join(tempDir, DEFAULT_STATE_DIR, "claude-reviewer-1", "inbox-x.yaml"))
  })

  it("falls back to SOCIAL_CLI_AGENT_ID before AGENT_ID", () => {
    process.env.AGENT_ID = "letta-agent"
    process.env.SOCIAL_CLI_AGENT_ID = "other-agent"

    expect(defaultStateId()).toBe("other-agent")
    expect(defaultStateDir()).toBe(join(DEFAULT_STATE_DIR, "other-agent"))
  })

})
