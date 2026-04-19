export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface FileStat {
  content: string
  size: number
  mtime: string
}

export interface SearchMatch {
  line: number
  text: string
}

export interface SearchResult {
  path: string
  name: string
  matches: SearchMatch[]
}
