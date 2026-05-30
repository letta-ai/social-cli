import { loadConfig } from "../config.js"
import { findRootRuntimeFiles, migrateRootRuntimeFiles, resolveStateDir } from "../lib/state.js"

export async function doctor(opts: { migrate?: boolean } = {}): Promise<void> {
  const config = loadConfig()
  const configuredStateDir = config.state?.stateDir
  const stateDir = resolveStateDir(configuredStateDir)

  console.log("social-cli doctor")
  console.log(`stateDir: ${stateDir}`)
  if (!configuredStateDir && !process.env.SOCIAL_CLI_STATE_DIR && !process.env.AGENT_ID) {
    console.log("state scope: shared checkout state")
    console.log("Set SOCIAL_CLI_STATE_DIR or config state.stateDir to isolate multiple agents sharing one checkout.")
  }

  if (opts.migrate) {
    const migrated = migrateRootRuntimeFiles(process.cwd(), configuredStateDir)
    if (migrated.length === 0) {
      console.log("migration: no root-level runtime files moved")
    } else {
      console.log(`migration: moved ${migrated.length} runtime file(s) into stateDir`)
      for (const file of migrated) {
        console.log(`  - ${file.from} → ${file.to}`)
      }
    }
  }

  const rootRuntimeFiles = findRootRuntimeFiles()

  if (rootRuntimeFiles.length === 0) {
    console.log("runtime files: ok (none found in repo root)")
  } else {
    console.log(`runtime files: ${rootRuntimeFiles.length} generated file(s) found in repo root`)
    for (const file of rootRuntimeFiles) {
      console.log(`  - ${file}`)
    }
    console.log("")
    console.log("These files are generated state. New sync/dispatch output goes under the configured state directory.")
    console.log("Run `social-cli doctor --migrate` to move root-level runtime files into the state directory.")
    console.log("Files are not overwritten if a destination already exists; inspect remaining files manually.")
  }
}
