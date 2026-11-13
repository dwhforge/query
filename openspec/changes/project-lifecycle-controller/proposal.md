# PR-02 — Query project lifecycle controller

Extract the existing Query Project scenario under ADR-0032, preserving Accepted
ADR-0031/0044/0045/0046/0047 and PR-00A/B/01. No new product decision.

## Scope

- A concrete dependency-injected controller owns dirty baseline, replacement
  snapshots, Save/Save As, Open/Recent, lab staging and successful application.
- Reuse the existing pure lab constructor and replacement guard unchanged.
- A testable reset adapter clears Query transient state and uses PR-01 typed
  navigation transitions. Workbench navigation is not persisted Project IR.
- Preserve late edits, app-global connections, independent draft ownership,
  in-flight mutation guards, save cancellation/failure and lab assistance.
- Add delayed-IPC unit coverage and run existing lifecycle/tab/Matching Electron.

## Exclusions

No store/router/event bus/job framework, Rust/IPC/format/dependency changes,
Matching retrieval, original-query Lens navigation repair (PR-03), or broad
baseline failure fixes. Do not commit or discard pre-existing staged PR-01 work.
