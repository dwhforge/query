# PR-01 — Typed workspace tabs

Replace App's overloaded center-tab strings with a small frontend discriminated
union and pure navigation transitions under ADR-0032. Preserve ADR-0031 execution
ownership, ADR-0044 session lifecycle, ADR-0045 replacement/cancel, ADR-0046 Help
Lab and ADR-0047 demo/live policy plus PR-00A save acknowledgement.

In scope: query canvas, Help Lab, Mapping, Matching and quality identities;
collision-free keys; open/activate/dirty close/reset; App callers and rendering;
pure and focused Electron regressions. Mapping/Matching documents remain with
their current owners and stay mounted while inactive. Close dirty requires
explicit discard. Successful replacement removes project tabs, not Help Lab;
cancel changes nothing.

Out of scope: PR-02+, stores, plugins, routers, event buses, new document/session
owners, Rust, IPC, project format, live retrieval or demo save permissions.

Baseline verified: 9a918c5d668ab4dd39dbf49008a3ab59d2695fba (PR-00B), clean checkout.
No commit authorized. Existing broad E2E baseline is not green (33/2/2).
