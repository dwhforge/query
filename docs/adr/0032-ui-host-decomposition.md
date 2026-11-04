# ADR-0032 — UI / host decomposition by scenario

## Status

**Accepted** (2026-11-03). OpenSpec: [`openspec/changes/ui-host-decomposition/`](../../openspec/changes/ui-host-decomposition/).

## Context

`App.tsx` (~7k lines) and `api.rs` (~2.5k) mix many scenarios. Blind file splits lose behavior. After typed wire ([ADR-0029](0029-typed-wire-contract.md)), format version ([ADR-0030](0030-project-format-version.md)), and execution lifecycle ([ADR-0031](0031-execution-lifecycle.md)), we extract **one finished scenario at a time** behind stable boundaries.

## Decision

Target call path:

```text
UI → typed client → command handler
                  → application service
                  → domain / engine / storage
```

1. Extract by **scenario**, not by line count: **checks → KeyMap editing → project persistence** (then others).
2. **Application services** are pure (or nearly pure) modules: IR transforms, validation, plans. React/`HostState` only apply results.
3. Preserve behavior; each extract ships with existing or new focused tests.
4. Host `api.rs` keeps dispatch; command bodies move to `commands/<scenario>.rs` when that scenario is extracted.
5. Mapping **data plane** (paged rows out of IR) remains a later stage — do not mix into this ADR’s extracts.

## First slice (this change)

**Mapping checks** (ADR-0027): create check, record CheckRun, allow decision, cohort inspect plan, frozen remap confirm/stage — leave `App.tsx` as a thin applier.

## Consequences

- New tree: `src/app/mappingChecks/` (UI application layer).
- Later: `src/app/keyMap/`, `src/app/project/`; host `commands/project.rs`, etc.
- Do not invent a framework — modules and clear imports only.

## References

- [ADR-0027](0027-mapping-quality-checks.md), [ADR-0029](0029-typed-wire-contract.md), [ADR-0031](0031-execution-lifecycle.md)
