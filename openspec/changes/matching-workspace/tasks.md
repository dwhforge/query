# Tasks: matching-workspace

Baseline SHA: `60e68ee88a78316bf439260d2662c3065808ecd6`

**Agent rule:** before any code change, re-verify cited paths/caps/behaviours
against **current HEAD**. Chat reviews of the tree are hints, not SoT.

Guards before generation: do not treat chat UI or an empty table as “Matching
done”. Progress = forged/stale/conflicting proposals cannot silently Save.

## 1. HEAD sync + ADR/OpenSpec

- [x] ADR-0044 amended (Lens/Matching boundary, plan editor, caps, host trust,
      session gate, merge-first)
- [x] OpenSpec proposal / design / specs / tasks updated to match
- [x] Re-check fuzzy/LLM constants; shared caps (`matching/caps.rs` +
      `matchingCaps.ts` + `matching_caps` RPC)

## 2. UX boundary + exact UI copy

- [x] Lens: **Quick match** vs **Contextual matching…** (English UI)
- [x] Mapping editor: **Open matching…**
- [x] Matching: **Open result in Lens**
- [x] Lens → Matching transfers scope/settings; no auto-run
- [ ] Compatible proposal handoff preserves provenance (settings/scope only today)

## 3. Contracts + host validation + merge fixtures

- [x] DTOs + host APIs + merge matrix + forged-payload tests
- [x] `cargo test -p dwh-engine matching` 24 ok; `-p dwh-host matching` 5 ok

## 4. Tab shell + structured plan editor

- [x] Matching center tab + plan editor + Apply plan and run trial
- [x] Banner; close Matching warn; beforeunload; demo-load warn
- [x] Plan editor combos from Lens parent columns/queries; Lens defaults
      (FromQuery source, id-like identity, soft ON pairs)

## 5. Review on deterministic test proposals

- [x] Table, filters, paging, detail/alternatives, counters
- [x] Bulk draft confirm with scope + exclusions
- [x] Fixtures: a1+Eurpope alt; empty region; multi-output; one key / many rows;
      rich trial sample ~150 keys (~50% fuzzy / ~40% LLM residue / ~10% manual)
- [x] `src/app/matching/reviewLogic.test.ts`

## 6. Retrieval with hard caps + metrics

- [x] `matching_retrieve` — trial/mass key caps, shortlist, universe refuse,
      expand, metrics / stop_reason
- [x] Engine retrieve tests (oversize, trial unprocessed, empty region)

## 7. LLM through the same validation gates

- [x] Permission checkbox before external send (UI)
- [x] Intake validation via `matching_validate_llm_intake` (host)
- [x] Full LLM ranking loop: instruction text + permission → `llm_chat` rank
      shortlist → host intake validate → proposals (proposed/ambiguous) for
      manual confirm — no auto-Save (`llmRank.ts` + Rank with LLM)
- [x] Tier‑1 retrieve = algorithmic only (normalize / Levenshtein) — no
      hardcoded thesaurus in engine
- [x] Semantic aliases via LLM alias-expand → lookup on residue
      (`semanticExpand.ts`) before rank
- [x] Cascade: deterministic first; LLM expand+rank **residue only**
      (`cascade.ts`); skip high-confidence single-candidate resolves

## 8. Final diff, commit, conflict handling

- [x] Final review summary + diff panel
- [x] `commitMatchingSession` → accept_draft + plan_commit → Mapping Save
- [x] Conflict/stale/read-only stop without silent partial Save
- [x] `commitSave.test.ts` materialize / alternative → diff

## 9. E2E + session lifecycle

- [x] Unit flow: plan fixtures → alternative → draft → diff materialize
- [x] Tab switch preserves draft; close/project/quit warnings; banner
- [ ] Electron E2E explain→Save→Reload — deferred (see `report.md`)
- [x] Limited-preview positioning until durable draft ADR

## Done criteria

- [x] Host forged-payload suite green
- [x] User can inspect proposals/alternatives and Save only confirmed decisions
      under caps (fixture trial path)
- [x] Merged delta → `openspec/specs/matching-workspace/`
- [x] Report: `openspec/changes/matching-workspace/report.md`
