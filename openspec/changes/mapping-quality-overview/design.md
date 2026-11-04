# Design

`demo_mapping_quality/data.rs` owns deterministic generation and atomic cache
publication. Its sibling module constructs an ordinary Workspace using current
LoadCsv/DeriveColumn/ApplyKeyMap/Join/SqlModel steps. There is no new IR.

Two projection models emit at most a small number of matrix groups and 12 target
hotspots. The React overview uses the existing preview RPC. `mappingQuality.ts`
validates completeness, groups dimensions and constructs bounded inspection
queries. Only stable lab ids enable the prototype tab.

Full seed rows still exist in the workspace and generated SQL under existing
semantics. Bounding chart data does not make that underlying transport free.

The UI interprets family/grade mismatches and declared evidence. Similarity gaps
are illustrative fixture values; no matcher has run and no learned correctness
probability is displayed.
