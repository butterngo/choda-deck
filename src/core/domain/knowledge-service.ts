import * as fs from 'fs'
import * as path from 'path'
import type { ProjectRow } from './repositories/project-repository'
import type { WorkspaceRow } from './repositories/workspace-repository'
import type { GitOps } from './knowledge-git'
import { GitOpsImpl } from './knowledge-git'
import { parseFrontmatter, serializeFrontmatter } from './knowledge-frontmatter'
import { KNOWLEDGE_TYPES, KNOWLEDGE_SCOPES } from './knowledge-types'
import { isLikelyWorktreePath } from '../worktree-path'
import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeFrontmatter,
  KnowledgeIndexRow,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeRef,
  KnowledgeRefStaleness,
  KnowledgeSearchResult,
  KnowledgeVerifyResult,
  RegisterExistingKnowledgeInput,
  UpdateKnowledgeInput
} from './knowledge-types'
import type { KnowledgeOperations } from './interfaces/knowledge-operations.interface'
import type { EmbeddingProvider } from './embedding/embedding-provider.interface'

type Awaitable<T> = T | Promise<T>

/**
 * Narrow ports the knowledge service depends on. SQLite repos satisfy them
 * via their synchronous returns (a `T` is assignable to `T | Promise<T>`);
 * the Postgres repos satisfy them with native `Promise<T>` returns. Same
 * pattern as `QueueLifecycleService` ports (slice 19) — keeps the ports
 * service-local so a different consumer can define a narrower slice.
 */
export interface KnowledgeIndexPort {
  upsert(row: KnowledgeIndexRow): Awaitable<void>
  get(slug: string): Awaitable<KnowledgeIndexRow | null>
  list(filter?: KnowledgeListFilter): Awaitable<KnowledgeIndexRow[]>
  updateLastVerified(slug: string, lastVerifiedAt: string): Awaitable<void>
  delete(slug: string): Awaitable<void>
}

export interface KnowledgeProjectPort {
  get(id: string): Awaitable<ProjectRow | null>
}

export interface KnowledgeWorkspacePort {
  get(id: string): Awaitable<WorkspaceRow | null>
}

/**
 * Slug-keyed embedding store contract (slice 20b). Drops `rowid` from search
 * hits — pgvector has no implicit rowid, and `KnowledgeService` only ever
 * read `slug` / `distance` / `providerId` off the hits. The sqlite-vec
 * `EmbeddingStore` satisfies this via its `upsertBySlug` / `deleteBySlug`
 * wrappers; `PgVectorEmbeddingStore` satisfies it natively.
 */
export interface EmbeddingSearchHitNarrow {
  slug: string
  distance: number
  providerId: string
}

export interface EmbeddingStorePort {
  isEnabled(): boolean
  upsertBySlug(
    slug: string,
    providerId: string,
    dims: number,
    vector: Float32Array
  ): Awaitable<void>
  deleteBySlug(slug: string): Awaitable<void>
  search(query: Float32Array, k: number): Awaitable<EmbeddingSearchHitNarrow[]>
}

export class KnowledgeNotFoundError extends Error {
  constructor(slug: string) {
    super(`Knowledge entry not found: ${slug}`)
    this.name = 'KnowledgeNotFoundError'
  }
}

export class KnowledgeConflictError extends Error {
  constructor(slug: string, reason: string) {
    super(`Knowledge conflict for ${slug}: ${reason}`)
    this.name = 'KnowledgeConflictError'
  }
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(`Knowledge validation: ${message}`)
    this.name = 'KnowledgeValidationError'
  }
}

export interface KnowledgeServiceDeps {
  knowledge: KnowledgeIndexPort
  projects: KnowledgeProjectPort
  workspaces?: KnowledgeWorkspacePort
  git?: GitOps
  contentRoot?: string
  now?: () => Date
  embeddingStore?: EmbeddingStorePort
  embeddingProvider?: () => Promise<EmbeddingProvider>
}

