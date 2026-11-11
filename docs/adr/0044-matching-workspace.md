# ADR-0044 — Matching workspace (LLM-assisted mapping review)

## Status

**Accepted** (decision only — implementation via OpenSpec
`openspec/changes/matching-workspace/`). Amended 2026-11-10: Lens/Matching UX
boundary, structured plan editor, numeric run caps, host-side trust boundary,
session lifecycle gate, merge/bulk fixtures-first order.

Baseline for this change: `60e68ee88a78316bf439260d2662c3065808ecd6`
(`feature/matching`). Agents MUST re-verify descriptions against **current HEAD**
before implementing; do not treat prior chat reviews as SoT over the tree.

## Context

Contextual matching (ambiguous names, regions, typos, multi-field evidence) needs
a dedicated review surface: describe the task, confirm a plan, inspect proposals
and alternatives, confirm decisions in a draft, then Save into an existing
Mapping.

Today the product already has:

| Mechanism | Role | Limit for this job |
|-----------|------|--------------------|
| Fuzzy suggest ([ADR-0020](0020-join-key-mapping.md)) | Deterministic candidate pairs | No multi-field plan, no rich alternatives UI |
| Join Lens Auto + in-place confirm ([ADR-0042](0042-join-lens-in-place-confirm.md)) | Fast dispute on unmatched Join keys under **current Lens rules** | No contextual plan; session lives in Lens |
| LLM leftovers chat | Optional pairs into Lens queue | Bounded by `right_to_universe`; client-side filters today; not a task/plan/review loop |
| Mapping editor | SoT grid + Save | Wrong primary dispute UI for contextual evidence |
| ApplyPlan ([ADR-0038](0038-keymap-apply-operation.md)) | Runtime Apply after map exists | Must not call LLM |

Silent fuzzy / LLM Join ON remains forbidden ([ADR-0019](0019-join-lens-ai-narrator.md),
[ADR-0020](0020-join-key-mapping.md)). Matching must not invent a second map store,
new Apply semantics, or warehouse write paths.

### Existing fuzzy / LLM caps at baseline (HEAD `60e68ee`)

| Surface | Cap | Source |
|---------|-----|--------|
| Join unmatched keys scanned / side | 200 | `join_fuzzy.rs` `KEY_SCAN_CAP` |
| Join fuzzy suggestions returned | 40 total | `MAX_SUGGESTIONS` |
| Join LLM `right_to_universe` | 60 | `UNIVERSE_CAP` in `join_fuzzy.rs`; prompt lists same |
| Dictionary sides | ≤250 000 rows | `key_map_fuzzy.rs` `MAX_SOURCE_ROWS` |
| Token index | freq ≤32, ≤16 candidates/From | `key_match.rs` |
| Host `llm_chat` | ≤32 messages; ≤12 000 chars/message | `crates/dwh-host/src/llm.rs` |
| Prompt soft budget | 10 500 | `joinLensLlmPrompt.ts` |

Matching run caps (§5) MUST reuse or explicitly justify divergence from these —
not invent a parallel near-duplicate constant set.

## Decision

### 1. Matching is a decision-prep session, not map storage

Matching is a **workspace tab** next to Pipeline and Mapping editor:

```text
[Pipeline] [Mapping: Suppliers] [Matching: Client → A]
```

It prepares **confirmed draft decisions** that Save commits through the **existing**
Mapping storage semantics (seed / source dirty-delta / query / ref) and the
existing import write policy. It does **not**:

- create a physical table, change schema, or auto-switch storage;
- embed full dictionaries / candidate bodies in project JSON;
- act as runtime Apply or write Join ON.

Unconfirmed proposals never affect preview, export, dbt SQL, or Join.

### 2. Lens Auto vs Matching (product boundary)

Split by **task complexity**, not by whether LLM is used. LLM presence alone
MUST NOT decide which surface owns the action. Do not ship two similarly labelled
«Auto / AI match» buttons with different behaviour.

