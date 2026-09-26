# Weekly Knowledge Staleness Report — 2026-09-21

**Coverage:** 130 of 163 project slugs processed (batches 1–7 partial). Slugs 131–163 (old ADRs + 4 cross-scope) not reached due to session token limits.

---

## STALE — needs human review (58 entries, NOT auto-verified)

Ordered by blast radius (max commits behind on any ref):

### High drift (≥10 commits on any ref)

| Slug | Hottest ref | Commits |
|---|---|---|
| `dist-publish-can-leave-a-stale-latest-yml-that-silently-kills-auto-update` | package.json | 32 |
| `feature-companion-cockpit` | http-server.ts | 31 |
| `companion-mutations-only-writable-svc-only-workflow-routes` | http-server.ts | 30 |
| `ADR-026-dual-transport-mcp-server` | server-bootstrap.ts | 19 |
| `spike-3way-cold-prewarm-warm-2026-05-11` | queue-lifecycle-service.ts | 17 |
| `adr-027-minimal-self-hosted-oauth-2-0-dcr-for-claude-ai-connector-registration` | server-bootstrap.ts / schema.ts | 18 / 14 |
| `ADR-023-agent-memory-layer` | schema.ts / session-tools.ts | 14 / 12 |
| `ADR-024-review-status-and-session-checkpoint` | session-lifecycle-service.ts / task-types.ts | 14 / 10 |
| `a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is` | http-server.ts | 18 |
| `feature-task-management-core` | sqlite-task-service.ts | 10 |
| `ADR-034-keycloak-backed-http-auth-via-on-origin-proxy` | schema.ts | 10 |
| `ADR-025-knowledge-register-existing-keep` | knowledge-service.ts | 8 |

### Moderate drift (3–9 commits)

- `reloading-the-extension-does-not-re-inject-content-scripts-into-already-open-tab` — popup.js (9)
- `network-filter-persistence-is-session-scoped-and-the-search-box-persists-with-th` — popup.js (7)
- `secret-carrying-capture-kinds-are-local-only-never-inbox-task` — capture-dispatcher.ts (7)
- `feature-dual-transport-mcp-server` — server-bootstrap.ts (8), http-transport.ts (4)
- `ADR-030-dual-backend-sync` — server-bootstrap.ts (4), sqlite-task-service.ts (5)
- `ADR-019-autonomous-queue-runner` — session-lifecycle-service.ts (14), auto-safe-validator.ts (3)
- `capture-bundle-export-formats-prefer-the-open-standard-har-1-2` — capture-artifacts.ts (4)
- `code-ref-slugs-are-globally-unique-across-projects-but-code-ref-identity-is-proj` — mcp-tools (4)
- `capture-js-eval-parity-deferred` — capture-dispatcher.ts (4)
- `ADR-032-unified-knowledge-graph-v2` — task-types.ts (4), knowledge-types.ts (3)
- `feature-postgres-remote-backend` — postgres-task-service.ts (3), remote-operations.interface.ts (3)
- `feature-conversation-protocol` — conversation-lifecycle-service.ts (2), conversation-repository.ts (2)
- `feature-inbox-pipeline` — inbox-repository.ts (2), inbox-lifecycle-service.ts (1)
- `ADR-023-auto-safe-v2-hardening` — ci.yml (2) — NOTE: status=SUPERSEDED, may not matter
- `ADR-033-deprecate-graphify` — task-tools.ts (2), task-context-graphify.ts (1)
- `a-fixture-sized-for-convenience-can-make-an-acceptance-criterion-untestable` — workspace-view.test.tsx (4)
- `a-detail-pane-must-not-be-the-scrolling-element-the-header-travels-with-the-cont` — WorkspaceDocsView.tsx (5), WorkspaceView.tsx (4)
- `a-directory-without-its-meta-json-is-a-live-recording-not-debris` — meetings.ts (5)
- `two-rules-for-a-resumable-chunked-upload-append-before-the-marker-and-refuse-gap` — meetings.ts (5)
- `a-prepare-hook-also-runs-inside-the-docker-build-at-install-and-at-prune` — package.json (5), Dockerfile (1)
- `no-package-json-lifecycle-hook-closes-the-stale-bundle-gap` — package.json (5)
- `a-live-verification-needs-a-discriminator-if-pass-and-fail-look-identical-the-te` — extension/popup.js (5)
- `url-deny-lists-match-by-substring-use-vendor-specific-tokens-only-never-a-generi` — extension/README.md (3)
- `discovery-capture-has-three-independent-api-body-caps-tune-the-right-one` — inject.js (2), recorder.js (1)

### Low drift (1–2 commits)