export class KnowledgeService implements KnowledgeOperations {
  private readonly knowledge: KnowledgeIndexPort
  private readonly projects: KnowledgeProjectPort
  private readonly workspaces: KnowledgeWorkspacePort | null
  private readonly git: GitOps
  private readonly contentRoot: string
  private readonly now: () => Date
  private readonly embeddingStore: EmbeddingStorePort | null
  private readonly embeddingProvider: (() => Promise<EmbeddingProvider>) | null

  constructor(deps: KnowledgeServiceDeps) {
    this.knowledge = deps.knowledge
    this.projects = deps.projects
    this.workspaces = deps.workspaces ?? null
    this.git = deps.git ?? new GitOpsImpl()
    this.contentRoot = deps.contentRoot ?? process.env.CHODA_CONTENT_ROOT ?? ''
    this.now = deps.now ?? ((): Date => new Date())
    this.embeddingStore = deps.embeddingStore ?? null
    this.embeddingProvider = deps.embeddingProvider ?? null
  }

  async createKnowledge(input: CreateKnowledgeInput): Promise<KnowledgeEntry> {
    this.validateInput(input)
    const project = await this.projects.get(input.projectId)
    if (!project) throw new KnowledgeValidationError(`unknown projectId: ${input.projectId}`)

    await this.validateStructured(input)

    const workspaceCwd = await this.resolveWorkspaceCwd(input.projectId, input.workspaceId)

    const slug = input.slug ?? slugify(input.title)
    if (!slug) throw new KnowledgeValidationError('cannot derive slug from title')
    if (await this.knowledge.get(slug)) {
      throw new KnowledgeConflictError(slug, 'slug already exists; pass an explicit slug to disambiguate')
    }

    const stalenessCwd = workspaceCwd ?? project.cwd
    const filePath = this.resolveFilePath(input.scope, project.cwd, slug, workspaceCwd)
    if (isLikelyWorktreePath(filePath)) {
      throw new KnowledgeValidationError(
        `target path is inside a git worktree (${filePath}) — knowledge there would be orphaned when the worktree is removed. Create knowledge from the main checkout instead.`
      )
    }
    if (fs.existsSync(filePath)) {
      throw new KnowledgeConflictError(slug, `file already exists at ${filePath}`)
    }

    const isoDate = toIsoDate(this.now())
    const refs = this.materializeRefs(input.refs, stalenessCwd, input.scope)
    const frontmatter: KnowledgeFrontmatter = {
      type: input.type,
      title: input.title,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      scope: input.scope,
      refs,
      createdAt: isoDate,
      lastVerifiedAt: isoDate,
      structured: input.structured
    }
    const content = serializeFrontmatter(frontmatter, input.body)

    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')

    const indexRow: KnowledgeIndexRow = {
      slug,
      projectId: input.projectId,
      workspaceId: input.workspaceId ?? null,
      scope: input.scope,
      type: input.type,
      title: input.title,
      filePath,
      createdAt: isoDate,
      lastVerifiedAt: isoDate
    }
    await this.knowledge.upsert(indexRow)

    if (input.scope === 'project') {
      if (input.workspaceId && workspaceCwd) {
        await this.regenerateWorkspaceIndexMd(input.projectId, input.workspaceId, workspaceCwd)
      } else {
        await this.regenerateIndexMd(input.projectId, project.cwd)
      }
    }

    this.scheduleEmbed(slug, input.body)

    const staleness = this.computeStaleness(refs, stalenessCwd, input.scope)
    return {
      slug,
      frontmatter,
      body: input.body,
      filePath,
      staleness,
      isStale: staleness.some((s) => s.commitsSince > 0)
    }
  }

