# Design: matching-workspace

## Baseline

`60e68ee88a78316bf439260d2662c3065808ecd6` on `feature/matching`.

Re-verify all cited caps and paths against **current HEAD** before coding.

## Architecture

Matching is a **session** in the UI/host application layer — not Project IR and
not a second map SoT.

```text
Entry (Lens Quick match stays in Lens)
Entry (Lens Contextual matching… | Mapping Open matching… | query)
  → MatchingSession { task, plan, semantic_rev, ui_rev, proposals, decisions, run }
  → host validates LLM / draft / commit
  → FinalReviewDiff
  → existing Mapping Save
  → optional explicit Lens / check recompute
```

### Trust boundary

```text
Renderer  --(proposal_id | candidate_id, expected revisions)-->  Host
Host      --(validate session, plan_rev, key, allowlist, evidence)-->
Host      --(materialize output_values from registered candidate)-->
Host      --(commit via existing write_key_map / seed paths)-->
```

Renderer-supplied output tuples are **untrusted** and ignored for commit.

### Reuse (inventory — re-check HEAD)

| Existing | Path / notes | Matching use |
|----------|--------------|----------------|
| Shared matcher | `crates/dwh-engine/src/key_match.rs` | Scoring; shared config where units align |
| Join unmatched suggest | `join_fuzzy.rs` (`KEY_SCAN_CAP=200`, `MAX_SUGGESTIONS=40`, `UNIVERSE_CAP=60`) | Lens-scoped adapter / cap alignment |
| Dictionary suggest | `key_map_fuzzy.rs` (`MAX_SOURCE_ROWS=250_000`) | Dictionary adapter; Matching local scan cap is lower (10 000) |
| Lens session confirm | `src/lib/joinLensConfirm.ts` (ADR-0042) | **Quick match** only; Matching is separate workplace |
| LLM host bounds | `llm.rs` ≤32 msgs / 12 000 chars; prompt soft 10 500 | Keep; Matching adds run call/token budgets |
| Map merge / Save | `src/app/keyMap/service.ts`, `write_key_map` | Commit after final review |
| Import write gate | `import_write_refusal` | Read-only / broken |
| ApplyPlan | `applyPlan.ts` (ADR-0038) | Post-Save only; no LLM |

**Caps policy:** put Matching limits in one shared config module with comments
that map each constant to Join/dictionary relatives. Do not copy magic numbers
into React panels.

| Matching start cap | Aligns with | Note |
|--------------------|-------------|------|
| Mass run 200 keys | `KEY_SCAN_CAP` | Same order; Matching counts unique map keys in scope |
| Shortlist 40 / key | `MAX_SUGGESTIONS` | Same number, **different unit** (per-key vs total) |
| LLM ≤10 candidates / key | Join universe 60 | Stricter per-request shortlist |
| Local universe 10 000 | vs 250 000 dict max | Above → server-side or refuse |

### Do not fork

No second proposal store, no silent Join ON rewrite, no parallel LLM HTTP
client, no trusted renderer output tuples. Save uses `from_parts` /
`output_values`; source AST stripped of row bodies (ADR-0033/0036).

## Plan editor

Primary UI: structured fields (source/target, map key, comparison pairs with
role hard/soft/reference, normalization, outputs, ambiguity policy, scope,
limits). Chat optional to fill the editor.

- One button when valid: **Apply plan and run trial**
- Blockers only: missing identity, ambiguous key, incompatible outputs
- `semantic_revision` vs `ui_revision` (display/sort/label)

## Merge unit

Decision key = full map From tuple. “Filled” = existing map row for that From
(not “output looks empty”). Bulk matrix and conflict-at-commit stop are in
ADR-0044 §7; implement as pure functions + fixtures first.

## Session

In-process across tab switches. Always-visible no-restart-restore banner.
Warn on close Matching / close project / change connection / quit when draft
decisions exist. Product gate: capped preview only until durable draft ADR.

## Delivery order (guards first)

1. HEAD sync + ADR/OpenSpec (this)  
2. UX boundary + exact UI copy  
3. Contracts + host validation + merge fixtures  
4. Tab shell + structured plan editor  
5. Review on deterministic test proposals  
6. Retrieval with hard caps + metrics  
7. LLM through the same validation gates  
8. Final diff, commit, conflict handling  
9. E2E + session lifecycle  

Progress metric: forged/stale/conflicting proposals cannot silently Save —
proven by host API tests.