- `a-grader-s-verdict-must-map-back-to-a-checkbox-and-every-criterion-must-get-one` — ac-review.ts (2)
- `the-ac-grader-is-discriminating-but-not-exhaustive-ok-is-not-a-pass` — ac-review.ts (2)
- `adr-when-this-project-may-call-a-model` — ac-review.ts (2), server-bootstrap.ts (1)
- `a-session-scoped-summary-must-never-be-written-as-a-per-entity-summary` — session-lifecycle-service.ts (2)
- `writing-conversation-header-columns-directly-is-silently-erased-by-the-fold` — session-lifecycle-service.ts (2)
- `feature-embedding-search` — local-embedding-provider.ts (1)
- `feature-knowledge-graph` — relationship-repository.ts (1), code-ref-repository.ts (1)
- `mcp-tool-handlers-must-await-the-async-service-facade-an-un-awaited-promise-stri` — knowledge-tools.ts (1)
- `feature-readtime-role-projection` — feature-projection-builder.ts (1)
- `feature-oauth-dcr` — oauth/discovery.ts (1), oauth/token.ts (1)
- `adr-a-criterion-about-preserved-bytes-is-verified-by-bytes-never-by-git-diff` — workspace-docs.ts (1)
- `a-dead-target-is-not-a-disabled-link-render-no-anchor-at-all` — task-provenance.test.tsx (1)
- `a-path-in-argv-needs-no-shell-escaping-it-needs-a-dash-check` — docker-exec.ts (1)
- `verify-a-vendored-bundle-at-the-packaged-path-not-the-staging-directory` — vendor-adapter.mjs (1)
- `azure-s-models-returns-the-region-catalog-not-what-this-resource-has-deployed` — azure-review.ts (1)
- `a-reasoning-deployment-answers-http-200-with-an-empty-body-when-the-token-budget` — azure-review.ts (1)
- `one-list-or-the-workspace-tab-strip-drifts-it-has-now-drifted-twice` — WorkspaceView.tsx (1)
- `url-normalization-defeats-path-traversal-tests-route-on-the-raw-req-url` — artifacts.ts (1)
- `changing-the-embedding-model-variant-silently-degrades-ranking-it-never-fails` — local-embedding-provider.ts (1)
- `network-panel-bodies-are-correlated-by-guess-the-two-capture-halves-share-no-req` — background.js (1)
- `a-version-gated-node-built-in-fails-at-import-time-verify-against-ci-s-node-not-` — ci.yml (1)

---

## Auto-verified (re-pinned to HEAD)

5 entries successfully re-pinned:

1. `evidence-that-lives-in-a-temp-directory-is-evidence-that-expires`
2. `a-proof-must-drive-the-shipped-code-path-not-a-copy-of-it`
3. `a-security-control-expressed-as-an-attribute-needs-its-value-asserted-not-its-el`
4. `three-obligations-when-touching-the-terminal-pane-keys-size-and-identity`
5. `the-save-preview-s-diff-is-deliberately-not-minimal-it-may-overstate-never-under`

**Verify calls timed out (non-stale, need re-pinning in a follow-up run):**
- `when-two-files-must-agree-derive-the-check-from-the-authority-never-restate-it`
- `pin-what-the-implementation-answers-not-what-it-ought-to-when-the-point-is-agree`
- `a-number-measured-under-the-test-runner-is-not-a-property-of-the-build-that-ship`
- `ls-la-always-prints-a-total-line-so-empty-stdout-can-never-mean-an-empty-directo`
- `a-docker-verb-that-streams-needs-the-connection-over-a-tcp-docker-host-it-return`
- `an-upgrade-has-no-response-object-and-no-framing-refusals-must-destroy-relays-mu`

**Non-stale, not yet verified (not reached due to token limits):**
highlight-js, a-junction, a-companion-view, conversation-add-caps, registered-to-auto-start, textcontent, vitest, capture-reduction, an-extension-lib, windows-task-scheduler, feature-autonomous-queue-runner, feature-backup-restore, feature-agent-memory, feature-knowledge-layer, feature-cross-device-sync, refreshing-the-ichiba-session-cookie

---

## Due for periodic review (no refs or refs all current but lastVerifiedAt >30 days)

