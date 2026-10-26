// TASK-2755 — the assistant service entrypoint (dist/assistant-server.cjs).
//
// Started by the companion adapter as a child process (TASK-2758) with:
//   CHODA_ASSISTANT_PORT  0 = ephemeral; the bound port is printed on stdout
//   CHODA_DATA_DIR        the data profile (assistant.db and ai-key.txt live here)
//   CHODA_BRIDGE_TOKEN    the token every request must carry
//   CHODA_ADAPTER_URL     where the tools read work data (default http://127.0.0.1:7338)
// Run by hand, the token falls back to <dataDir>/bridge-token.txt.

import { resolveDataPaths } from '../../core/paths'
import { resolveBridgeToken } from '../companion/bridge-token'
import { startAssistantService } from './server'
import { handleMessageRoutes } from './message-routes'
import { createAdapterReads } from './adapter-reads'
import { createAssistantTools } from './tools'

const DEFAULT_PORT = 7339

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.CHODA_ASSISTANT_PORT ?? String(DEFAULT_PORT), 10)
  const paths = resolveDataPaths()
  const bridgeToken = process.env.CHODA_BRIDGE_TOKEN?.trim() || resolveBridgeToken(paths.dataDir)
  const adapterUrl = process.env.CHODA_ADAPTER_URL?.trim() || 'http://127.0.0.1:7338'
  const handle = await startAssistantService(
    { dataDir: paths.dataDir, sharedDbPath: paths.dbPath, bridgeToken },
    port,
    [
      (req, res, ctx) =>
        handleMessageRoutes(req, res, {
          ...ctx,
          tools: () => createAssistantTools(createAdapterReads({ adapterUrl, bridgeToken, store: ctx.store }))
        })
    ]
  )
  if (handle.migrated > 0) console.error(`[assistant] copied ${handle.migrated} chats from the shared database`)
  const shutdown = async (): Promise<void> => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err) => {
  console.error('[assistant] failed to start:', err)
  process.exit(1)
})