| Place | Action (UI copy) | Meaning |
|-------|------------------|---------|
| Join Lens | **Quick match** — “Using current Lens fields and rules” | ADR-0042 batch under current Lens rules; no separate contextual plan |
| Join Lens | **Contextual matching…** — “Multiple fields, extra constraints, and comparing alternatives” | Opens Matching; transfers scope + settings; does **not** auto-start a second run |
| Mapping editor | **Open matching…** | Opens Matching bound to the selected map |
| Matching | **Open result in Lens** | Inspect Apply / Join outcome after map use |

Lens → Matching MAY carry over existing proposals only when the contract is
compatible, preserving **provenance** (`fuzzy` / `llm` / `manual` / prior
session id). Incompatible shapes are dropped with an explicit notice — never
silently re-scored as new truth.

### 3. LLM role

LLM may fill the structured plan editor and (when needed) rank among an
application-supplied candidate set.

**Cascade (cheap first, LLM only on residue).** Do not send every key to the
LLM. Matching SHALL run tiers in order:

| Tier | Mechanism | Closes |
|------|-----------|--------|
| 1 | Deterministic retrieve only: normalize, strip legal noise, containment, Levenshtein | Typos / near spellings (`KomputerParts`↔`ComputerParts`) — **no hardcoded thesaurus** |
| 2 | LLM **alias expand → dictionary lookup** (residue only) | Semantic / geo / trading-name / opaque labels (`USA`↔`United States`, `"Зать Президента"`→`Kushner`) |
| 3 | LLM **rank** inside allowlist (residue only) | Pick among shortlist; mark low confidence Ambiguous |
| 4 | Human confirm / defer / no suitable | Final judgment; never auto-Save |

Do **not** maintain closed synonym lists in engine code — that does not scale and
duplicates what Tier‑2 already does. High-confidence Tier‑1 proposals (single
proposed candidate, no alternatives, search complete) MUST skip Tiers 2–3.
LLM still cannot invent target ids outside the allowlist. Embeddings as an
optional mid-tier between 1 and 2 may be added later without changing this
cascade contract.

LLM is **not**:

- the Apply mechanism or a DB writer;
- a source of calibrated probabilities (ignore self-scores like “97%” for auto-save);
- allowed to invent target identities or outputs outside registered candidates;
- the required way to edit the plan (chat is optional).

Row field values are **data**, not agent instructions. External LLM calls show
fields about to be sent and require user permission; credentials and unnecessary
columns are never sent.

### 4. Contracts

#### MatchingTask / MatchingPlan

The **plan is the execution contract**. Primary UI is a **structured editor**,
not mandatory chat:

- source / target;
- map key (From);
- comparison field pairs;
- field role per pair: **hard constraint** / **soft signal** / **reference context**;
- normalization;
- outputs;
- ambiguity behaviour;
- scope and run limits.

LLM may populate the editor; the user edits dropdowns, toggles, and comparison
rows directly.

**Confirm rules:**

- Do **not** require per-field confirmations.
- For a valid plan: one control — **Apply plan and run trial**.
- Block only unresolved blockers: missing identity, ambiguous map key, incompatible
  outputs.
- Plan changes show a concrete diff and affected results.
- Separate **semantic revision** from **UI revision**:
  - display / sort / label changes → UI revision only; do **not** invalidate proposals;
  - comparison semantics change → invalidate affected proposals;
  - map key, target identity, or outputs change → re-validate the whole affected draft.

`name` is not a unique ID unless confirmed.

#### MatchingProposal

Each proposal SHALL carry:

- source identity + full map key;
- source values used;
- proposed target identity **or** explicit no-choice;
- output values (all from **one** target row — [ADR-0037](0037-keymap-multi-output.md));
- alternative candidates;
- short field-level evidence (checkable, not a hidden chain-of-thought);
- contradictions / constraint hits;
- candidate-search completeness / truncation;
- semantic plan revision + evidence revision;
- model/prompt metadata when LLM was used;
- provenance.

#### MatchingDecision (draft)

| Decision | Meaning |
|----------|---------|
| Confirm proposed | Draft accept of proposed target |
| Choose alternative | Draft accept of another listed / registered candidate |
| Defer | Leave unresolved |
| Reject | Decline this proposal |
| No suitable target | Explicit user claim that no target fits |

