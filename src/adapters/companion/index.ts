// TASK-1158 — companion REST adapter entrypoint. Boots the core services over the
// laptop's local SQLite source of truth and serves the read API + sync ledger +
// loop health on 127.0.0.1 only. A sibling to adapters/cli and adapters/mcp; it
// registers no MCP tools and touches no MCP code.

import { createCompanionServices } from './service-factory'
import { startCompanionServer, COMPANION_BIND } from './http-server'
import { AssistantChild, ASSISTANT_CHILD_FILE, resolveAssistantEntry } from './spawn-assistant'

const DEFAULT_PORT = 7338 // sits next to the MCP HTTP default (7337)

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.CHODA_COMPANION_PORT ?? String(DEFAULT_PORT), 10)
  const services = await createCompanionServices()
  const handle = await startCompanionServer(services, port)
  console.error(
    `[companion] listening on http://${COMPANION_BIND}:${handle.address.port} ` +
      `(db: ${services.dbPath})`
  )
  // TASK-1330 — surface where the extension pairs its capture token from.
  console.error('[companion] capture bridge token → <dataDir>/bridge-token.txt (pair it in the extension)')
  // TASK-2758 — the assistant service runs as this adapter's child, so both
  // launch paths (Task Scheduler, Electron) get it. Missing bundle → /assistant/* 503s.
  const entry = resolveAssistantEntry()
  if (entry && services.dataDir) {
    services.assistant = new AssistantChild({
      entry,
      dataDir: services.dataDir,
      bridgeToken: services.bridgeToken,
      adapterPort: handle.address.port
    })
    services.assistant.start()
  } else {
    console.error(`[companion] ${ASSISTANT_CHILD_FILE} not found beside the adapter — /assistant/* will answer 503`)
  }
  process.on('exit', () => services.assistant?.stop())
  const shutdown = async (): Promise<void> => {
    services.assistant?.stop()
    await handle.close()
    services.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err) => {
  console.error('[companion] failed to start:', err)
  process.exit(1)
})
