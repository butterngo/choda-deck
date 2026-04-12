import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { NodeType, RelationType, buildUid } from './graph-types'
import {
  normalizeDependsOn,
  extractTaskId,
  extractFeatureId,
  extractDecisionId,
  extractWikilinks,
  VaultParser
} from './vault-parser'

// ── Helper unit tests ──────────────────────────────────────────────────────────

describe('normalizeDependsOn', () => {
  it('parses comma-separated string', () => {
    expect(normalizeDependsOn('TASK-126, TASK-127')).toEqual(['TASK-126', 'TASK-127'])
  })

  it('parses YAML array', () => {
    expect(normalizeDependsOn(['F-02', 'F-09'])).toEqual(['F-02', 'F-09'])
  })

  it('returns empty for null/undefined', () => {
    expect(normalizeDependsOn(null)).toEqual([])
    expect(normalizeDependsOn(undefined)).toEqual([])
  })

  it('returns empty for empty string', () => {
    expect(normalizeDependsOn('')).toEqual([])
  })

  it('returns empty for empty array', () => {
    expect(normalizeDependsOn([])).toEqual([])
  })

  it('trims whitespace from comma-separated values', () => {
    expect(normalizeDependsOn('  TASK-001 ,  TASK-002  ')).toEqual(['TASK-001', 'TASK-002'])
  })
})

describe('extractTaskId', () => {
  it('extracts TASK-nnn from filename', () => {
    expect(extractTaskId('TASK-130_auto-assignment.md')).toBe('TASK-130')
  })

  it('extracts BUG-nnn from filename', () => {
    expect(extractTaskId('BUG-001_scheduler-fix.md')).toBe('BUG-001')
  })

  it('handles subtask suffix (TASK-024a)', () => {
    expect(extractTaskId('TASK-024a_quartz-tuning.md')).toBe('TASK-024a')
  })

  it('falls back to filename without .md', () => {
    expect(extractTaskId('random-file.md')).toBe('random-file')
  })
})

describe('extractFeatureId', () => {
  it('extracts F-nn from filename', () => {
    expect(extractFeatureId('F-01-project-crud.md')).toBe('F-01')
    expect(extractFeatureId('F-16-auto-assignment.md')).toBe('F-16')
  })

  it('falls back to filename without .md', () => {
    expect(extractFeatureId('action-catalog.md')).toBe('action-catalog')
  })
})

describe('extractDecisionId', () => {
  it('normalizes ADR-nnn to adr-nnn', () => {
    expect(extractDecisionId('ADR-007-authentication-architecture.md')).toBe('adr-007')
  })

  it('handles lowercase adr- prefix', () => {
    expect(extractDecisionId('adr-001-custom-fields-eav.md')).toBe('adr-001')
  })

  it('handles number-only prefix', () => {
    expect(extractDecisionId('0001-quartz-cron-normalization.md')).toBe('adr-0001')
  })

  it('falls back to filename without .md', () => {
    expect(extractDecisionId('some-decision.md')).toBe('some-decision')
  })
})

describe('extractWikilinks', () => {
  it('extracts wikilinks from named section', () => {
    const content = `---
feature: test
---

## Context
Some text

## Related

- [[adr-007-transition-actions]]
- [[TASK-130_auto-assignment]]

## Next
More text`

    expect(extractWikilinks(content, 'Related')).toEqual([
      'adr-007-transition-actions',
      'TASK-130_auto-assignment'
    ])
  })

  it('returns empty when section not found', () => {
    expect(extractWikilinks('## Other\nsome text', 'Related')).toEqual([])
  })

  it('handles section at end of file (no next section)', () => {
    const content = `## Related

- [[adr-001]]
- [[adr-002]]`

    expect(extractWikilinks(content, 'Related')).toEqual(['adr-001', 'adr-002'])
  })

  it('does not bleed into next section', () => {
    const content = `## Related

- [[adr-001]]

## Other

- [[adr-999]]`

    expect(extractWikilinks(content, 'Related')).toEqual(['adr-001'])
  })
})

// ── VaultParser integration tests (temp fixture) ──────────────────────────────

