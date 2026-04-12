#!/usr/bin/env ts-node
/**
 * Vault Parser — parse markdown files into graph JSON
 * Usage: npx ts-node src/graph/vault-parser.ts --vault-path <path>
 */

import * as fs from 'fs'
import * as path from 'path'
import matter from 'gray-matter'
import {
  NodeType,
  RelationType,
  buildUid,
  type Uid,
  type GraphNode,
  type GraphEdge
} from './graph-types'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ImportSummary {
  totalNodes: number
  totalEdges: number
  nodesByType: Record<string, number>
  edgesByType: Record<string, number>
  unresolvedReferences: string[]
  duplicateUids: string[]
}

export interface ParsedVaultGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  summary: ImportSummary
}

interface ProjectConfig {
  name: string
  basePath: string
  tasksDir?: string
  featuresDir?: string
  decisionsDir?: string
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECTS_DIR = '10-Projects'
const ARCHIVE_DIR = '90-Archive'

const PROJECT_CONFIGS: Record<string, Partial<ProjectConfig>> = {
  'task-management': {
    tasksDir: 'tasks',
    featuresDir: 'features',
    decisionsDir: 'docs/decisions'
  },
  'automation-rule': {
    tasksDir: 'tasks',
    featuresDir: 'features',
    decisionsDir: 'workflow-engine/docs/decisions'
  },
  'choda-deck': {
    tasksDir: 'tasks',
    featuresDir: undefined,
    decisionsDir: 'docs/decisions'
  },
  'Mantu': {
    tasksDir: 'tasks',
    featuresDir: undefined,
    decisionsDir: undefined
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function readMdFiles(dir: string): Array<{ filePath: string; content: string }> {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      filePath: path.join(dir, f),
      content: fs.readFileSync(path.join(dir, f), 'utf-8')
    }))
}

