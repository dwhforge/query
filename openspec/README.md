# OpenSpec

Spec-driven changes for DWHForge Query. Product decisions remain in `docs/` (DESIGN, ADR). OpenSpec tracks **behavior deltas** for a change before/while implementing.

**Agents:** required workflow is in [`AGENTS.md`](../AGENTS.md) and [`.cursor/rules/adr-openspec.mdc`](../.cursor/rules/adr-openspec.mdc) (`alwaysApply`).

```text
openspec/
  changes/<id>/
    proposal.md    # why / scope
    design.md      # how (optional for small changes)
    specs/...      # DELTA: ADDED/MODIFIED requirements + scenarios
    tasks.md       # implementation checklist
  specs/           # ARCHIVED SoT: merged capability specs after apply/archive
```

- **While building:** edit `changes/<id>/specs/<capability>/spec.md`.
- **When the change is finished:** merge those deltas into `specs/<capability>/spec.md` (create the tree if missing). **Completed changes must merge here** — not left only under `changes/`.
- Do not confuse with [`docs/SPEC.md`](../docs/SPEC.md) (product IR overview).

Active changes:

- [Flagship task card](changes/recon-lab-task/proposal.md) — PR-02 implemented; merged into [Help Lab](specs/help-lab/spec.md), [ADR-0046](../docs/adr/0046-flagship-lab-assistance.md); see [evidence](changes/recon-lab-task/report.md).

- [Safe Help Lab switch](changes/safe-help-lab-switch/proposal.md) — **implemented; contract merged** → [Help Lab](specs/help-lab/spec.md) ([ADR-0045](../docs/adr/0045-safe-help-lab-switch.md)). Save / Discard / Cancel and independent lab save identity; see [delivery report](changes/safe-help-lab-switch/report.md) for actual tests and broader-suite failures.

- [`changes/matching-workspace/`](changes/matching-workspace/) — Matching tab (ADR-0044); **contract merged** → [`specs/matching-workspace/`](specs/matching-workspace/); see `changes/matching-workspace/report.md` for tested scope / Electron E2E gap

- ~~[`changes/project-relative-load-paths/`](changes/project-relative-load-paths/)~~ — **merged** → [`specs/project-relative-load-paths/`](specs/project-relative-load-paths/) ([ADR-0043](../docs/adr/0043-project-relative-load-paths.md))

