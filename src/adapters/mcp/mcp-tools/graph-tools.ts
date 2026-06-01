import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type { Relationship, RelationType } from '../../../core/domain/task-types'

// ADR-NNN Pillar 3 edge types stored in the generic `relationships` table.
// DEPENDS_ON etc. share the table but are surfaced via task_context/dependencies;
// this tool is the query surface for the first-class knowledge-graph edges whose
// endpoints are NOT tasks (feature/gotcha/workspace/code_ref nodes), which
// otherwise have no MCP reachability.
const EDGE_TYPE_ENUM = [
  'DEPENDS_ON',
  'IMPLEMENTS',
  'USES_TECH',
  'DECIDED_BY',
  'REALIZES',
  'ABOUT',
  'PINS',
  'IN',
  'INTEGRATES_WITH'
] as const

// TASK-992 (ADR-NNN unified knowledge graph) — directional edge query over the
// generic relationships table. Stdio-only: not in REMOTE_TOOL_ALLOWLIST (the
// graph/knowledge layer is local-trust per ADR-030).
export const register = (server: InstrumentedServer, svc: RelationshipOperations): void => {
  server.registerTool(
    'graph_edges',
    {
      description:
        'Query first-class knowledge-graph edges on any node (task ID, feature/gotcha slug, workspace ID, code_ref slug). direction "out" = edges FROM the node, "in" = edges pointing AT it, "both" = either. Examples: which tasks realize a feature → {nodeId:"feature-x", type:"REALIZES", direction:"in"}; which workspaces a feature is in → {nodeId:"feature-x", type:"IN", direction:"out"}; which gotchas are about it → {nodeId:"feature-x", type:"ABOUT", direction:"in"}.',
      inputSchema: {
        nodeId: z.string().describe('Node identity: TASK-NNN, knowledge slug, workspace ID, or code_ref slug'),
        type: z
          .enum(EDGE_TYPE_ENUM)
          .optional()
          .describe('Filter to one edge type. Omit to return all edge types on the node.'),
        direction: z
          .enum(['out', 'in', 'both'])
          .optional()
          .describe('out = from node, in = to node, both = either (default)')
      }
    },
    async ({ nodeId, type, direction }) => {
      const dir = direction ?? 'both'
      const t = type as RelationType | undefined
      let edges: Relationship[]
      if (dir === 'out') {
        edges = await svc.getRelationshipsFrom(nodeId, t)
      } else if (dir === 'in') {
        edges = await svc.getRelationshipsTo(nodeId, t)
      } else {
        const all = await svc.getRelationships(nodeId)
        edges = t ? all.filter((e) => e.type === t) : all
      }
      return textResponse(edges)
    }
  )
}
