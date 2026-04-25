import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { backupDir, listBackups, runBackup, type Backupable } from '../../../core/backup-service'

export interface BackupToolsDeps extends Backupable {
  close(): void
}

// Restore via MCP works because the MCP server is a separate process from the
// Electron app — closing the local DB connection releases the file handle so
// copyFileSync can replace the live DB. The server then exits so Claude must
// /mcp reconnect, which mirrors the UI flow's app.relaunch().
//
// CONTRACT: do NOT run the Electron app against the same dataDir while calling
// backup_restore — both processes would race on the file lock.

export function register(
  server: McpServer,
  svc: BackupToolsDeps,
  dataDir: string,
  dbPath: string
): void {
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

  server.registerTool(
    'backup_restore',
    {
      description:
        'Restore SQLite DB from <dataDir>/backups/<filename>. Closes the MCP DB connection, copies the backup over the live DB, then exits — caller must run /mcp reconnect afterwards. Do NOT call while the Electron app is running against the same dataDir (file lock).',
      inputSchema: {
        filename: z
          .string()
          .describe('Backup filename, e.g. choda-deck-2026-04-25.db (from backup_list)')
      }
    },
    async ({ filename }) => {
      const source = join(backupDir(dataDir), filename)
      if (!existsSync(source)) {
        return textResponse({ ok: false, error: `Backup file not found: ${filename}` })
      }
      try {
        svc.close()
        copyFileSync(source, dbPath)
      } catch (err) {
        return textResponse({ ok: false, error: (err as Error).message })
      }
      // Exit after the response is delivered so Claude observes success first.
      setTimeout(() => process.exit(0), 100)
      return textResponse({
        ok: true,
        restored: filename,
        message: 'Restore complete. MCP exiting — run /mcp reconnect to continue.'
      })
    }
  )
}
