import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  DEFAULT_STATE_DIR,
  defaultStateDir,
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

  afterEach(() => {
    process.chdir(originalCwd)
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("defaults generated state to an ignored subdirectory", () => {
    expect(defaultStateDir()).toBe(process.env.AGENT_ID ? join(DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID) : DEFAULT_STATE_DIR)
    expect(resolveStateDir()).toBe(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID) : join(tempDir, DEFAULT_STATE_DIR))
    expect(getPlatformFilePath("inbox", "bsky")).toBe(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID, "inbox-bsky.yaml") : join(tempDir, DEFAULT_STATE_DIR, "inbox-bsky.yaml"))
    expect(getSharedFilePath("processed")).toBe(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID, "processed.yaml") : join(tempDir, DEFAULT_STATE_DIR, "processed.yaml"))
    expect(existsSync(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID) : join(tempDir, DEFAULT_STATE_DIR))).toBe(true)
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
    expect(migrated[0].to).toBe(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID, "inbox-bsky.yaml") : join(tempDir, DEFAULT_STATE_DIR, "inbox-bsky.yaml"))
    expect(existsSync(join(tempDir, "inbox-bsky.yaml"))).toBe(false)
    expect(existsSync(process.env.AGENT_ID ? join(tempDir, DEFAULT_STATE_DIR, "agents", process.env.AGENT_ID, "inbox-bsky.yaml") : join(tempDir, DEFAULT_STATE_DIR, "inbox-bsky.yaml"))).toBe(true)
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


  it("supports explicit state dir env override", () => {
    process.env.SOCIAL_CLI_STATE_DIR = "custom-state"

    expect(defaultStateDir()).toBe("custom-state")
    expect(resolveStateDir()).toBe(join(tempDir, "custom-state"))
    expect(getPlatformFilePath("inbox", "x")).toBe(join(tempDir, "custom-state", "inbox-x.yaml"))
  })

  it("falls back to shared state when no agent env is available", () => {
    delete process.env.AGENT_ID
    delete process.env.SOCIAL_CLI_STATE_DIR

    expect(defaultStateDir()).toBe(DEFAULT_STATE_DIR)
    expect(resolveStateDir()).toBe(join(tempDir, DEFAULT_STATE_DIR))
  })

})