- ~~[`changes/join-lens-in-place-confirm/`](changes/join-lens-in-place-confirm/)~~ — **merged** → [`specs/join-lens-in-place-confirm/`](specs/join-lens-in-place-confirm/) ([ADR-0042](../docs/adr/0042-join-lens-in-place-confirm.md))
- ~~[`changes/heavy-preview-sample/`](changes/heavy-preview-sample/)~~ — **merged** → [`specs/heavy-preview-sample/`](specs/heavy-preview-sample/) ([ADR-0041](../docs/adr/0041-heavy-preview-sample.md))
- ~~[`changes/postgres-schema-import/`](changes/postgres-schema-import/)~~ — **merged** → [`specs/postgres-schema-import/`](specs/postgres-schema-import/) ([ADR-0040](../docs/adr/0040-postgres-schema-import.md))
- ~~[`changes/help-lab-catalog/`](changes/help-lab-catalog/)~~ — **merged** → [`specs/help-lab/`](specs/help-lab/) ([ADR-0039](../docs/adr/0039-help-lab-catalog.md))
- ~~[`changes/keymap-apply-operation/`](changes/keymap-apply-operation/)~~ — **merged** → [`specs/keymap-apply-*`](specs/) ([ADR-0038](../docs/adr/0038-keymap-apply-operation.md))
- ~~[`changes/keymap-multi-output/`](changes/keymap-multi-output/)~~ — **merged** → [`specs/keymap-multi-output-*`](specs/) ([ADR-0037](../docs/adr/0037-keymap-multi-output.md))
- [`changes/query-based-mapping-create/`](changes/query-based-mapping-create/) — query-based KeyMap create v0.3.1 ([ADR-0034](../docs/adr/0034-keymap-authoring-context.md))
- ~~[`changes/query-backed-keymap/`](changes/query-backed-keymap/)~~ — **merged** → [`specs/query-backed-keymap/`](specs/query-backed-keymap/) ([ADR-0036](../docs/adr/0036-query-backed-keymap.md))
- ~~[`changes/typed-wire-contract/`](changes/typed-wire-contract/)~~ — **merged** → [`specs/typed-wire-contract/`](specs/typed-wire-contract/) ([ADR-0029](../docs/adr/0029-typed-wire-contract.md))
- ~~[`changes/ui-host-decomposition/`](changes/ui-host-decomposition/)~~ — **merged** → [`specs/ui-host-decomposition/`](specs/ui-host-decomposition/) ([ADR-0032](../docs/adr/0032-ui-host-decomposition.md))
- ~~[`changes/mapping-data-plane/`](changes/mapping-data-plane/)~~ — **merged** → [`specs/mapping-data-plane/`](specs/mapping-data-plane/) ([ADR-0033](../docs/adr/0033-mapping-data-plane.md))
- ~~[`changes/project-format-version/`](changes/project-format-version/)~~ — **merged** → [`specs/project-format-version/`](specs/project-format-version/) ([ADR-0030](../docs/adr/0030-project-format-version.md))
- ~~[`changes/execution-lifecycle/`](changes/execution-lifecycle/)~~ — **merged** → [`specs/execution-lifecycle/`](specs/execution-lifecycle/) ([ADR-0031](../docs/adr/0031-execution-lifecycle.md))
- ~~[`changes/keymap-stewardship-shapes/`](changes/keymap-stewardship-shapes/)~~ — **merged** → [`specs/keymap-stewardship-shapes/`](specs/keymap-stewardship-shapes/) ([ADR-0028](../docs/adr/0028-keymap-stewardship-shapes.md))
- [`changes/return-and-edit-foundation/`](changes/return-and-edit-foundation/) — seeds → safe re-export → e2e
- [`changes/join-key-mapping/`](changes/join-key-mapping/) — KeyMap / NormalizeKey / near-miss ([ADR-0020](../docs/adr/0020-join-key-mapping.md))
- [`changes/app-options-recent/`](changes/app-options-recent/) — Options + Open Recent ([ADR-0021](../docs/adr/0021-app-options-recent-projects.md))
- ~~[`changes/mapping-quality-checks/`](changes/mapping-quality-checks/)~~ — **merged** → [`specs/mapping-quality-checks/`](specs/mapping-quality-checks/) ([ADR-0027](../docs/adr/0027-mapping-quality-checks.md))
- ~~[`changes/project-references/`](changes/project-references/)~~ — **merged** → [`specs/project-references/`](specs/project-references/) ([ADR-0025](../docs/adr/0025-project-references.md))
- ~~[`changes/keymap-live-bind/`](changes/keymap-live-bind/)~~ — **merged** → [`specs/keymap-live-bind/`](specs/keymap-live-bind/) ([ADR-0022](../docs/adr/0022-keymap-postgres-live-bind.md))
- ~~[`changes/dbt-setup-onboarding/`](changes/dbt-setup-onboarding/)~~ — **merged** → [`specs/dbt-setup-onboarding/`](specs/dbt-setup-onboarding/) ([ADR-0023](../docs/adr/0023-dbt-setup-onboarding.md))
- ~~[`changes/keymap-composite/`](changes/keymap-composite/)~~ — **merged** → [`specs/keymap-composite-*/`](specs/) ([ADR-0024](../docs/adr/0024-keymap-composite.md))

Review order: proposal → specs → design → tasks. Implement only after that review (`openspec apply` / agent apply).

- ~~[`changes/mapping-quality-overview/`](changes/mapping-quality-overview/)~~ — **prototype implemented**, contract merged → [`specs/mapping-quality-overview/`](specs/mapping-quality-overview/) ([ADR-0026](../docs/adr/0026-mapping-quality-overview.md))
