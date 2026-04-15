export interface TagOperations {
  addTag(itemId: string, tag: string): void
  removeTag(itemId: string, tag: string): void
  getTags(itemId: string): string[]
  findByTag(tag: string): string[]
}
