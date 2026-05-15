import * as fs from 'node:fs'
import * as path from 'node:path'

interface AccountsFile {
  accounts: Record<string, string>
}

export class AccountsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountsConfigError'
  }
}

export function loadAccountsConfig(dataDir: string): { resolve(name: string): string | null } {
  const filePath = path.join(dataDir, 'accounts.json')

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { resolve: () => null }
  }

  let parsed: AccountsFile
  try {
    parsed = JSON.parse(raw) as AccountsFile
  } catch (e) {
    throw new AccountsConfigError(
      `accounts.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  if (!parsed || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts) || parsed.accounts === null) {
    throw new AccountsConfigError('accounts.json must have an "accounts" object')
  }

  return {
    resolve(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(parsed.accounts, name)
        ? parsed.accounts[name]
        : null
    }
  }
}
