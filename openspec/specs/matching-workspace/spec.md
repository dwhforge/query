# Spec Delta: matching-workspace

## ADDED Requirements

### Requirement: Lens Auto vs Matching UX boundary

The product SHALL separate Join Lens **Quick match** (batch under current
Lens fields and rules, no separate contextual plan — ADR-0042) from Matching
**Contextual matching** (multi-field task, constraints, alternatives,
longer review). The split SHALL be by task complexity, not by whether an LLM is
used. The product SHALL NOT present two identically labelled Auto/AI match
actions with different behaviour. Product UI copy SHALL be English.

#### Scenario: Lens offers two distinct actions
- **GIVEN** Join Lens on a Join with unmatched keys
- **WHEN** the user views match actions
- **THEN** **Quick match** is explained as using current Lens fields/rules
- **AND** **Contextual matching…** is explained as multi-field / conditions /
  alternatives and opens Matching

#### Scenario: Mapping editor opens Matching
- **GIVEN** a Mapping editor tab for a map
- **WHEN** the user chooses **Open matching…**
- **THEN** a Matching session opens bound to that map

#### Scenario: Matching opens Lens for outcome
- **GIVEN** a Matching session after Save (or with an applied map)
- **WHEN** the user chooses **Open result in Lens**
- **THEN** Join Lens opens for inspection
- **AND** Matching session state is not silently discarded by that navigation

#### Scenario: Lens → Matching does not auto-run
- **GIVEN** the user opens Matching from Lens with an explicit scope
- **WHEN** Matching opens
- **THEN** scope and transferable settings are shown
- **AND** a second processing run does not start automatically

### Requirement: Matching workspace tab and session lifecycle

The product SHALL provide a Matching workspace tab beside Pipeline and Mapping
editor. It SHALL include: structured plan editor (optional chat), run status and
controls, proposal table, detail panel, counters, and final review. Until
restart persistence ships, Matching SHALL always show a persistent banner that
the draft exists only for the current app run, will not restore after restart,
and only Saved map correspondences persist. Tab switch SHALL preserve session
state in-process. Closing Matching, closing the project, changing connection, or
quitting the app with unsaved user decisions SHALL warn. The product SHALL NOT
promise crash protection. Without restart restore, Matching SHALL be positioned
only as a capped preview workplace.

#### Scenario: Banner always visible before persistence
- **GIVEN** an open Matching session without durable draft persistence
- **WHEN** the user views any Matching panel
- **THEN** the no-restart-restore limitation is visible without opening docs or
  dismissing a one-shot toast

#### Scenario: Switch tabs keeps draft
- **GIVEN** draft decisions and an active filter in Matching
- **WHEN** the user opens Pipeline then returns
- **THEN** those decisions, filter, and selection remain

### Requirement: Structured MatchingPlan editor

The plan SHALL be the execution contract and edited primarily via structured UI
(source/target, map key, comparison pairs with role hard constraint / soft
signal / reference context, normalization, outputs, ambiguity behaviour, scope
and run limits). When opened from Join Lens, Source/Target/Map key/identity/
outputs/comparison fields SHALL offer column and query choices from the Join
parents (combos / multi-select), not only free text; defaults SHALL prefer the
left FromQuery parent as Source, id-like target identity (e.g. `vendor_id`), and
one soft comparison per Join ON pair. Chat MAY populate the editor but SHALL NOT
be required to edit it. A valid plan SHALL use one primary control **Apply plan and run trial**.
The product SHALL block only unresolved blockers (missing identity,
ambiguous map key, incompatible outputs), not per-field confirms. Plan changes
SHALL show a concrete diff and affected results. The product SHALL maintain
separate semantic and UI revisions: display/sort/label changes do not invalidate
proposals; comparison-semantics changes invalidate affected proposals; map key,
target identity, or outputs changes require re-validation of the affected draft.
LLM SHALL NOT silently alter semantic plan rules.

#### Scenario: Apply plan starts trial without chat
- **GIVEN** a valid plan filled in the structured editor with chat collapsed
- **WHEN** the user activates **Apply plan and run trial**
- **THEN** the trial run starts under plan scope/limits
- **AND** no chat message is required

#### Scenario: UI-only plan tweak keeps proposals
- **GIVEN** proposals under semantic revision R
- **WHEN** the user only changes sort order or a display label (UI revision)
- **THEN** proposals are not marked Stale for that reason

### Requirement: Numeric run caps and metrics

