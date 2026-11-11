# Matching workspace — implementation report

## Baseline / tested

| | SHA |
|--|-----|
| Baseline (contracts start) | `60e68ee88a78316bf439260d2662c3065808ecd6` |
| Tested tree | working tree on `feature/matching` (uncommitted at report time) |

## Scope delivered

1. ADR-0044 + OpenSpec (guards-first, English UI copy)
2. Lens **Quick match** vs **Contextual matching…**; Mapping **Open matching…**
3. Host trust boundary + merge fixtures (`matching_*` RPCs)
4. Matching tab + structured plan editor + no-restart banner
5. Deterministic fixture review (table, filters, paging, detail, bulk, final diff)
6. Bounded retrieval (`matching_retrieve`) with caps / universe refuse / trial key cap
7. Commit path: host `matching_accept_draft` + `matching_plan_commit` → existing Mapping Save
8. Session: tab-switch keeps draft; close Matching warns; beforeunload + demo-load warn

## Commands

```text
cargo test -p dwh-engine matching   → 24 passed
cargo test -p dwh-host matching     → 5 passed
npm run test:unit                   → ok (incl. matching reviewLogic + commitSave)
npx tsc --noEmit                    → clean (after unused-var fix)
```

## Explicit gaps / not claimed done

- Full Electron E2E (explain→Save→Reload) not added — unit/host cover the decision/Save gates; UI smoke left for a follow-up with Help Lab fixture project.
- Live DuckDB/query-backed retrieval of source/target bodies not wired from canvas (trial uses fixtures when live rows absent; host retrieve ready for callers).
- LLM ranking loop (permission checkbox present; calls still go through existing `llm_chat` + intake validation when wired in a follow-up button).
- Durable Matching session restore across restart — out of scope; limited-preview banner required.
- Proposal handoff Lens→Matching with provenance — settings/scope transfer only.
- Merge into `openspec/specs/matching-workspace/` performed; change can be archived when product accepts.

## Acceptance mapping

| Scenario | Coverage |
|----------|----------|
| a1+Eurpope propose 1 / alt 2 | Fixtures + detail Choose 2 → final diff |
| Empty region no arbitrary pick | Fixture ambiguous + retrieve test |
| Multi-output same row | Fixture cand:m1 outputs |
| One key / 24 rows | Fixture affectedSourceRows=24 |
| Bulk scope exact | previewBulkConfirm exclusions |
| No DB write before Save | Draft confirm local only |
| Forged host payloads | Host/engine tests |
| Read-only refuse | gate_commit_write_policy + App writeAllowed |
| Caps / no silent full download | retrieve refuses >10k universe |
