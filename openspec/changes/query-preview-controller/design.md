# PR-04A design

Use an injected, React-independent controller under src/app/queryPreview with a
single immutable view snapshot and subscription. Narrow ports read current input,
invoke existing preview/cancel and report client errors. Own the existing
requestGen helper and HeavyPreviewCache, not a second transport or job service.
Timer injection makes debounce/cancel tests deterministic.

The hook supplies stable current-ref dispatch and owns React effect wiring.
Scheduling follows actual preview inputs and surface availability; QueryContext
revision is not an effect scheduler. Explicit selection invalidates synchronously
and requests a post-render sample through the preview owner's own trigger, so
same-target navigation cannot accept pre-navigation work. Render-time snapshot
matching prevents old rows appearing before effects run. Every completion also
checks current input, closing the render/effect gap.

App retains dataWorkspace (including selected-Join truncation and inspection
exception), model SQL preview, Join prepare/diagnostics/progress, diagnostic sample
view and rendering. It calls narrow preview preemption/cancel/refresh/mode actions.
ProjectSessionReset replaces preview setter fan-out with resetPreview once; its
separate diagnostic session generation still advances on replacement.

No progress polling is moved: Query Data preview has phase/loading, not a host
progress stream. PR-04B retains the existing context/session guarded Join polls.
Preserve stable Mapping editor registration and current callback dispatch.