  async registerExistingKnowledge(input: RegisterExistingKnowledgeInput): Promise<KnowledgeEntry> {
    if (!fs.existsSync(input.filePath)) {
      throw new KnowledgeValidationError(`file not found: ${input.filePath}`)
    }
    const project = await this.projects.get(input.projectId)
    if (!project) throw new KnowledgeValidationError(`unknown projectId: ${input.projectId}`)
    const workspaceCwd = await this.resolveWorkspaceCwd(input.projectId, input.workspaceId)

    const raw = fs.readFileSync(input.filePath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    if (frontmatter.projectId !== input.projectId) {
      throw new KnowledgeValidationError(
        `frontmatter projectId (${frontmatter.projectId}) does not match input (${input.projectId})`
      )
    }
    if ((frontmatter.workspaceId ?? null) !== (input.workspaceId ?? null)) {
      throw new KnowledgeValidationError(
        `frontmatter workspaceId (${frontmatter.workspaceId ?? 'null'}) does not match input (${input.workspaceId ?? 'null'})`
      )
    }

    const slug = path.basename(input.filePath, '.md')
    if (!slug) throw new KnowledgeValidationError(`cannot derive slug from path: ${input.filePath}`)

    const indexRow: KnowledgeIndexRow = {
      slug,
      projectId: input.projectId,
      workspaceId: input.workspaceId ?? null,
      scope: frontmatter.scope,
      type: frontmatter.type,
      title: frontmatter.title,
      filePath: input.filePath,
      createdAt: frontmatter.createdAt,
      lastVerifiedAt: frontmatter.lastVerifiedAt
    }
    await this.knowledge.upsert(indexRow)

    if (frontmatter.scope === 'project') {
      if (input.workspaceId && workspaceCwd) {
        await this.regenerateWorkspaceIndexMd(input.projectId, input.workspaceId, workspaceCwd)
      } else {
        await this.regenerateIndexMd(input.projectId, project.cwd)
      }
    }

    this.scheduleEmbed(slug, body)

    const stalenessCwd = workspaceCwd ?? project.cwd
    const staleness = this.computeStaleness(frontmatter.refs, stalenessCwd, frontmatter.scope)
    return {
      slug,
      frontmatter,
      body,
      filePath: input.filePath,
      staleness,
      isStale: staleness.some((s) => s.commitsSince > 0)
    }
  }

  private async resolveWorkspaceCwd(projectId: string, workspaceId?: string): Promise<string | null> {
    if (!workspaceId) return null
    if (!this.workspaces) {
      throw new KnowledgeValidationError(
        'workspace repository not configured — cannot resolve workspaceId'
      )
    }
    const ws = await this.workspaces.get(workspaceId)
    if (!ws) throw new KnowledgeValidationError(`unknown workspaceId: ${workspaceId}`)
    if (ws.projectId !== projectId) {
      throw new KnowledgeValidationError(
        `workspace ${workspaceId} belongs to project ${ws.projectId}, not ${projectId}`
      )
    }
    if (!ws.cwd) throw new KnowledgeValidationError(`workspace ${workspaceId} has no cwd`)
    return ws.cwd
  }

  async getKnowledge(slug: string): Promise<KnowledgeEntry | null> {
    const row = await this.knowledge.get(slug)
    if (!row) return null
    if (!fs.existsSync(row.filePath)) return null

    const raw = fs.readFileSync(row.filePath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)

    const cwd = await this.resolveStalenessCwd(row.projectId, row.workspaceId)
    const staleness = this.computeStaleness(frontmatter.refs, cwd, row.scope)

    return {
      slug,
      frontmatter,
      body,
      filePath: row.filePath,
      staleness,
      isStale: staleness.some((s) => s.commitsSince > 0)
    }
  }

  async listKnowledge(filter: KnowledgeListFilter = {}): Promise<KnowledgeListItem[]> {
    const rows = await this.knowledge.list(filter)
    return rows.map((r) => ({
      slug: r.slug,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      scope: r.scope,
      type: r.type,
      title: r.title,
      filePath: r.filePath,
      createdAt: r.createdAt,
      lastVerifiedAt: r.lastVerifiedAt
    }))
  }

  private async resolveStalenessCwd(projectId: string, workspaceId: string | null): Promise<string> {
    if (workspaceId && this.workspaces) {
      const ws = await this.workspaces.get(workspaceId)
      if (ws?.cwd) return ws.cwd
    }
    const project = await this.projects.get(projectId)
    return project?.cwd ?? ''
  }

  async deleteKnowledge(slug: string): Promise<{ slug: string; deletedFile: boolean }> {
    const row = await this.knowledge.get(slug)
    if (!row) throw new KnowledgeNotFoundError(slug)

    let deletedFile = false
    if (fs.existsSync(row.filePath)) {
      fs.unlinkSync(row.filePath)
      deletedFile = true
    }

    /* Embedding delete BEFORE knowledge.delete: pgvector enforces FK
     * (knowledge_embeddings.slug → knowledge_index.slug), so dropping the
     * index row first would fail. SQLite has no such FK but the order
     * works there too. */
    await this.embeddingStore?.deleteBySlug(slug)
    await this.knowledge.delete(slug)

    if (row.scope === 'project') {
      await this.regenerateIndexForRow(row)
    }

    return { slug, deletedFile }
  }

  private async regenerateIndexForRow(row: KnowledgeIndexRow): Promise<void> {
    if (row.workspaceId && this.workspaces) {
      const ws = await this.workspaces.get(row.workspaceId)
      if (ws?.cwd) {
        await this.regenerateWorkspaceIndexMd(row.projectId, row.workspaceId, ws.cwd)
        return
      }
    }
    const project = await this.projects.get(row.projectId)
    if (project) await this.regenerateIndexMd(row.projectId, project.cwd)
  }

  async updateKnowledge(input: UpdateKnowledgeInput): Promise<KnowledgeEntry> {
    if (input.body === undefined && input.refs === undefined) {
      throw new KnowledgeValidationError('updateKnowledge requires body or refs')
    }

    const existing = await this.getKnowledge(input.slug)
    if (!existing) throw new KnowledgeNotFoundError(input.slug)

    const row = await this.knowledge.get(input.slug)
    if (!row) throw new KnowledgeNotFoundError(input.slug)

    const stalenessCwd = await this.resolveStalenessCwd(row.projectId, row.workspaceId)
    const scope = existing.frontmatter.scope

    const newBody = input.body ?? existing.body
    const newRefs: KnowledgeRef[] =
      input.refs !== undefined
        ? this.materializeRefs(input.refs, stalenessCwd, scope)
        : existing.frontmatter.refs.map((r) => ({
            path: r.path,
            commitSha: stalenessCwd ? safeHeadSha(this.git, stalenessCwd) : r.commitSha
          }))

    const isoDate = toIsoDate(this.now())
    const updatedFm: KnowledgeFrontmatter = {
      ...existing.frontmatter,
      refs: newRefs,
      lastVerifiedAt: isoDate
    }

    fs.writeFileSync(existing.filePath, serializeFrontmatter(updatedFm, newBody), 'utf8')
    await this.knowledge.updateLastVerified(input.slug, isoDate)

    if (scope === 'project') {
      await this.regenerateIndexForRow(row)
    }

    if (input.body !== undefined && input.body !== existing.body) {
      this.scheduleEmbed(input.slug, newBody)
    }

    const staleness = this.computeStaleness(newRefs, stalenessCwd, scope)
    return {
      slug: input.slug,
      frontmatter: updatedFm,
      body: newBody,
      filePath: existing.filePath,
      staleness,
      isStale: staleness.some((s) => s.commitsSince > 0)
    }
  }

  async verifyKnowledge(slug: string): Promise<KnowledgeVerifyResult> {
    const entry = await this.getKnowledge(slug)
    if (!entry) throw new KnowledgeNotFoundError(slug)
    const row = await this.knowledge.get(slug)
    if (!row) throw new KnowledgeNotFoundError(slug)

    const isoDate = toIsoDate(this.now())
    await this.knowledge.updateLastVerified(slug, isoDate)

    const stalenessCwd = await this.resolveStalenessCwd(row.projectId, row.workspaceId)
    const refreshedRefs: KnowledgeRef[] = entry.frontmatter.refs.map((r) => {
      const sha = stalenessCwd ? safeHeadSha(this.git, stalenessCwd) : r.commitSha
      return { path: r.path, commitSha: sha }
    })
    const updatedFm: KnowledgeFrontmatter = {
      ...entry.frontmatter,
      refs: refreshedRefs,
      lastVerifiedAt: isoDate
    }
    fs.writeFileSync(entry.filePath, serializeFrontmatter(updatedFm, entry.body), 'utf8')

    if (entry.frontmatter.scope === 'project') {
      await this.regenerateIndexForRow(row)
    }

    const staleness = refreshedRefs.map((r) => ({
      path: r.path,
      commitSha: r.commitSha,
      commitsSince: 0
    }))
    return { slug, refs: staleness, isStale: false, lastVerifiedAt: isoDate }
  }

  // TASK-988: structured-field validation for the first-class types. A gotcha's
  // affectedFeatureId must resolve to an existing `feature` entry — otherwise the
  // ABOUT edge dangles. Other structured fields (effortBand/status enums) are
  // validated in the frontmatter layer.
  private async validateStructured(input: CreateKnowledgeInput): Promise<void> {
    const featureId = input.structured?.affectedFeatureId
    if (!featureId) return
    const target = await this.knowledge.get(featureId)
    if (!target) {
      throw new KnowledgeValidationError(
        `affectedFeatureId "${featureId}" does not resolve to a known knowledge entry`
      )
    }
    if (target.type !== 'feature') {
      throw new KnowledgeValidationError(
        `affectedFeatureId "${featureId}" is a ${target.type}, expected a feature`
      )
    }
  }

  private validateInput(input: CreateKnowledgeInput): void {
    if (!KNOWLEDGE_TYPES.includes(input.type)) {
      throw new KnowledgeValidationError(`invalid type: ${input.type}`)
    }
    if (!KNOWLEDGE_SCOPES.includes(input.scope)) {
      throw new KnowledgeValidationError(`invalid scope: ${input.scope}`)
    }
    if (!input.title.trim()) throw new KnowledgeValidationError('title required')
    if (input.scope === 'cross' && !this.contentRoot) {
      throw new KnowledgeValidationError(
        'CHODA_CONTENT_ROOT not set — required for scope=cross'
      )
    }
  }

  private resolveFilePath(
    scope: 'project' | 'cross',
    projectCwd: string,
    slug: string,
    workspaceCwd: string | null
  ): string {
    if (scope === 'project') {
      const cwd = workspaceCwd ?? projectCwd
      return path.join(cwd, 'docs', 'knowledge', `${slug}.md`)
    }
    return path.join(this.contentRoot, '30-Knowledge', `${slug}.md`)
  }

  private materializeRefs(
    inputRefs: CreateKnowledgeInput['refs'],
    projectCwd: string,
    scope: 'project' | 'cross'
  ): KnowledgeRef[] {
    if (inputRefs.length === 0) return []
    if (scope === 'cross') {
      return inputRefs
        .filter((r) => r.commitSha)
        .map((r) => ({ path: r.path, commitSha: r.commitSha as string }))
    }
    const headSha = safeHeadSha(this.git, projectCwd)
    return inputRefs.map((r) => ({
      path: r.path,
      commitSha: r.commitSha ?? headSha
    }))
  }

  private computeStaleness(
    refs: KnowledgeRef[],
    projectCwd: string,
    scope: 'project' | 'cross'
  ): KnowledgeRefStaleness[] {
    if (scope !== 'project' || !projectCwd) {
      return refs.map((r) => ({ path: r.path, commitSha: r.commitSha, commitsSince: 0 }))
    }
    return refs.map((r) => {
      let commitsSince = 0
      try {
        commitsSince = this.git.countCommitsSince(projectCwd, r.commitSha, r.path)
      } catch {
        commitsSince = -1
      }
      return { path: r.path, commitSha: r.commitSha, commitsSince }
    })
  }

  private async regenerateIndexMd(projectId: string, projectCwd: string): Promise<void> {
    const rows = await this.knowledge.list({ projectId, workspaceId: null, scope: 'project' })
    this.writeIndexMd(projectCwd, `Knowledge — ${projectId}`, rows)
  }

  private async regenerateWorkspaceIndexMd(
    projectId: string,
    workspaceId: string,
    workspaceCwd: string
  ): Promise<void> {
    // Guard against resurrecting a deleted worktree: writeIndexMd() does
    // mkdirSync(recursive) which would silently rebuild docs/knowledge/ inside
    // a workspace whose cwd has been removed (e.g. orphan worktrees handled by
    // cleanup_worktree_orphans). Skip the regen — the workspace is gone.
    if (!fs.existsSync(workspaceCwd)) return
    const rows = await this.knowledge.list({ projectId, workspaceId, scope: 'project' })
    this.writeIndexMd(workspaceCwd, `Knowledge — ${projectId}/${workspaceId}`, rows)
  }

  private writeIndexMd(cwd: string, heading: string, rows: KnowledgeIndexRow[]): void {
    const indexPath = path.join(cwd, 'docs', 'knowledge', 'INDEX.md')
    const lines: string[] = ['# ' + heading, '']
    if (rows.length === 0) {
      lines.push('_No entries yet._')
    } else {
      lines.push('| Slug | Type | Title | Last verified | Stale |')
      lines.push('|------|------|-------|---------------|-------|')
      for (const r of rows) {
        const flag = this.isEntryStale(r, cwd) ? '✱' : ''
        lines.push(
          `| [${r.slug}](./${r.slug}.md) | ${r.type} | ${escapeMd(r.title)} | ${r.lastVerifiedAt.slice(0, 10)} | ${flag} |`
        )
      }
    }
    lines.push('')
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf8')
  }

  private isEntryStale(row: KnowledgeIndexRow, projectCwd: string): boolean {
    try {
      const raw = fs.readFileSync(row.filePath, 'utf8')
      const { frontmatter } = parseFrontmatter(raw)
      const staleness = this.computeStaleness(frontmatter.refs, projectCwd, row.scope)
      return staleness.some((s) => s.commitsSince > 0)
    } catch {
      return false
    }
  }

  async searchKnowledge(query: string, k = 5): Promise<KnowledgeSearchResult> {
    if (!this.embeddingStore || !this.embeddingProvider) {
      return { enabled: false, reason: 'embedding store not configured', results: [] }
    }
    let provider: EmbeddingProvider
    try {
      provider = await this.embeddingProvider()
    } catch (err) {
      return { enabled: false, reason: (err as Error).message, results: [] }
    }
    if (!this.embeddingStore.isEnabled() || provider.id === 'noop') {
      return {
        enabled: false,
        reason: 'embedding store or embedding deps unavailable',
        providerId: provider.id,
        results: []
      }
    }
    let vec: Float32Array
    try {
      vec = await provider.embed(query)
    } catch (err) {
      return {
        enabled: false,
        reason: `embed failed: ${(err as Error).message}`,
        providerId: provider.id,
        results: []
      }
    }
    const hits = await this.embeddingStore.search(vec, Math.max(1, k))
    const rows = await Promise.all(hits.map((h) => this.knowledge.get(h.slug)))
    const results = hits
      .map((h, i) => {
        const row = rows[i]
        if (!row) return null
        return {
          slug: row.slug,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          scope: row.scope,
          type: row.type,
          title: row.title,
          filePath: row.filePath,
          createdAt: row.createdAt,
          lastVerifiedAt: row.lastVerifiedAt,
          distance: h.distance
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    return { enabled: true, providerId: provider.id, results }
  }

  // Fire-and-forget embed. Failures log a warning but never reject — the row
  // stays in knowledge_index without a vector and is filtered out of search
  // until a backfill pass picks it up.
  private scheduleEmbed(slug: string, body: string): void {
    if (!this.embeddingStore || !this.embeddingProvider) return
    void (async (): Promise<void> => {
      try {
        const provider = await this.embeddingProvider!()
        if (!this.embeddingStore!.isEnabled() || provider.id === 'noop') return
        const vec = await provider.embed(body)
        await this.embeddingStore!.upsertBySlug(slug, provider.id, provider.dims, vec)
      } catch (err) {
        console.warn(
          `[choda-deck] embed failed for knowledge ${slug}:`,
          (err as Error).message
        )
      }
    })()
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function safeHeadSha(git: GitOps, cwd: string): string {
  try {
    return git.getHeadSha(cwd)
  } catch {
    return ''
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|')
}
