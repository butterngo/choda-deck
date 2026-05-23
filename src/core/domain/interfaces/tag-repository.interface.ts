export interface TagOperations {
  addTag(itemId: string, tag: string): Promise<void>
  removeTag(itemId: string, tag: string): Promise<void>
  getTags(itemId: string): Promise<string[]>
  findByTag(tag: string): Promise<string[]>
}
