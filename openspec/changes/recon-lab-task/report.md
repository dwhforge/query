# PR-02 report — task card

Baseline: PR-01 commit 7de08b5106f5ede215ff0599b22f3d63dc3b887c.

Before: the offline lab selected the original Join but supplied no task card.
After: one English, dismissible instruction appears only for a successfully
opened canonical flagship session. Show me selects the actual original Join
and Data/Lens without mutating steps or collapsing the layout. Lab task restores
the card explicitly; switching project/lab clears the session. Missing targets
disable the action with an explanation. Scenario instructions do not duplicate
catalog discovery metadata or change host/fixture schema.

Validation: all 30 unit-test files pass. The Electron runner built host and UI;
all 3 new journey scenarios passed. Combined with PR-01, 15 tests passed and one
test failed before its first window appeared (startup timeout); that exact test
passed on an explicit last-failed retry (1/1). No automatic retry is configured.
The initial type-check failure in the ownership helper was corrected before the
successful build/run. Broader pre-existing suite failures remain recorded in
the [PR-01 report](../safe-help-lab-switch/report.md).

Evidence: [running task card](../../../docs/stabilization/recon-task-card.png).
No human one-minute comprehension test or video claimed. Hints and reference
navigation deliberately belong to subsequent slices. ADR-0046 and the task-card
delta are merged into [Help Lab SoT](../../specs/help-lab/spec.md).