| Slug | Last Verified | Days Ago |
|---|---|---|
| ADR-029-session-activity-visibility | 2026-05-21 | 123 |
| ADR-028-session-end-structured-summary | 2026-05-21 | 123 |
| ADR-006-openapi-ingestion-credential-profiles | 2026-05-28 | 116 |
| gotcha-tester-guards-spare-verbatim-ac | 2026-06-02 | 111 |
| gotcha-projection-guards-rendered-not-fields | 2026-06-02 | 111 |
| ADR-031-session-end-derivation | 2026-06-02 | 111 |
| ADR-035-investigation-domain-object | 2026-06-09 | 104 |
| feature-choda-gateway | 2026-06-04 | 109 |
| feature-companion-ui | 2026-06-04 | 109 |
| sync-ledger-bucket-precedence-is-fixed-tombstoned-remote-only-in-sync-local-only | 2026-06-20 | 93 |
| sync-loop-health-is-cross-process-read-it-from-the-sync-state-heartbeat-not-memo | 2026-06-20 | 93 |
| companion-adapter-must-add-zero-mcp-edits | 2026-06-20 | 93 |
| companion-web-design-tokens-come-from-pre-reset-5a3a14d-not-docs-handoff-design- | 2026-06-21 | 92 |
| companion-screens-must-render-honest-liveness-never-fake-live | 2026-06-21 | 92 |
| companion-web-must-address-exactly-one-api-base-never-the-remote-pod | 2026-06-21 | 92 |
| ADR-005-tool-naming-as-public-contract | 2026-07-13 | 70 |
| ADR-004-per-upstream-execution-policy | 2026-07-13 | 70 |
| companion-write-actions-must-confirm-surface-result-or-error-never-silent | 2026-07-13 | 70 |
| https-github-com-modelcontextprotocol-ext-apps | 2026-07-30 | 53 |
| commonmark-eats-backslashes-in-link-destinations-normalize-before-parsing | 2026-08-05 | 47 |
| never-reuse-the-sessionid-echoed-by-ac-check-it-may-be-another-agent-s-session | 2026-08-05 | 47 |
| a-flat-distance-profile-from-knowledge-search-means-no-match-not-n-matches | 2026-08-07 | 45 |
| sweep-threshold-constants-against-real-fixtures-a-guessed-cutoff-lands-on-the-da | 2026-08-08 | 44 |
| deciding-to-change-nothing-still-obliges-you-to-check-that-what-you-are-keeping- | 2026-08-08 | 44 |
| when-the-input-cannot-be-classified-report-unknown-never-fall-through-to-a-defau | 2026-08-08 | 44 |
| a-detection-signal-must-not-be-collinear-with-the-thing-you-are-trying-to-exclud | 2026-08-08 | 44 |

---

## Parse errors (need repair)

9 entries have malformed frontmatter (`ref missing path or commitSha`). They cannot be checked for staleness until repaired via `knowledge_register_existing`:

Slugs 1–3, 5–10 from original batch 1:
- `a-display-ceiling-refuses-it-does-not-truncate`
- `widen-a-sandboxed-read-surface-with-an-allowlist-never-with-a-path-segment`
- `a-collapsible-that-sets-hidden-and-a-display-class-on-one-element-never-hides`
- `cleanup-does-not-cancel-work-already-scheduled-give-it-a-turn-instead`
- `check-derived-timings-against-physics-before-persisting-them`
- `a-criterion-that-can-only-fail-is-as-useless-as-one-that-cannot-fail`
- `azure-fast-transcription-phrases-are-28-s-rebuild-seekable-segments-from-word-of`
- `a-provider-s-no-content-answer-must-not-fail-the-whole-batch`
- `a-packaged-install-s-datadir-is-not-your-choda-data-dir-anything-resolved-relati`

---

## Not found

- `sync-import-must-advance-the-id-allocator-or-a-fresh-node-re-mints-pulled-ids` — DB row missing (orphaned file or deleted entry)

---

## Not processed (token limits — run follow-up)

Slugs 131–159 and 4 cross-scope entries. These are mainly older ADRs (ADR-001 through ADR-022, playwright, sqlite-wal, auto-safe, etc.) and cross-scope vault entries. Run another check to cover them.

---

## Quick stats

| Category | Count |
|---|---|
| **Total entries in project** | ~163 |
| **Processed this run** | 130 |
| STALE — needs human review | **58** |
| Auto-verified successfully | 5 |
| Verify timed out (non-stale) | 22 |
| Parse errors (malformed frontmatter) | 9 |
| Due for periodic review (>30d) | 26 |
| Not found (orphan) | 1 |
| Not processed | 33 |

---

## Hot files summary

Files that appear most often as stale refs — any knowledge touching these is at high risk of describing outdated behavior:

| File | Stale entries pinned to it | Max commits behind |
|---|---|---|
| `server-bootstrap.ts` | 6+ entries | 19 |
| `session-lifecycle-service.ts` | 7+ entries | 14 |
| `schema.ts` | 3+ entries | 14 |
| `http-server.ts` / `http-transport.ts` | 4+ entries | 31 |
| `package.json` | 3+ entries | 32 |
| `popup.js` (extension) | 3+ entries | 9 |
| `ac-review.ts` | 3+ entries | 2 |
| `sqlite-task-service.ts` | 2+ entries | 10 |
