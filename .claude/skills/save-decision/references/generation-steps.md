# Generation Steps

## Step-by-step flow

1. **Read template** — load `30-Knowledge/adr-standard.md` for the canonical ADR format
2. **Determine next ADR number** — call `mcp__choda-tasks__knowledge_list({ projectId, type: 'decision' })`, parse highest `N` from entry **slugs** (regex `/^ADR-(\d+)/`), increment by 1, zero-pad to 3 digits (e.g., `ADR-019`). Slugs are canonical — titles may or may not include the `ADR-NNN:` prefix.
3. **Generate slug** — from topic argument or inferred topic, kebab-case, 2-4 words. Slug auto-derives from title if omitted.
4. **Extract decision from conversation** — see `conversation-extraction.md`
5. **Fill template body** — all sections from adr-standard required (no frontmatter — `knowledge_create` adds it):
   - AI-Context: one-line summary
   - Context: problem statement from discussion
   - Options considered: table from discussion
   - Decision: chosen option + rationale
   - Why not others: rejection reasons
   - Consequences: good, bad, risks
   - Impact: files/modules affected
   - Revisit when: conditions to re-evaluate
   - Related: link to prior ADRs if applicable
6. **Extract refs** — collect repo-relative file paths from Impact section (backtick-wrapped paths like `src/foo.ts`); pass as `refs: [{ path }, ...]`. SHA auto-pinned to HEAD by the service.
7. **Persist via MCP**:
   ```
   mcp__choda-tasks__knowledge_create({
     projectId: <current>,
     type: 'decision',
     scope: 'project',
     title: 'ADR-019: <description>',
     body: <markdown body without frontmatter>,
     refs: [{ path: 'src/...' }, ...]
   })
   ```
8. **Present to user** — show returned slug + file path + summary, ask if anything needs correction

## Bootstrap

No manual bootstrap needed — `knowledge_create` auto-creates `docs/knowledge/` and regenerates `INDEX.md`.
