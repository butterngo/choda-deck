const CMD_META = /[\s()<>&|^"*?]/

export function quoteArg(a: string): string {
  if (CMD_META.test(a)) return `"${a.replace(/"/g, '\\"')}"`
  return a
}

export function buildCommandLine(executable: string, args: readonly string[]): string {
  const exe = CMD_META.test(executable) ? `"${executable.replace(/"/g, '\\"')}"` : executable
  return [exe, ...args.map(quoteArg)].join(' ')
}