Matching runs SHALL enforce documented first-slice caps (trial ≤20 unique map
keys; mass ≤200 unique map keys; retrieval shortlist ≤40 candidates/key; ≤10
candidates/key per LLM request; local full-scan target universe ≤10 000 rows;
≤2 parallel LLM requests; ≤1 automatic retry/request; ≤220 LLM calls/run
including plan interpretation and retries) or a shared config that reuses HEAD
fuzzy/LLM relatives with explicit justification for differences. Targets above
the local universe cap SHALL use server-side retrieval or refuse with
explanation — never a silent full download. Expand-search SHALL stay within
remaining budget. Token hard limits SHALL come from provider config. Missing
monetary tariffs SHALL NOT lift caps. Budget exhaustion SHALL yield a partial
result with stop reason and SHALL NOT silently continue past the limit. Before
run the UI SHALL show scope and upper bounds; after run it SHALL show actual
candidates, calls, tokens, duration, retries, and unprocessed keys.

#### Scenario: Over-cap target refuses silent download
- **GIVEN** a target relation larger than the local universe cap and no
  server-side retrieval path configured
- **WHEN** the user starts a run
- **THEN** the product refuses or requires an explicit alternative path
- **AND** does not download the full target unnoticed

#### Scenario: Budget stop is partial and labelled
- **GIVEN** a run that exhausts the LLM call budget mid-scope
- **WHEN** processing stops
- **THEN** completed keys remain available for review
- **AND** the stop reason and unprocessed key count are shown
- **AND** no further batches run automatically past the limit

### Requirement: Host-side validation trust boundary

Client-side checks are UX only. Accepting an LLM result, accepting a draft
decision, and final commit SHALL validate in the application/host layer: task/
session identity, semantic plan revision, full source key, target ID in the
registered candidate set, target evidence freshness, outputs materialized from
one registered target row, and live map content plus write policy. The renderer
SHALL submit proposal/candidate identifiers and expected revisions — not a
trusted output tuple. Manual search picks SHALL register as verified candidates
before use. Forged host API payloads (unknown target ID, other-session ID,
mutated outputs, stale revision, read-only map write) SHALL be rejected
regardless of renderer state.

#### Scenario: Forged unknown target id rejected at host
- **GIVEN** a Matching session with a registered candidate set
- **WHEN** a host draft-accept or commit API is called with a target ID absent
  from that set
- **THEN** the call is rejected
- **AND** no map write occurs

#### Scenario: Renderer output tuple is ignored
- **GIVEN** a commit request that includes client-supplied output values
  disagreeing with the registered candidate
- **WHEN** the host processes commit
- **THEN** it materializes outputs from the registered candidate (or rejects)
- **AND** does not persist the untrusted client tuple as authoritative

### Requirement: Map-key merge and bulk confirm

The decision unit SHALL be the full map key. Merge logic SHALL compare map
baseline at prepare, live map value, and confirmed proposal. “Filled” means an
existing map row for that From key under the map model — not an automatic
interpretation of `0`, `false`, `""`, or nullable outputs as absence. Ordinary
bulk confirm SHALL NOT replace differing existing values, resolve same-key
conflicts, pick winners by LLM arrival order, or override a confirmed choice
with a later proposal. Conflict at final commit SHALL stop without silent
partial Save. Multiple source rows sharing one key and tuple SHALL count as one
decision with an affected-row count.

#### Scenario: Conflicting proposals block bulk
- **GIVEN** one map key with two different proposed target tuples
- **WHEN** bulk confirm runs over a scope including that key
- **THEN** the conflict is not auto-accepted
- **AND** no map write occurs for that key via bulk

#### Scenario: Same output is no-op
- **GIVEN** the map already contains the confirmed output tuple for a key
- **WHEN** final Save includes that decision
- **THEN** the result is treated as already matching / no-op
- **AND** no duplicate From row is created

#### Scenario: Different existing tuple needs explicit replace
- **GIVEN** the map has a different output tuple for the key
- **WHEN** bulk confirm runs without an explicit replace agreement
- **THEN** that key is excluded from bulk acceptance

### Requirement: Proposal contract and states

Each MatchingProposal SHALL include source identity and full map key, used
source values, proposed target identity or no-choice, host-materializable
outputs from one target row, alternatives, short field evidence, contradictions,
search completeness, semantic plan and evidence revisions, provenance, and
model/prompt metadata when LLM was used. LLM self-scores SHALL NOT authorize
auto-save. States SHALL distinguish at least: Proposed, Ambiguous, No
candidates, Incomplete search, Confirmed in draft, Deferred, Rejected, Stale,
Saved; plus explicit no suitable target. Incomplete/bounded search SHALL NOT
render as confident non-match. Global one-to-one assignment SHALL NOT be
required.