export function normalizeDependsOn(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string') {
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

export function extractTaskId(filename: string): string {
  // TASK-130_auto-assignment.md → TASK-130
  // BUG-001_scheduler.md → BUG-001
  const match = filename.match(/^((?:TASK|BUG)-\d+[a-z]?)/)
  return match ? match[1] : filename.replace('.md', '')
}

export function extractFeatureId(filename: string): string {
  // F-01-project-crud.md → F-01
  const match = filename.match(/^(F-\d+)/)
  return match ? match[1] : filename.replace('.md', '')
}

export function extractDecisionId(filename: string): string {
  // ADR-007-authentication-architecture.md → adr-007
  // adr-001-custom-fields-eav.md → adr-001
  // 0001-quartz-cron-normalization.md → adr-0001
  const match = filename.match(/^(?:ADR-|adr-)(\d+)/i)
  if (match) return `adr-${match[1]}`
  const numMatch = filename.match(/^(\d+)/)
  if (numMatch) return `adr-${numMatch[1]}`
  return filename.replace('.md', '')
}

export function extractWikilinks(content: string, sectionName: string): string[] {
  // Find section and extract [[...]] wikilinks from it
  const sectionRegex = new RegExp(`^## ${sectionName}\\s*$`, 'm')
  const sectionMatch = sectionRegex.exec(content)
  if (!sectionMatch) return []

  const afterSection = content.slice(sectionMatch.index + sectionMatch[0].length)
  const nextSection = afterSection.search(/^## /m)
  const sectionBody = nextSection === -1 ? afterSection : afterSection.slice(0, nextSection)

  const links: string[] = []
  const wikiRegex = /\[\[([^\]]+)\]\]/g
  let m
  while ((m = wikiRegex.exec(sectionBody)) !== null) {
    links.push(m[1])
  }
  return links
}

function now(): string {
  return new Date().toISOString()
}

// ── Parser ─────────────────────────────────────────────────────────────────────

export class VaultParser {
  private vaultPath: string
  private nodes: Map<Uid, GraphNode> = new Map()
  private edges: GraphEdge[] = []
  private featureNameMap: Map<string, Uid> = new Map() // name → uid
  private deferredEdges: Array<{ source: Uid; targetName: string; relation: RelationType }> = []
  private unresolvedReferences: string[] = []
  private duplicateUids: string[] = []

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath
  }

  parse(): ParsedVaultGraph {
    // Phase 1: Create project nodes + parse all files into nodes
    for (const [projectName, config] of Object.entries(PROJECT_CONFIGS)) {
      this.parseProject(projectName, config)
    }

    // Phase 1b: Parse archive
    this.parseArchive()

    // Phase 2: Resolve deferred name-based feature references
    for (const deferred of this.deferredEdges) {
      const resolved = this.featureNameMap.get(deferred.targetName.toLowerCase())
      if (resolved) {
        this.addEdge(deferred.source, resolved, deferred.relation)
      } else {
        this.unresolvedReferences.push(
          `unresolved:feature-dep:${deferred.source}→${deferred.targetName}`
        )
      }
    }

    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      summary: this.buildSummary()
    }
  }

  private parseProject(projectName: string, config: Partial<ProjectConfig>): void {
    const projectBase = path.join(this.vaultPath, PROJECTS_DIR, projectName)
    if (!fs.existsSync(projectBase)) {
      console.warn(`⚠ Project dir not found: ${projectBase}`)
      return
    }

    // Project node
    const projectUid = buildUid(NodeType.Project, projectName, projectName)
    this.addNode({
      uid: projectUid,
      type: NodeType.Project,
      project: projectName,
      id: projectName,
      title: projectName,
      createdAt: now(),
      updatedAt: now()
    })

    // Features first (so featureNameMap is populated before tasks)
    if (config.featuresDir) {
      const featuresPath = path.join(projectBase, config.featuresDir)
      for (const file of readMdFiles(featuresPath)) {
        this.parseFeature(file.filePath, file.content, projectName)
      }
    }

    // Decisions
    if (config.decisionsDir) {
      const decisionsPath = path.join(projectBase, config.decisionsDir)
      for (const file of readMdFiles(decisionsPath)) {
        this.parseDecision(file.filePath, file.content, projectName)
      }
    }

    // Tasks
    if (config.tasksDir) {
      const tasksPath = path.join(projectBase, config.tasksDir)
      for (const file of readMdFiles(tasksPath)) {
        this.parseTask(file.filePath, file.content, projectName, false)
      }
    }
  }

  private parseArchive(): void {
    const archiveBase = path.join(this.vaultPath, ARCHIVE_DIR)
    if (!fs.existsSync(archiveBase)) return

    // Only scan known projects — skip inbox-*, conversations, etc.
    const knownProjects = new Set(Object.keys(PROJECT_CONFIGS))

    for (const dirName of fs.readdirSync(archiveBase)) {
      if (!knownProjects.has(dirName)) continue
      const projectArchive = path.join(archiveBase, dirName)
      if (!fs.statSync(projectArchive).isDirectory()) continue

      for (const file of readMdFiles(projectArchive)) {
        const filename = path.basename(file.filePath)
        if (filename.match(/^(TASK|BUG)-/)) {
          this.parseTask(file.filePath, file.content, dirName, true)
        } else if (filename.match(/^F-\d+/)) {
          this.parseFeature(file.filePath, file.content, dirName, true)
        } else if (filename.match(/^(ADR-|adr-|\d{4})/i)) {
          this.parseDecision(file.filePath, file.content, dirName, true)
        }
      }
    }
  }

  private parseTask(
    filePath: string,
    content: string,
    project: string,
    archived: boolean
  ): void {
    const filename = path.basename(filePath)
    const id = extractTaskId(filename)

    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      console.warn(`⚠ No valid frontmatter: ${filePath}`)
      this.unresolvedReferences.push(`skip:no-frontmatter:${filePath}`)
      return
    }

    const fm = parsed.data
    if (!fm || Object.keys(fm).length === 0) {
      console.warn(`⚠ Empty frontmatter: ${filePath}`)
      this.unresolvedReferences.push(`skip:empty-frontmatter:${filePath}`)
      return
    }

    const uid = buildUid(NodeType.Task, project, id)
    this.addNode({
      uid,
      type: NodeType.Task,
      project,
      id,
      title: fm.title || id,
      status: archived ? 'archived' : fm.status || undefined,
      priority: fm.priority || undefined,
      labels: fm.labels || undefined,
      properties: fm.scope ? { scope: fm.scope } : undefined,
      createdAt: fm.created || now(),
      updatedAt: now()
    })

    // PART_OF project
    this.addEdge(uid, buildUid(NodeType.Project, project, project), RelationType.PartOf)

    // DEPENDS_ON
    for (const dep of normalizeDependsOn(fm['depends-on'])) {
      const depId = dep.trim()
      const targetUid = buildUid(NodeType.Task, fm.project || project, depId)
      this.addEdge(uid, targetUid, RelationType.DependsOn)
    }

    // IMPLEMENTS feature
    if (fm.feature) {
      const featureId = String(fm.feature)
      const targetUid = buildUid(NodeType.Feature, project, featureId)
      this.addEdge(uid, targetUid, RelationType.Implements)
    }
  }

  private parseFeature(
    filePath: string,
    content: string,
    project: string,
    archived = false
  ): void {
    const filename = path.basename(filePath)
    const id = extractFeatureId(filename)

    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      console.warn(`⚠ No valid frontmatter: ${filePath}`)
      this.unresolvedReferences.push(`skip:no-frontmatter:${filePath}`)
      return
    }

    const fm = parsed.data
    const featureName = fm.feature || filename.replace('.md', '')
    const uid = buildUid(NodeType.Feature, project, id)

    // Register name → uid mapping for name-based resolution
    this.featureNameMap.set(featureName.toLowerCase(), uid)
    // Also register by filename stem (e.g. "action-catalog")
    this.featureNameMap.set(filename.replace('.md', '').toLowerCase(), uid)

    this.addNode({
      uid,
      type: NodeType.Feature,
      project,
      id,
      title: featureName,
      status: archived ? 'archived' : fm.status || undefined,
      priority: fm.priority || undefined,
      createdAt: now(),
      updatedAt: now()
    })

    // PART_OF project
    this.addEdge(uid, buildUid(NodeType.Project, project, project), RelationType.PartOf)

    // DEPENDS_ON
    for (const dep of normalizeDependsOn(fm['depends-on'])) {
      const depStr = dep.trim()
      // Could be F-xx ID or a name reference
      if (depStr.match(/^F-\d+$/)) {
        this.addEdge(uid, buildUid(NodeType.Feature, project, depStr), RelationType.DependsOn)
      } else {
        // Name-based — defer to phase 2 when all features are registered
        this.deferredEdges.push({ source: uid, targetName: depStr, relation: RelationType.DependsOn })
      }
    }

    // DECIDED_BY from wikilinks in ## Related / ## Decisions sections
    const wikilinks = [
      ...extractWikilinks(content, 'Related'),
      ...extractWikilinks(content, 'Decisions')
    ]
    for (const link of wikilinks) {
      const adrMatch = link.match(/^(?:ADR-|adr-)(\d+)/i)
      if (adrMatch) {
        const decisionId = `adr-${adrMatch[1]}`
        // Try to find which project owns this decision
        const targetUid = this.resolveDecisionUid(decisionId, project)
        this.addEdge(uid, targetUid, RelationType.DecidedBy)
      }
    }
  }

  private parseDecision(
    filePath: string,
    content: string,
    project: string,
    archived = false
  ): void {
    const filename = path.basename(filePath)
    const id = extractDecisionId(filename)

    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      parsed = { data: {}, content } as matter.GrayMatterFile<string>
    }

    const fm = parsed.data
    // Extract title from first # heading if no frontmatter title
    let title = fm.title || ''
    if (!title) {
      const headingMatch = content.match(/^#\s+(?:ADR:\s*)?(.+)$/m)
      title = headingMatch ? headingMatch[1].trim() : id
    }

    const uid = buildUid(NodeType.Decision, project, id)
    this.addNode({
      uid,
      type: NodeType.Decision,
      project,
      id,
      title,
      status: archived ? 'archived' : fm.status || undefined,
      properties: fm.date ? { date: fm.date } : undefined,
      createdAt: fm.date || now(),
      updatedAt: now()
    })

    // PART_OF project
    this.addEdge(uid, buildUid(NodeType.Project, project, project), RelationType.PartOf)
  }

  private resolveDecisionUid(decisionId: string, defaultProject: string): Uid {
    // Search existing nodes for this decision across all projects
    const nodesArr = Array.from(this.nodes.values())
    for (const node of nodesArr) {
      if (node.type === NodeType.Decision && node.id === decisionId) {
        return node.uid
      }
    }
    // Fallback: assume same project
    return buildUid(NodeType.Decision, defaultProject, decisionId)
  }

  private addNode(node: GraphNode): void {
    if (this.nodes.has(node.uid)) {
      this.duplicateUids.push(node.uid)
      console.warn(`⚠ Duplicate UID: ${node.uid}`)
      return
    }
    this.nodes.set(node.uid, node)
  }

  private addEdge(source: Uid, target: Uid, relation: RelationType): void {
    this.edges.push({ source, target, relation })
  }

  private buildSummary(): ImportSummary {
    const nodesByType: Record<string, number> = {}
    this.nodes.forEach((node) => {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1
    })

    const edgesByType: Record<string, number> = {}
    for (const edge of this.edges) {
      edgesByType[edge.relation] = (edgesByType[edge.relation] || 0) + 1
    }

    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.length,
      nodesByType,
      edgesByType,
      unresolvedReferences: this.unresolvedReferences,
      duplicateUids: this.duplicateUids
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const vaultIdx = args.indexOf('--vault-path')
  if (vaultIdx === -1 || !args[vaultIdx + 1]) {
    console.error('Usage: npx ts-node src/graph/vault-parser.ts --vault-path <path>')
    process.exit(1)
  }

  const vaultPath = path.resolve(args[vaultIdx + 1])
  if (!fs.existsSync(vaultPath)) {
    console.error(`Vault path not found: ${vaultPath}`)
    process.exit(1)
  }

  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.join(process.cwd(), 'vault-graph.json')

  console.log(`Parsing vault: ${vaultPath}`)
  const parser = new VaultParser(vaultPath)
  const result = parser.parse()

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8')
  console.log(`\nOutput: ${outPath}`)
  console.log('\n── Summary ──')
  console.log(`Nodes: ${result.summary.totalNodes}`)
  for (const [type, count] of Object.entries(result.summary.nodesByType)) {
    console.log(`  ${type}: ${count}`)
  }
  console.log(`Edges: ${result.summary.totalEdges}`)
  for (const [type, count] of Object.entries(result.summary.edgesByType)) {
    console.log(`  ${type}: ${count}`)
  }
  if (result.summary.unresolvedReferences.length > 0) {
    console.log(`\n⚠ Unresolved references (${result.summary.unresolvedReferences.length}):`)
    for (const ref of result.summary.unresolvedReferences) {
      console.log(`  ${ref}`)
    }
  }
  if (result.summary.duplicateUids.length > 0) {
    console.log(`\n✗ Duplicate UIDs (${result.summary.duplicateUids.length}):`)
    for (const uid of result.summary.duplicateUids) {
      console.log(`  ${uid}`)
    }
  }
}

if (require.main === module) {
  main()
}
