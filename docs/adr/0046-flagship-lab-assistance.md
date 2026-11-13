# ADR-0046 — Bounded assistance in the reconciliation Help lab

## Status

**Accepted** (2026-11-13), implementing the explicitly approved PR-02 / PR-02H /
PR-03 scope of the immediate UX brief. This does not authorize general guidance.

Related: [ADR-0005](0005-ux-blow-away.md), [ADR-0039](0039-help-lab-catalog.md),
[ADR-0041](0041-heavy-preview-sample.md), [ADR-0045](0045-safe-help-lab-switch.md).

## Decision

1. Only a successfully opened reconciliation flagship gets a session-local,
   dismissible task card. Ordinary projects, reopened saved labs and other labs
   do not acquire tutorial state by matching query names. The state is keyed to
   the current project identity and cleared on successful project replacement.
2. The existing catalog remains discovery metadata SoT. A small frontend scenario
   module may own instructional text and semantic query/step targets; it must not
   duplicate the catalog or introduce persistent project/Mapping/guidance IR.
3. Show me uses existing query/step selection and Data/Join Lens actions. It does
   not mutate the graph, auto-accept a correspondence, force layout collapse,
   scroll the IDE, run a modal tour, or request a cloud service.
4. PR-02H may add one opt-in lab-local hint at a time for two semantic goals:
   inspect the original Join, then reach Join Lens No match. Existing selection
   and the actual Lens mode determine progress; a prescribed click is not
   required. Dismiss/Escape ends hints until explicit Show me. No idle timer in
   this implementation. Hidden/unavailable targets use text fallback, never
   coordinate guesses. No global overlay service or event bus.
5. Original / mapped example / monthly reconciliation navigation reuses existing
   queries and previews. The mapped pipeline is pre-existing and partial, not
   a user achievement. No success badge or invented before/after metrics. Labels
   must describe sampling honestly and tell users to recompute after map edits.
6. New controls use English UI and accessible keyboard actions. Hints must not
   steal focus; reduced-motion removes pulse. Ordinary editing remains possible.

## Delivery contracts

- [Task card change](../../openspec/changes/recon-lab-task/proposal.md)
- Merged capability: [Help Lab](../../openspec/specs/help-lab/spec.md)

If local assistance requires a general service or a broad editor refactor, stop
the hint slice and retain the task card and start navigation instead.
