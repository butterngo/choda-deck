# Generation Steps

## Step-by-step flow

1. **Read template** — load `30-Knowledge/adr-standard.md` to get current ADR format
2. **Scan existing ADRs** — glob `docs/decisions/ADR-*.md`, extract highest ID number
3. **Determine next ID** — increment by 1, zero-pad to 4 digits (e.g., `ADR-0005`)
4. **Generate slug** — from topic argument or inferred topic, kebab-case, 2-4 words
5. **Extract decision from conversation** — see `conversation-extraction.md`
6. **Fill template sections** — all sections from adr-standard are required:
   - Frontmatter: id, status (`proposed`), date (today), deciders
   - AI-Context: one-line summary
   - Context: problem statement from discussion
   - Options considered: table from discussion
   - Decision: chosen option + rationale
   - Why not others: rejection reasons
   - Consequences: good, bad, risks
   - Impact: files/modules affected
   - Revisit when: conditions to re-evaluate
   - Related: link to prior ADRs if applicable
7. **Write ADR file** — to `docs/decisions/ADR-XXXX-<slug>.md`
8. **Update index** — see `index-management.md`
9. **Present to user** — show file path + summary, ask if anything needs correction

## Bootstrap (first-time setup)

If `docs/decisions/` does not exist:

1. Create `docs/decisions/`
2. Create `docs/decisions/index.md` using index template from adr-standard
3. Set first ADR ID to `ADR-0001`