Draft confirm does **not** write the Mapping or the warehouse.

#### States

`Proposed` · `Ambiguous` · `No candidates` · `Incomplete search` ·
`Confirmed in draft` · `Deferred` · `Rejected` · `Stale` · `Saved`

Plus explicit **no suitable target**.

`No candidates` ≠ proven absence when search was bounded / truncated.
Incomplete retrieval MUST NOT render as confident non-match.

Many sources → one target is allowed unless the plan forbids it. No global
one-to-one assignment.

Decisions are keyed by the **full map key**, not by each source row. One key
spanning 24 source rows is **one** correspondence affecting 24 rows.

### 5. Run caps (first-slice project limits)

Starting values — project limits, not claimed optima. Re-check HEAD fuzzy caps
before locking code constants.

| Limit | Start value | Relation to existing |
|-------|-------------|----------------------|
| Trial run | 20 unique map keys | New (smaller than Join scan) |
| One mass run | 200 unique map keys | Aligns with Join `KEY_SCAN_CAP=200` (keys in scope, not “suggestions total”) |
| Retrieval shortlist | ≤40 candidates / key | Same number as Join `MAX_SUGGESTIONS`, **different unit** (per-key shortlist vs total suggestions) — document in shared config comments |
| Candidates in one LLM request | ≤10 / key | Stricter than Join universe list (60); Matching sends per-key shortlists |
| Target universe for local full scan | ≤10 000 rows | Between Join sample (200) and dictionary max (250 000); above → server-side retrieval **or** refuse with explanation — never silently download all |
| Parallel LLM requests | 2 | New |
| Automatic retries | 1 / request | New |
| Total LLM calls / run (incl. plan interpret + retries) | ≤220 | New budget |

Additional rules:

- Insufficient candidates → explicit expand-search within remaining budget; no infinite fallback.
- All calls (plan interpretation, ranking, retries) count toward the run budget.
- Hard input/output token limits are fixed in the selected provider config before run.
- Monetary estimates only when tariffs are configured; missing estimate does **not**
  lift token/call caps.
- Budget exhaustion → partial result with stop reason; **no** silent continuation
  in further batches past the limit.
- Before run: show scope + upper bounds. After: actual candidates, calls, tokens,
  duration, retries, unprocessed key count.

### 6. Trust boundary: host-side validation

Client-side checks are UX only — **not** the trust boundary.

Renderer MUST NOT submit a trusted ready `output_values` tuple. It submits
**proposal/candidate ids** and **expected revisions**. The host/application layer:

1. checks task/session identity;
2. checks semantic plan revision;
3. checks full source key;
4. checks target ID ∈ registered candidate set for that task;
5. checks target evidence freshness;
6. materializes allowed outputs from the registered candidate (one target row);
7. checks live map content + write policy at commit.

Manual pick via extra search is allowed only after the object is **registered**
as a verified candidate (not an allowlist bypass).

Enforce at: LLM result intake · draft accept · final commit (on live state).

Acceptance MUST include direct host/application API calls with forged payloads
(unknown target ID; other-session ID; mutated outputs; stale revision; read-only
map write) — all rejected regardless of renderer state.

### 7. Merge / bulk confirm (fixtures before UI)

Decision unit = **full map key**. Compare:

- map baseline at prepare time;
- live map value;
- confirmed proposed value.

**“Filled”** means an existing map row for that From key under the current map
model ([ADR-0037](0037-keymap-multi-output.md) `from_parts` / `output_values`).
Do **not** treat `0`, `false`, `""`, or nullable outputs as “no row” by default.

| Situation | Result |
|-----------|--------|
| Key absent, one coherent proposal | May add |
| Key absent, conflicting proposals | Conflict; bulk does not accept |
| Map already has same output tuple | No-op / already matches |
| Map has a different tuple | Only via explicit replace agreement |
| Map changed after baseline | Conflict/stale → review |
| User confirmed an alternative | That alternative is authoritative |
| Many source rows share key + tuple | One decision + affected-row count |

