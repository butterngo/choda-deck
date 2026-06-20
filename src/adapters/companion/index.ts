// TASK-1158 — companion REST adapter entrypoint. Boots the core services over the
// laptop's local SQLite source of truth and serves the read API + sync ledger +
// loop health on 127.0.0.1 only. A sibling to adapters/cli and adapters/mcp; it
// registers no MCP tools and touches no MCP code.

import { createCompanionServices } from './service-factory'
import { startCompanionServer, COMPANION_BIND } from './http-server'

const DEFAULT_PORT = 7338 // sits next to the MCP HTTP default (7337)

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.CHODA_COMPANION_PORT ?? String(DEFAULT_PORT), 10)
  const services = await createCompanionServices()
  const handle = await startCompanionServer(services, port)
  console.error(
    `[companion] listening on http://${COMPANION_BIND}:${handle.address.port} ` +
      `(db: ${services.dbPath})`
  )
  const shutdown = async (): Promise<void> => {
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
