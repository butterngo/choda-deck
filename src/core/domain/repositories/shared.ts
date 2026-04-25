export type Param = string | number | null | undefined | boolean

export function now(): string {
  return new Date().toISOString()
}

let idCounter = 0

export function generateId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}
