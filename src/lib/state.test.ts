import { describe, it, expect, afterEach } from "vitest"
import { resolve } from "node:path"
import { resolveArchiveDir } from "./state.js"

const ENV = "SOCIAL_CLI_ARCHIVE_DIR"

describe("resolveArchiveDir", () => {
  afterEach(() => {
    delete process.env[ENV]
  })

  it("defaults to <stateDir>/outbox_archive (backward compatible)", () => {
    expect(resolveArchiveDir("/state")).toBe(resolve("/state", "outbox_archive"))
  })

  it("falls back to cwd when no stateDir given", () => {
    expect(resolveArchiveDir()).toBe(resolve(process.cwd(), "outbox_archive"))
  })

  it("honors a relative config archiveDir (resolved under stateDir)", () => {
    expect(resolveArchiveDir("/state", "archive")).toBe(resolve("/state", "archive"))
  })

  it("honors an absolute config archiveDir as-is", () => {
    expect(resolveArchiveDir("/state", "/abs/archive")).toBe("/abs/archive")
  })

  it("lets SOCIAL_CLI_ARCHIVE_DIR take precedence over config", () => {
    process.env[ENV] = "/env/archive"
    expect(resolveArchiveDir("/state", "config-archive")).toBe("/env/archive")
  })

  it("resolves a relative env override under stateDir", () => {
    process.env[ENV] = "env-archive"
    expect(resolveArchiveDir("/state")).toBe(resolve("/state", "env-archive"))
  })
})
