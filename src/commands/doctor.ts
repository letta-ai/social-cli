import { loadConfig } from "../config.js"
import { findRootRuntimeFiles, resolveStateDir } from "../lib/state.js"

export async function doctor(): Promise<void> {
  const config = loadConfig()
  const stateDir = resolveStateDir(config.state?.stateDir)
  const rootRuntimeFiles = findRootRuntimeFiles()

  console.log("social-cli doctor")
  console.log(`stateDir: ${stateDir}`)

  if (rootRuntimeFiles.length === 0) {
    console.log("runtime files: ok (none found in repo root)")
  } else {
    console.log(`runtime files: ${rootRuntimeFiles.length} generated file(s) found in repo root`)
    for (const file of rootRuntimeFiles) {
      console.log(`  - ${file}`)
    }
    console.log("")
    console.log("These files are generated state. New sync/dispatch output goes under .social-cli/state/ by default.")
    console.log("Move or remove root-level runtime files after confirming they are no longer needed.")
  }
}
