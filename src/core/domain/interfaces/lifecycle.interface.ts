export interface Lifecycle {
  initialize(): Promise<void>
  close(): Promise<void>
}
