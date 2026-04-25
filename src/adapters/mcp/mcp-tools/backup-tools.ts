import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { textResponse } from './types'
import { listBackups, runBackup, type Backupable } from '../../../core/backup-service'

export type BackupToolsDeps = Backupable

// Restore is intentionally not exposed via MCP — replacing the live DB file
// while the Electron app holds an open connection risks corrupting state.
// Restore stays in the renderer (BackupsPanel.tsx) where the main process
// can coordinate the swap.

export function register(server: McpServer, svc: BackupToolsDeps, dataDir: string): void {
  server.registerTool(
    'backup_list',
    {
      description:
        'List existing SQLite backups under <dataDir>/backups, newest first. Use before destructive batch ops to confirm a recent backup exists.',
      inputSchema: {}
    },
    async () => textResponse(listBackups(dataDir))
  )

  server.registerTool(
    'backup_create',
    {
      description:
        'Create a SQLite backup at <dataDir>/backups/choda-deck-<YYYY-MM-DD>.db (overwrites same-day file, prunes to 7 newest). Returns the new BackupInfo. Run before risky operations like tasks_update_batch.',
      inputSchema: {}
    },
    async () => textResponse(runBackup(svc, dataDir))
  )
}
