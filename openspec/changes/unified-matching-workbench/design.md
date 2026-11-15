# Design: Unified Matching relationship workbench

**Proposed Phase 1 contract; no runtime implementation.** Decision:
[ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
Read [proposal](proposal.md) and [deltas](specs/) first. The
[investigation](investigation.md) is the evidence inventory; [tasks](tasks.md)
defines acceptance gates. ADR-0051 write/session invariants remain unchanged.

## 1. Primary UX and navigation

Use the application's existing dark surfaces, typography, borders, selected-state
accents and resize/scroll conventions. This is the existing Matching tab, not a new
workspace type. Normal review starts with actual acquired data after an explicit
Find Matches run; before acquisition show a concise scope/cap summary and action,
not an empty result that implies a successful run.

```text
MATCHING: pos_invoices → dim_vendor      [Matching Rules] [Assistant] [Details]
12 acquired source keys · 2 suggested · 10 unresolved · 0 confirmed
Scope: unmatched source keys in this run; additional matching records may exist
─────────────────────────────────────────────────────────────────────────────
SOURCE: pos_invoices                     TARGET: dim_vendor
[Search source records…]                  [Search target records…]
Status filter                            Candidates | Retrieved targets

> vendor_label: CPC LLC                   > vendor_name: ComputerParts LLC
  region: Germany                          region: DE
  1 source row · unresolved                 Suggested · spelling similarity …

  vendor_label: Computer Parts LLC          vendor_name: ComputerParts LLC
  region: USA                              region: US

─────────────────────────────────────────────────────────────────────────────
RELATIONSHIP                       [Inspect RIGHT relationships]
SOURCE                             TARGET
vendor_label: CPC LLC               vendor_name: ComputerParts LLC
region: Germany                    region: DE
Origin: spelling suggestion         Status: selected for inspection only
Comparison: soft signals; scores are similarity, not probabilities
Consequence: add one full-key Mapping row; not applied until Write Mapping
[Defer source] [No suitable target]                  [Confirm relationship]
─────────────────────────────────────────────────────────────────────────────
0 confirmed, not written       [Review actions ▾]          [Review changes]
```

Illustrative labels are from the existing lab; counts are not fixture assertions.
No backend ID is used as a primary record label. Target identity fields and JOIN
outputs are both available when different, with their roles labelled. Basic has
only acquired key fields: do not invent vendor IDs or categories. Advanced can show
actually acquired comparison/reference fields.

RIGHT focus keeps both explorers visible. The SOURCE pane changes its heading to
**LEFT records related to this RIGHT**, with four independently expandable groups:

```text
RIGHT focus: vendor_name: ComputerParts LLC / region: DE
Actual JOIN         Not inspected                   [Inspect executed JOIN]
Existing Mapping    1 source key in project Mapping definition
Confirmed draft     1 source key, not written
Suggested           2 source keys in installed run edges; shortlist incomplete
```

Each group lists labelled LEFT keys, source-row occurrences when known and its
coverage sentence. Group counts are **not additive**. A key may legitimately occur
in more than one group. Rejected/deferred/stale decisions appear with explicit
badges and never count as confirmed relationships.

### Interaction rules

- Clicking a LEFT record changes active focus to LEFT, restores that source's
  last inspection pick and shows its RIGHT candidates/draft/baseline context.
  A fallback suggestion can be displayed as a suggestion, but not as selected.
- Clicking a RIGHT record changes focus to RIGHT. It does not select it for
  confirmation, mutate a proposal, run retrieval or persist anything.
- Clicking a related LEFT row opens that source–target pair for inspection while
  retaining RIGHT context; an explicit **Investigate this source** returns LEFT
  focus. This supports LEFT → RIGHT → related LEFT → another RIGHT.
- **Select for inspection** on a candidate only updates a temporary pair. Only
  **Confirm relationship** invokes the existing validated source decision action.
  RIGHT confirmation is disabled until a specific source and admissible candidate
  are present. A saved-only or executed-only LEFT key without a current proposal
  is read-only: explain why it is outside this run rather than invent a proposal.
- Source and target searches have separate state. Target **Candidates** searches
  displayed alternatives; **Retrieved targets** searches the acquired universe.
  In Advanced, **Find right records** invokes existing verified source lookup
  beyond the shortlist. Display scope alongside search, including empty results.
  RIGHT-only browsing is not source-admissibility verification.
- Search/filter changes never silently substitute a different actionable source
  pair. If a selected source is hidden, retain a clearly labelled pinned inspector
  with **Reveal source**, or clear the actionable pair; no hidden auto-fallback.
- Undo uses the same ledger removal/status projection as today. Defer/no-suitable
  are source decisions, not deletion of a single target edge. Do not add a misleading
  per-candidate Reject button: there is no per-edge rejection model in this change.
- Narrow windows stack explorers above the inspector, preserve explicit focus and
  keep actions reachable without horizontal overflow. Keyboard navigation changes
  focus only; confirmation has a separate button. Announce selection/loading and
  status to assistive technology; never rely on color alone.

## 2. Relationship inspection and consequences

The inspector compares LEFT and RIGHT values aligned by the confirmed plan, not
two candidate targets. Each comparison has its field labels, role and evidence:

| Role | Presentation |
|---|---|
| Hard constraint | Verified pass/fail/unknown, actual values and normalization rule; no inferred pass from equal labels |
| Soft signal | Actual field score and named similarity metric, or unknown; never a calibrated probability claim |
| Reference context | Values labelled reference/unscored, not a numeric zero |
| Other displayed field | Unscored; missing acquisition labelled not acquired |

Show multi-origin suggestion evidence (fuzzy/LLM/manual), and distinguish a **manual
inspection selection** from **verified manual lookup provenance**. Selecting a
fuzzy candidate does not erase its origin or fabricate a completed lookup.
Detailed run IDs, revisions, omission calculations and rationales live in Details;
coverage warnings and blockers stay visible without opening Details.

Before confirmation, show the prospective full-key Mapping input/output and
baseline comparison: **add**, **already matches/no-op**, **conflict**, or **baseline
not acquired**. Confirmation stages a decision only. For JOIN origin, explain that
Write Mapping will atomically prepare/update the compatible map and Apply before
the **original JOIN**, binding every ordered output to the corresponding LEFT
JOIN column. Project-file Save remains separate. Do not promise exact result-row
changes until execution; source occurrence counts are not a prediction of JOIN
output count. For Mapping origin, retain its separate Save contract and refusals.

Review Changes uses existing diff/commit logic but receives an explicitly scoped
read baseline for presentation. Missing baseline yields **unknown**, not a false
add. Conflicting existing nonempty outputs remain blocked; this redesign does not
authorize overwrite despite an inspection diff saying change. Final verification
and preparation remain authoritative even when the displayed baseline looks safe.

## 3. Ownership and focused boundaries

Keep [App session ownership and callbacks](../../../src/App.tsx:5455).
The existing [workspace component](../../../src/components/MatchingWorkspace.tsx)
becomes a small composition boundary rather than accumulating another subsystem.
Suggested responsibilities (names are conceptual, not new files in Phase 1):

| Boundary | Responsibility |
|---|---|
| Workbench composition | Header, focus/inspection state, secondary disclosures, existing operation callbacks |
| Source explorer | Bounded source list/search/status, RIGHT-related provenance groups |
| Target explorer | Candidate and acquired-target lists, explicit scoped lookup, navigation |
| Relationship inspector | Labelled comparison, origin/status, validation blockers, same confirm/undo actions |
| Relationship summary | Per-group coverage, executed facts, Mapping/draft consequences, final diff |
| Plan panel | Existing field roles/shape locks/consent/invalidation; disclosure is nonsemantic |
| Assistant panel | Existing permission/instructions/rank/cancel/merge, no new orchestration |
| Pure relationship selectors | Sparse identity-safe forward/reverse read indexes and group counts |
| Read-only inspection service/hook | Bounded cache, intent epochs, existing Host ports; no write capability |

Only narrow ports are added at the composition boundary for read-only baseline
context and executed-key inspection. App supplies original project execution
context as it already does for Advanced; it does not own a new reverse subsystem.
Extract at most a small shared pure Mapping-binding resolver if necessary to avoid
duplicating existing preparation selection rules. No general store rewrite.

### State classification

1. **Authoritative existing session:** proposals, candidates, plan, ledger, run,
   binding and commit lifecycle stay where they are. The redesign does not write
   display status back as another authority.
2. **Ephemeral presentation:** focus direction, source reference, target reference,
   inspected pair, per-source picks, searches/pages/scroll, expanded groups/panels.
   Own these in the mounted workbench, keyed by session/run; no project persistence.
   Opening/closing Rules, Assistant or Details does not unmount/reinitialize review.
3. **Read-only evidence cache:** references to authoritative seed rows, bounded
   acquired external pages, executed-key responses and coverage/ownership metadata.
   These are revocable evidence, not another Mapping representation or ledger.
   Never feed display cache directly into commit materialization or replace the
   frozen Save baseline with asynchronously refreshed page data.

Presentation survives focus changes and hidden tabs. Run/semantic invalidation
discards stale picks and lookup applicability; preserve harmless panel preferences.
Close warns for dirty decisions as today, then destroys view/cache and invalidates
pending work. Restart restores the project Mapping, **not the in-process draft**.

## 4. Identity and sparse reverse index

Reuse [collision-safe tuple tokens](../../../src/app/matching/types.ts:239) and
producer candidate IDs. Conceptual references carry:

- Source: project/session/run namespace, complete ordered nullable LEFT tuple,
  proposal ID and semantic/evidence revisions.
- Target: run namespace and independent target identity, complete ordered outputs,
  candidate reference when installed, evidence revision. Basic's target identity
  is its exact RIGHT tuple; Advanced retains separate acquired identity parts.
- Pair: structured source reference plus target reference. Use nested structured
  serialization, never concatenation, display-label parsing, trimming or casefold.
- Mapping row: authoritative map ID/definition revision plus full From tuple and
  ordered effective outputs/bindings. Its target identity is **unknown** unless
  uniquely justified by acquired target evidence. Conflicting duplicate From rows
  remain visible errors; do not hide them by overwriting a dictionary entry.
- Executed fact: original JOIN binding, request identity, exact output-key tuple,
  query-time execution evidence. It describes a **JOIN-key group** if several
  target identities share that output; do not attribute counts to each record.

### Derivation algorithm

Build maps once per relevant immutable collection/revision:

1. Index installed candidates by candidate ID, acquired targets by independent
   target identity and outputs by exact tuple token → list of target references.
   Reference existing row objects; do not copy target bodies into each edge.
2. Traverse proposals once. Union proposed/alternative/edge candidate references
   into a set per source, preserving edge origins/scores and whether an edge was
   actually proposed, alternative or verified lookup. Add source references to the
   corresponding target's reverse adjacency. No source × target construction.
3. Traverse the ledger once; resolve current source/candidate/run/revision. Add
   valid confirmations to the confirmed-draft group. Preserve stale/rejected/
   deferred states for inspection but exclude them from active confirmed counts.
4. Traverse acquired compatible Mapping rows once. Index exact outputs → source
   row references independently of proposals, including aliases outside this run.
   If several targets share outputs, show a shared output-group section with
   unknown independent attribution, not duplicated relationship counts.
5. Keep executed-key facts in a separate cache/index by JOIN-key group. Do not
   derive them from the previous indexes.

Time/memory are linear in acquired records + actual stored edges + decisions +
acquired baseline rows. Memoization dependencies exclude focus, search text and
panel disclosure; navigation selects adjacency, not rebuilds the graph. Page lists
before rendering; existing bounded universes may be scanned for search, not
expanded into pairwise scores. Cache a bounded number of lookup/explanation pages
and evict least recently inspected entries; do not retain every query forever.

### Deduplication and presentation merge

Within each group count each exact source/target relation once. A fuzzy + LLM edge
is one suggestion with two origins. Identical duplicate input rows contribute
occurrences, not new source-key relationships. A current confirmation appears as
confirmed-not-written; retain its original suggestion provenance in Details.
An existing Mapping row and a draft targeting the same outputs appear as two
badges on the pair and in their separate groups, with a no-op consequence, not a
combined unique-association total. If outputs differ, show the existing and proposed
relationships side by side; do not overlay the draft onto the baseline or silently
delete the old reverse relation. No sum across provenance groups is displayed.

## 5. Provenance and coverage model

Every group has a read-only coverage descriptor with: evidence kind, original
binding, session/run/revisions where applicable, scope/predicate, count unit,
retrieved count, total if known, row/sample/page limits, omissions/truncation,
completeness status, acquisition time/request and refusal/error reason if any.
Do not expose definition-bearing local fingerprints or secrets in Details.

Completeness is multidimensional: source acquisition, target acquisition,
candidate-edge search, Mapping baseline and executed row enumeration are separate.
Use scoped sentences, not one boolean green “complete” badge.

| Group | Source of truth | Safe coverage sentence |
|---|---|---|
| Suggested | Installed proposal edges/alternatives, including merged origins | “2 source keys in this run's installed candidate edges; 12 source keys acquired; shortlist omissions mean other proposals may exist” |
| Confirmed draft | Existing ledger + current source/candidate evidence | “1 source key confirmed in this session, not written”; stale confirmations separate |
| Existing Mapping | Compatible authoritative seed definition or acquired external rows | “Complete within the current project Mapping definition” OR “Based on 1 acquired page / reviewed From keys; other aliases may exist” |
| Actual JOIN | Explicit existing key explanation/diagnostics | “2 matching LEFT input rows at inspection time; showing 2/2 rows” OR “Showing 50/N sampled rows; original alias count unknown” |

Distinguish **not inspected**, **loading**, **verified zero**, **partial**, **complete
within named scope**, **unavailable/refused/error** and **stale**. Errors never
become zero. A cached stale response may be shown as historical inspection only,
with active actions disabled. No visible group's “0” asserts an unqueried warehouse
absence. Shortlist completeness is not the same as target-universe completeness.

### Cardinality

Within proposed/Mapping evidence, count distinct full source keys and independent
targets or explicitly labelled output groups. Show one→one, many→one, one→many or
many→many **in that evidence scope**. Multiple suggestions are not multiple active
Mapping outputs: the ledger still permits one chosen complete output per source.
Many-to-one aliases are allowed. One output resolving to multiple actual RIGHT
rows is a potential multiplication warning from acquisition; only executed JOIN
facts establish current fan-out. An observed output count after an outer JOIN must
not be interpreted as that many matched pairs without actual partner counts.

## 6. Mapping baseline acquisition and authority

### Resolve the relevant definition, not an arbitrary schema match

For JOIN origin, reuse the map preference and compatibility rules in
[existing tuple preparation](../../../src/app/keyMap/tupleMapping.ts:13): attached
Apply Mapping first; otherwise its generated name and exact generated From/output
column shapes, seed/static storage and output bindings. A small shared read-only
resolver can expose that selection without staging entries or changing the graph.
Do not call preparation with fabricated decisions to discover a map. If none
exists, say **No compatible Mapping attached/selected; Write would create one**.
If resolution is incompatible or ambiguous, show the blocker and preserve commit
refusal. Mapping-origin sessions use their bound map and existing Save support.

| Storage/baseline | Presentation acquisition policy |
|---|---|
| Project seed/static | Reference current authoritative project entries using effective ordered From/outputs; complete within definition. Label separate project Save/export sync status; an unsaved editor overlay is not this baseline |
| Source-backed Mapping-origin | Reuse existing exact-From read for current review and explicit paged reads for inspection. Keep page/exact-key coverage partial; From filters cannot find all aliases for a RIGHT output. Never full-download just to reverse-index |
| Query-backed | Reuse existing bounded read-only preview and relation binding when available; incomplete unless completeness is independently demonstrated. Do not enable writes previously refused |
| Ref/external reference/range | Retain availability/read-only limitations. Unsupported resolution/acquisition shows unavailable; no inline-row fallback or write-policy expansion |

Source page hashes are page-only; do not treat matching hashes/total counts across
pages as snapshot isolation. This iteration does not promise complete external
reverse enumeration. Acquire bounded pages only on explicit intent and display
that the result is partial. Mapping Save during inspection invalidates/reacquires
the affected display baseline, never refreshes a frozen write baseline behind the
user's back. Existing write serialization and conflict refusal remain unchanged.

## 7. Actual JOIN acquisition: existing Host is sufficient, within limits

**Inspect executed JOIN** invokes [existing key explanation](../../../src/lib/bridge.ts:454)
with RIGHT side, exact ordered RIGHT output tuple, original session JOIN and the
same project references/connections/sources execution context. Capture current
context and validate it again before display. Only lossless supported values may
be translated to the existing typed query; do not guess numeric/date identity from
labels. NULL follows actual SQL equality. Return refusal/unavailable if a safe query
cannot be formed.

Interpret [engine results](../../../crates/dwh-engine/src/join_lens.rs:875) honestly:

- Full query-time LEFT/RIGHT input-row and JOIN-result counts for the key; samples
  capped at 50 per grid. When all matching rows fit, record enumeration is complete
  for this query-time key group, not all historical rows or all original aliases.
- The input relation is after preceding transforms. Mapping may have replaced LEFT
  keys; mark them **executed input values**, not recovered original source aliases.
- Several independent RIGHT identities with the same output tuple share this
  execution group. The API is not a per-target-identity filter and cannot assign
  those counts independently. Outer-JOIN/NULL result interpretation must be tested.
- Label **Inspected now against the current JOIN definition**, not “from last
  executed preview”. Separate queries over mutable external files/DBs do not
  guarantee a shared historical snapshot or detect in-place content changes.
- Reuse existing diagnostics for full-input fan-out summaries; do not run them
  automatically on every focus movement. Avoid competing global cancellation
  when abandoning a read; ignore obsolete responses locally unless request-owned
  cancellation is available through the existing infrastructure.

For a request for **complete rows**, report unsupported if the existing response
exceeds the sample cap; offer **Inspect bounded examples (up to 50)** explicitly.
Do not return a sample under a successful complete-query label. No new RPC or
general arbitrary-SQL browser is required by this bounded contract. True complete
external reverse pagination, snapshot-consistent pages or arbitrary original alias
lineage would need separately reviewed capabilities, not a layout-driven RPC.

## 8. Asynchronous safety and state preservation

Use two separate monotonic counters: Matching/session data invalidation and local
inspection intent. Each request captures session ID, project replacement epoch,
original binding/local context identity, current run and semantic/evidence
revision, exact source/target reference, page/query and intent epoch. Validate both
before accepting success, error or finally/loading updates. Context equality alone
cannot defeat A → B → A. Do not serialize raw definitions into user-facing IDs.

| Event | Required behavior |
|---|---|
| LEFT/RIGHT focus changes | Advance inspection intent; retain ledger and valid cached data; no retrieval rerun |
| Lookup query/page changes | New request intent; old page cannot replace latest results or grant source membership |
| LEFT → RIGHT → LEFT ABA | Earlier LEFT reply fails epoch even if key is equal again |
| Rules/Assistant/Details disclosure | Preserve run, picks, focus, searches, permission and decisions; no semantic invalidation |
| Async LLM merge | Merge through existing latest-session producer adapters, never replace newer ledger from an old view snapshot |
| Project replacement, JOIN/upstream edit, semantic plan change | Existing session invalidation plus discard current read applicability; old response cannot reopen active inspection |
| Mapping Save during baseline read | Invalidate read context; old page cannot replace updated baseline; pending write locks remain |
| Matching write starts | Freeze authoritative review as today, invalidate in-flight inspection intent and disable new evidence/confirmation actions |
| Commit acknowledged | Use exact existing reducer receipt, clear old actionable review, show success, require explicit remaining-review refresh; invalidate old pair caches |
| Commit refused/fails, context unchanged | Preserve retryable decisions, show failure; never fabricate a receipt |
| Hidden tab | Preserve view state; no background rerun; session invalidation still applies |
| Close/unmount | Invalidate request epochs and callback ownership; no late state/decision publication |

An inspection response is never written into a decision. Advanced manual selection
from RIGHT focus must first resolve a current proposal and its own source-scoped
lookup page/admissible candidate. Reuse existing confirmation flow, including
registration of exact manual evidence and final Host reacquisition/page replay.
The fact that the same target was valid for a different LEFT is not authority.
Saved-only and executed-only LEFT rows stay read-only unless an existing supported
explicit Matching acquisition creates a fresh verified proposal; no silent full
scope fallback is added.

## 9. Secondary controls and lifecycle

- **Matching Rules:** collapsed by default after a run; full Basic/Advanced fields,
  normalization, hard/soft/reference roles, locked original keys/outputs and
  explicit semantic edit consent remain. Scope/caps are visible before executing.
- **Assistant:** closed by default; preserve consent, instructions, bounded LLM
  calls/progress/cancel and allowlist merge. Panel disclosure never alters the plan.
- **Review actions:** contextual selection/page/filter scopes, counted preview,
  excluded reasons, conservative high-confidence and explicit reviewed bulk as
  separate actions. Ordinary focus selection is not a reviewed checkbox.
- **Details:** exact IDs, metric, coverage dimensions, revisions and raw-value
  inspection, without secrets. Critical coverage and stale/write blockers remain
  visible in the primary view.
- **Review Changes:** opens final diff/consequences, then explicit Write Mapping.
  Receipt and separate project Save instruction remain visible after commit;
  do not auto-rerun or preserve old actionable pairs under a shifted JOIN index.

## 10. Existing Help Lab acceptance design

Adapt the [vendor lab](../../../fixtures/labs/name_region_match/) rather than
creating an artificial pack:

1. Open the exact-pair JOIN from the existing Help Lab. Inspect unmatched CPC LLC
   / Germany and other German aliases; all key parts remain labelled.
2. Find/inspect ComputerParts LLC / DE in the acquired targets, even if not the
   winning suggestion. Manual search remains visible with no-candidate sources.
3. Focus that RIGHT key; inspect actual JOIN counts/samples and distinguish them
   from suggestions. Existing exact German invoices already demonstrate executed
   rows even though the Matching run contains unmatched keys only.
4. Navigate to a related unresolved German alias. Select for inspection, verify
   no decision happened, confirm, undo, then explicitly confirm again.
5. Review full name/region output diff and original JOIN Apply consequences.
   Write Mapping + Apply atomically, execute, Save and cold reopen.
6. Explicitly refresh remaining review; inspect another German alias against the
   same RIGHT, now with saved Mapping plus new draft/suggestion provenance. The
   first original alias appears in Mapping even if no longer an unmatched proposal.
7. Recheck actual JOIN results. Optionally inspect the existing name-only JOIN to
   demonstrate genuine region fan-out, without equating suggestions with fan-out.

The lab's existing vendor-ID seed belongs to a different output shape and cannot
be used as the full-tuple baseline. Preserve it and the existing mapped mart.
Expose the workflow using business actions, not instructions to pick an algorithm.

## 11. Completion boundary

Follow [tasks and acceptance matrix](tasks.md). Phase 1 ends with the proposed
packet only. Phase 2 alone is not final acceptance; Phase 3 requires understandable
reverse investigation, and Phase 4 requires real Host journeys, regression evidence
and merged delivered contracts. Record failures and unsupported scopes honestly.
