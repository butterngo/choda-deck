export interface Column<T> {
  header: string
  get: (row: T) => string
  width?: number
}

export function renderTable<T>(rows: T[], cols: Column<T>[]): string {
  if (rows.length === 0) return '(no results)\n'
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.get(r).length), c.width ?? 0)
  )
  const headerLine = cols.map((c, i) => c.header.padEnd(widths[i])).join('  ')
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ')
  const dataLines = rows.map((r) =>
    cols.map((c, i) => c.get(r).padEnd(widths[i])).join('  ')
  )
  return [headerLine, sepLine, ...dataLines].join('\n') + '\n'
}

export function renderSection(title: string, body: string): string {
  return `## ${title}\n\n${body.trimEnd()}\n`
}