describe('VaultParser', () => {
  const tmpVault = path.join(__dirname, '__test-vault__')

  beforeAll(() => {
    // Build minimal vault fixture
    const dirs = [
      '10-Projects/alpha/tasks',
      '10-Projects/alpha/features',
      '10-Projects/alpha/docs/decisions',
      '90-Archive/alpha'
    ]
    for (const d of dirs) {
      fs.mkdirSync(path.join(tmpVault, d), { recursive: true })
    }

    // Feature F-01
    fs.writeFileSync(
      path.join(tmpVault, '10-Projects/alpha/features/F-01-login.md'),
      `---
feature: Login
status: done
priority: high
depends-on: []
---

## Scope
User login feature.

## Related

- [[adr-001-auth-strategy]]
`
    )

    // Feature F-02 depends on F-01
    fs.writeFileSync(
      path.join(tmpVault, '10-Projects/alpha/features/F-02-dashboard.md'),
      `---
feature: Dashboard
status: planning
priority: medium
depends-on: [F-01]
---

## Scope
Dashboard feature.
`
    )

    // Decision ADR-001
    fs.writeFileSync(
      path.join(tmpVault, '10-Projects/alpha/docs/decisions/ADR-001-auth-strategy.md'),
      `---
date: 2026-01-15
status: accepted
---

# ADR: Auth Strategy

## Context
Chose JWT over session cookies.
`
    )

    // Task TASK-100 depends on TASK-101, implements F-01
    fs.writeFileSync(
      path.join(tmpVault, '10-Projects/alpha/tasks/TASK-100_implement-login.md'),
      `---
id: TASK-100
title: Implement login page
status: done
priority: high
feature: F-01
project: alpha
depends-on: TASK-101
created: 2026-02-01
---

## Context
Build the login page.
`
    )

    // Task TASK-101
    fs.writeFileSync(
      path.join(tmpVault, '10-Projects/alpha/tasks/TASK-101_auth-api.md'),
      `---
id: TASK-101
title: Auth API endpoint
status: done
priority: high
project: alpha
created: 2026-01-20
---

## Context
Auth backend.
`
    )

    // Archived task
    fs.writeFileSync(
      path.join(tmpVault, '90-Archive/alpha/TASK-050_old-spike.md'),
      `---
id: TASK-050
title: Old spike
status: done
priority: low
project: alpha
created: 2026-01-01
---

## Context
Archived spike.
`
    )
  })

  afterAll(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true })
  })

  // Override PROJECT_CONFIGS for test — parser uses hardcoded configs,
  // so we need a custom parser approach. We'll test with the real parser
  // but point it at a vault that has a project matching one of the known configs.
  // Since 'alpha' is not in PROJECT_CONFIGS, we need to use a known project name.
  // Let's rebuild with 'task-management' as project name.

  let result: ReturnType<VaultParser['parse']>

  beforeAll(() => {
    // Rebuild fixture under 'task-management' to match PROJECT_CONFIGS
    const tmDirs = [
      '10-Projects/task-management/tasks',
      '10-Projects/task-management/features',
      '10-Projects/task-management/docs/decisions',
      '90-Archive/task-management'
    ]
    for (const d of tmDirs) {
      fs.mkdirSync(path.join(tmpVault, d), { recursive: true })
    }

    // Copy files to task-management dirs
    const featSrc = path.join(tmpVault, '10-Projects/alpha/features')
    const featDst = path.join(tmpVault, '10-Projects/task-management/features')
    for (const f of fs.readdirSync(featSrc)) {
      fs.copyFileSync(path.join(featSrc, f), path.join(featDst, f))
    }

    const decSrc = path.join(tmpVault, '10-Projects/alpha/docs/decisions')
    const decDst = path.join(tmpVault, '10-Projects/task-management/docs/decisions')
    for (const f of fs.readdirSync(decSrc)) {
      fs.copyFileSync(path.join(decSrc, f), path.join(decDst, f))
    }

    const taskSrc = path.join(tmpVault, '10-Projects/alpha/tasks')
    const taskDst = path.join(tmpVault, '10-Projects/task-management/tasks')
    for (const f of fs.readdirSync(taskSrc)) {
      fs.copyFileSync(path.join(taskSrc, f), path.join(taskDst, f))
    }

    const archSrc = path.join(tmpVault, '90-Archive/alpha')
    const archDst = path.join(tmpVault, '90-Archive/task-management')
    for (const f of fs.readdirSync(archSrc)) {
      fs.copyFileSync(path.join(archSrc, f), path.join(archDst, f))
    }

    const parser = new VaultParser(tmpVault)
    result = parser.parse()
  })

  it('creates project node', () => {
    const proj = result.nodes.find(
      n => n.type === NodeType.Project && n.project === 'task-management'
    )
    expect(proj).toBeDefined()
    expect(proj!.uid).toBe('project:task-management/task-management')
  })

  it('parses feature nodes', () => {
    const features = result.nodes.filter(n => n.type === NodeType.Feature)
    expect(features.length).toBe(2)
    expect(features.map(f => f.id).sort()).toEqual(['F-01', 'F-02'])
  })

  it('parses decision nodes', () => {
    const decisions = result.nodes.filter(n => n.type === NodeType.Decision)
    expect(decisions.length).toBe(1)
    expect(decisions[0].id).toBe('adr-001')
    expect(decisions[0].title).toBe('Auth Strategy')
  })

  it('parses task nodes', () => {
    const tasks = result.nodes.filter(
      n => n.type === NodeType.Task && n.status !== 'archived'
    )
    expect(tasks.length).toBe(2)
    expect(tasks.map(t => t.id).sort()).toEqual(['TASK-100', 'TASK-101'])
  })

  it('marks archived tasks with status "archived"', () => {
    const archived = result.nodes.find(n => n.id === 'TASK-050')
    expect(archived).toBeDefined()
    expect(archived!.status).toBe('archived')
  })

  it('creates DEPENDS_ON edges for tasks', () => {
    const depEdges = result.edges.filter(
      e =>
        e.relation === RelationType.DependsOn &&
        e.source === buildUid(NodeType.Task, 'task-management', 'TASK-100')
    )
    expect(depEdges.length).toBe(1)
    // depends-on target uses fm.project (alpha) from frontmatter
    expect(depEdges[0].target).toBe(buildUid(NodeType.Task, 'alpha', 'TASK-101'))
  })

  it('creates IMPLEMENTS edges', () => {
    const implEdges = result.edges.filter(e => e.relation === RelationType.Implements)
    expect(implEdges.length).toBe(1)
    expect(implEdges[0].source).toBe(
      buildUid(NodeType.Task, 'task-management', 'TASK-100')
    )
    expect(implEdges[0].target).toBe(
      buildUid(NodeType.Feature, 'task-management', 'F-01')
    )
  })

  it('creates DEPENDS_ON edges for features (YAML array)', () => {
    const depEdges = result.edges.filter(
      e =>
        e.relation === RelationType.DependsOn &&
        e.source === buildUid(NodeType.Feature, 'task-management', 'F-02')
    )
    expect(depEdges.length).toBe(1)
    expect(depEdges[0].target).toBe(
      buildUid(NodeType.Feature, 'task-management', 'F-01')
    )
  })

  it('creates DECIDED_BY edges from wikilinks', () => {
    const decidedEdges = result.edges.filter(e => e.relation === RelationType.DecidedBy)
    expect(decidedEdges.length).toBe(1)
    expect(decidedEdges[0].source).toBe(
      buildUid(NodeType.Feature, 'task-management', 'F-01')
    )
    expect(decidedEdges[0].target).toBe(
      buildUid(NodeType.Decision, 'task-management', 'adr-001')
    )
  })

  it('creates PART_OF edges for all non-project nodes', () => {
    const partOfEdges = result.edges.filter(e => e.relation === RelationType.PartOf)
    const nonProjectNodes = result.nodes.filter(n => n.type !== NodeType.Project)
    // Every non-project node in task-management should have a part-of edge
    const tmNodes = nonProjectNodes.filter(n => n.project === 'task-management')
    expect(partOfEdges.filter(
      e => e.target === buildUid(NodeType.Project, 'task-management', 'task-management')
    ).length).toBe(tmNodes.length)
  })

  it('summary has correct totals', () => {
    expect(result.summary.duplicateUids.length).toBe(0)
    expect(result.summary.unresolvedReferences.length).toBe(0)
    // task-management: 1 project + 2 features + 1 decision + 2 tasks + 1 archived = 7
    // other projects (automation-rule, choda-deck, Mantu) won't have data = just project nodes
    // but they may not exist in temp vault, so only task-management project node is created
    expect(result.summary.nodesByType[NodeType.Task]).toBe(3) // 2 active + 1 archived
    expect(result.summary.nodesByType[NodeType.Feature]).toBe(2)
    expect(result.summary.nodesByType[NodeType.Decision]).toBe(1)
  })

  it('reports duplicate UIDs when they exist', () => {
    // Create vault with duplicate task files
    const dupVault = path.join(__dirname, '__test-vault-dup__')
    fs.mkdirSync(path.join(dupVault, '10-Projects/task-management/tasks'), { recursive: true })

    const taskContent = `---
id: TASK-001
title: Duplicate task
status: open
priority: high
project: task-management
created: 2026-01-01
---
## Context
Duplicate.
`
    fs.writeFileSync(
      path.join(dupVault, '10-Projects/task-management/tasks/TASK-001_first.md'),
      taskContent
    )
    fs.writeFileSync(
      path.join(dupVault, '10-Projects/task-management/tasks/TASK-001_second.md'),
      taskContent
    )

    const parser = new VaultParser(dupVault)
    const dupResult = parser.parse()

    expect(dupResult.summary.duplicateUids.length).toBe(1)
    expect(dupResult.summary.duplicateUids[0]).toBe(
      buildUid(NodeType.Task, 'task-management', 'TASK-001')
    )

    fs.rmSync(dupVault, { recursive: true, force: true })
  })
})
