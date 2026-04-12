import { describe, it, expect } from 'vitest'
import { buildUid, NodeType } from './graph-types'

describe('buildUid', () => {
  it('formats uid as type:project/id', () => {
    expect(buildUid(NodeType.Task, 'task-management', 'TASK-130')).toBe(
      'task:task-management/TASK-130'
    )
  })

  it('works for all NodeType values', () => {
    expect(buildUid(NodeType.Feature, 'proj', 'F-1')).toBe('feature:proj/F-1')
    expect(buildUid(NodeType.Decision, 'proj', 'ADR-001')).toBe('decision:proj/ADR-001')
    expect(buildUid(NodeType.Project, 'meta', 'choda-deck')).toBe('project:meta/choda-deck')
  })

  it('handles special characters in project and id', () => {
    expect(buildUid(NodeType.Task, 'my-repo', 'feat/branch-name')).toBe(
      'task:my-repo/feat/branch-name'
    )
  })
})