#### Scenario: One key spanning many source rows
- **GIVEN** 24 source rows that share one map key
- **WHEN** counters and review labels are shown
- **THEN** the UI presents one correspondence affecting 24 rows

#### Scenario: Incomplete search is not proven absence
- **GIVEN** a source key whose candidate search was truncated or bounded
- **WHEN** no candidate is returned
- **THEN** the state is Incomplete search or equivalent — not confident “no match”

### Requirement: Review UI and draft confirm

The review table SHALL show source identity/key values, proposed target and main
fields, short evidence, near-alternative presence, and decision status, with
actions to open detail, confirm draft, choose alternative, defer, reject, or
mark no suitable target. Filters SHALL include needs decision, ambiguous,
incomplete search, confirmed, stale, and all. Paging SHALL NOT lose draft.
Counters SHALL separately track source rows, unique map keys, proposals, and
confirmed decisions. Detail view SHALL compare proposed vs alternatives with
original and normalized values and checkable evidence (not color alone). Bulk
draft confirm SHALL show exact scope and exclusions. Draft confirm SHALL NOT
write the map or database.

#### Scenario: Choose alternative into draft without write
- **GIVEN** a proposal with a proposed target and a listed alternative
- **WHEN** the user selects the alternative and confirms draft
- **THEN** the draft decision targets that alternative
- **AND** no map/DB write has occurred yet

### Requirement: Final review Save uses existing storage semantics

Before Save the product SHALL show adds, changes, unresolved (not saved), and
affected source rows, with From tuple / old outputs / new outputs / decision
origin for changes. Only explicitly confirmed non-stale decisions SHALL save,
via existing seed / source dirty-delta / query / ref semantics and shared import
write refusal. The product SHALL NOT create a physical table, alter schema, or
auto-switch storage. Warehouse conflict SHALL NOT be presented as successful
Saved. Double-confirm and re-Save SHALL NOT duplicate From rows. Read-only maps
SHALL refuse write-back via the write command.

Commit planning SHALL NOT mark decisions saved or clear unsaved decisions.
Matching SHALL expose explicit saved, no_changes, conflict, refused, and error
outcomes. Only acknowledged persistence or a no-op verified against the current
Mapping SHALL settle the corresponding confirmed decisions. Missing target IDs,
missing maps, import refusal, unsupported write bindings, skipped required writes,
conflict/error, cancellation, and stale context SHALL NOT count as Saved.

Live map data SHALL be revalidated before mutation. Source maps SHALL use real
exact-key baselines and existing dirty-delta writes, not paged/project caches.
Unrelated dirty Mapping drafts SHALL NOT be implicitly saved. Explicitly approved
replacements SHALL write the approved outputs, not silently preserve old cells.

Failures SHALL keep confirmed decisions and allow retry without success copy.
Successful Mapping Save SHALL NOT imply that the project file has been saved.
A skipped external sync for a seed with no linked export SHALL acknowledge its
successful local Mapping save; this is not a refused warehouse or linked-seed write.
Failed external sync SHALL NOT imply rollback of a local AST update. Retrying
after external failure SHALL retry persistence even if local rows now match.
Late replies SHALL NOT settle a changed/closed session or replacement project.

#### Scenario: Missing target or failed write
- **GIVEN** confirmed draft decisions
- **WHEN** target resolution or persistence fails or refuses the write
- **THEN** the draft stays dirty and no Saved message is displayed

#### Scenario: Acknowledged save and repeated save
- **WHEN** the existing Mapping path acknowledges persistence
- **THEN** only the confirmed write set becomes saved
- **AND** a repeated save verifies live rows without duplicating From keys

#### Scenario: Concurrent edit during save
- **WHEN** the map, session, or project changes while planning or writing awaits
- **THEN** stale work is not published as a successful current-session save
- **AND** committed writes are not described as rolled back

#### Scenario: Conflict at commit stops without partial Save
- **GIVEN** confirmed draft decisions and a live map conflict detected at commit
- **WHEN** Save runs
- **THEN** the operation stops and surfaces the conflict
- **AND** does not silently apply a partial subset as successful Saved

#### Scenario: Read-only import refuses Matching Save
- **GIVEN** a map whose import write policy is read-only or broken
- **WHEN** Matching Save is attempted
- **THEN** write-back is refused by the shared write path
