import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runHooks } from "./hooks.js"

describe("runHooks", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "social-cli-hooks-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("passes hook context through environment variables", async () => {
    const scriptPath = join(tempDir, "print-env.sh")
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s|%s|%s|%s" "$SOCIAL_HOOK_EVENT" "$SOCIAL_HOOK_PLATFORM" "$SOCIAL_HOOK_TEXT" "$SOCIAL_HOOK_TARGET_ID"',
      ].join("\n"),
    )
    chmodSync(scriptPath, 0o755)

    const result = await runHooks(
      {
        preDispatch: [{ event: "reply", command: `bash ${scriptPath}` }],
      },
      "preDispatch",
      {
        event: "reply",
        platform: "x",
        text: "hello world",
        targetId: "123",
        outboxPath: "/tmp/outbox-x.yaml",
        result: "success",
      },
    )

    expect(result.blocked).toBe(false)
    expect(result.abort).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].stdout).toBe("reply|x|hello world|123")
  })

  it("treats exit code 1 as a block", async () => {
    const scriptPath = join(tempDir, "block.sh")
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'echo "reply too short"',
        "exit 1",
      ].join("\n"),
    )
    chmodSync(scriptPath, 0o755)

    const result = await runHooks(
      {
        preDispatch: [{ event: "reply", command: `bash ${scriptPath}` }],
      },
      "preDispatch",
      {
        event: "reply",
        platform: "bsky",
        text: "ok",
        outboxPath: "/tmp/outbox-bsky.yaml",
        result: "success",
      },
    )

    expect(result.blocked).toBe(true)
    expect(result.abort).toBe(false)
    expect(result.reason).toBe("reply too short")
  })
})
