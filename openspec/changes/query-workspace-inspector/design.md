# Design

Use functional view components and explicit read/command ports. QueryWorkspace
owns pipeline/result/Inspector layout; shell tool/session content is a named slot.
Inspector owns selected-target composition, with local step editor state seeded
once per project/query/index/type identity. No App-level text drafts or hydration
effect. Normalized IR is not a draft representation. A commit acknowledgement
must not remount the editor or rewrite its text. Structural selection changes
hydrate the newly selected target. Replacement generation prevents cross-project
reuse even where ids match.

Column loading is an editor lifecycle effect: cancellation plus current request
identity rejects late replies; choices do not set text/key drafts. Canvas may
read the selected Join through a narrow read-only editor API, never setters.
Existing transformations remain App/application-service commands. Keep a narrow
result integration adapter where Lens callbacks cross Mapping, Matching and lab
owners; document this limitation rather than claiming Lens ownership extracted.

No controller consolidation, new execution scheduler, store or event bus.

## Delivered component boundaries

- QueryWorkspace composes the existing graph, result dock and Inspector. Shell
  tool tabs, lab guidance and mounted other-tool sessions enter through one named
  shell-content slot. Shared sash dimensions stay in App through a typed geometry
  port because View/Focus Join Lens must manipulate the same frame.
- QueryResultDock owns Data/Model toolbar, state presentation, diagnostic samples,
  PreviewTable and generated SQL. Preview and Join snapshots/actions are separate
  ports, not merged execution state.
- QueryInspector owns query header/execution/publish controls, source schema,
  external read-only context, History and editor dispatch. Commands apply through
  the existing App transformations. Its editor key is a tuple of replacement
  generation, query id, selected index and step kind, not a workspace fingerprint.
- Text, Columns, Derive, Join, Relation, Mapping and Load editor families receive
  only their required read/command ports. There is no global draft hook returning
  setters. Join owns its key/type/right-query state and schema request lifetime;
  Columns owns upstream choices and the existing local Fields control.
- SelectColumns text/selection transitions are pure and separately unit-tested.
  Reading normalized columns on Apply does not normalize the visible text.

Only JoinLens itself remains an App-controlled view adapter. Its existing
callbacks cross Mapping writes, original-Join Matching creation and lab hints;
moving those scenarios into QueryWorkspace would cross this slice's ownership
boundary or require a broad callback bag. The slot is one view node, not a second
execution owner. The small JoinDiagnosticsPanel slot similarly binds the existing
independent diagnostic controller without handing editor state to it.

## Draft lifetime and compatibility

Apply, Recompute, query-context revisions and successful Save do not change editor
identity. Neither do tool tabs or hiding the Inspector; the view remains mounted.
Selecting another query/index/kind or committing project replacement mounts a
new editor from that concrete target's IR. This is not a multi-target draft cache
or restart recovery feature. Unapplied text is not implicitly project-saved and
does not introduce a new dirty-document category. Existing Save/Apply policy is
unchanged. File path selection and domain authoring remain existing commands.

Join/Columns effects cancel their own completion lifetime. Their only publication
is schema choices/loading, never form hydration. Join schema availability retains
the overlay/Help/quality gates and the full quality-Join exclusion. The canvas
can read the mounted selected Join's current key/type snapshot, scoped to its
host query; unrelated queries cannot borrow another editor's draft.