Ordinary bulk confirm MUST NOT: replace differing existing values; resolve
same-key conflicts; pick a winner by LLM arrival order; override a confirmed
choice with a later proposal.

If conflict is detected at final commit: **stop** — no silent partial Save;
show conflict; let the user form a new save set.

Fixtures (before polished UI) cover composite keys, significant blanks,
nullable/multi-output, re-Save, and concurrent map edits.

### 8. Workspace UX and session lifecycle

Inside the tab: structured plan editor (+ optional chat), run status, proposal
table, detail/alternatives, counters, final review. Review owns layout after the
plan is applied.

**Always-visible banner** until restart persistence ships:

> Draft exists only for this app run. It will not restore after restart.
> Correspondences saved into the Mapping persist.

Not a toast-only message and not docs-only.

Lifecycle:

| Action | Behaviour |
|--------|-----------|
| Tab switch | Keep session (in-process) |
| Close Matching | Warn if unsaved user decisions |
| Close project / change connection | Warn if unsaved user decisions |
| Quit app | Warn if unsaved user decisions |

Do **not** promise crash protection. **Product gate:** without restart restore,
ship only a **limited preview** under the §5 caps. Do not position Matching as a
long-running workplace until a durable resumable draft exists. Close-dirty does
**not** replace session restore.

### 9. Processing pipeline

```text
Candidate retrieval → feature compare → LLM if needed → host-validated proposal → review
```

Soft context fields MUST NOT become mandatory exact filters without a confirmed
plan hard rule. Source batches keep stable identity; retries neither skip nor
duplicate. Cancel / Retry MUST NOT drop draft decisions. Late replies after
Cancel, task/project/connection change MUST NOT apply
([ADR-0031](0031-execution-lifecycle.md)).

### 10. Final Save

Before Save show adds / changes / unresolved / affected source rows with From,
old outputs, new outputs, decision origin. Save only confirmed non-stale
decisions via existing seed / source dirty-delta / query / ref paths and
`import_write_refusal`. Warehouse conflict ≠ successful Saved. Double-confirm
and re-Save must not duplicate From rows.

After Save: offer explicit related check/preview recompute; do not auto-mutate
Join. Unaccepted proposals never apply silently to the pipeline.

### 11. Reuse (do not duplicate)

- Mapping SoT, multi-output IR, dirty-delta Save, import write refusal  
- ApplyPlan prepare → validate → execute (post-Save Apply only; no LLM inside)  
- Fuzzy / bounded retrieval cores; shared config for caps where units align  
- Existing cancel / revision / warehouse concurrency gates  
- Typed wire ([ADR-0029](0029-typed-wire-contract.md)) for host DTOs  

### 12. Out of scope (this ADR)

- Automatic accept + Save of LLM decisions  
- Global one-to-one assignment  
- New graph profiler / visualization engines  
- LLM inside runtime Apply  
- Implicit rule learning from a single user choice  
- New storage kinds, typed outputs, temporal semantics beyond current maps  
- Save-as-Seed for live PostgreSQL relations  
- dbt migration / DDL  
- Durable Matching session persistence across restart (follow-up ADR; required
  before “full workplace” positioning)  

## Consequences

- OpenSpec `matching-workspace` delivery order flips to **guards first**:
  HEAD sync → UX copy → contracts + host validation + merge fixtures → plan
  editor shell → review on deterministic proposals → capped retrieval → LLM
  through the same gates → final diff/commit → E2E / session lifecycle.
- Criterion of progress: even a forged, stale, or conflicting proposal cannot be
  silently accepted and Saved — proven by host API tests, not UI clicks alone.
- Does not lift ADR-0019/0020 bans on automatic fuzzy Join ON.

## References

- [ADR-0019](0019-join-lens-ai-narrator.md), [ADR-0020](0020-join-key-mapping.md),
  [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0031](0031-execution-lifecycle.md),
  [ADR-0037](0037-keymap-multi-output.md), [ADR-0038](0038-keymap-apply-operation.md),
  [ADR-0042](0042-join-lens-in-place-confirm.md)
- OpenSpec: `openspec/changes/matching-workspace/`
