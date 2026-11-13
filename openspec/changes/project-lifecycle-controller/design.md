# Design

Review order: proposal → delta specs → this design → tasks. Autonomous execution
is authorized; no approval prompt or new architecture decision is required.

Use a small controller with injected live reads, project update, IPC, chooser,
settings/Recent effects and reset adapter. It owns baseline and operation flags,
captures document/draft/mutation snapshots and calls the existing replacement
guard. React retains the reducer and Mapping/Matching owners. A live ports ref
avoids stale render closures without a second store. Document normalization and
acknowledgement move out of App along with Save As identity policy and guarded
export synchronization. The reset adapter invokes typed tab reset and explicit
transient setters; it never persists navigation or tutorial state.

Tests inject deferred promises at picker/write/load boundaries and independent
draft/mutation owners. Existing Electron suites verify mounted integration and
preserved Matching policy. Native suites are unnecessary absent crate edits.

Focused Electron reproduced the prior error-text timing symptom: successful
preview completion clears the shared App error. Keep project lifecycle errors in
a separate React effect-adapter state, rendered in the existing banner and
cleared by dismissal/successful lifecycle operations, not background previews.
This is a narrow ADR-0045 error-visibility correction, not a global error store.
