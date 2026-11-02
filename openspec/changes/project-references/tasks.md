# Tasks — project-references

## 1. Contract
- [x] 1.1 ADR-0025 Accepted, reconciled with ADR-0012/0013/0014/0015/0020/0022/0024
- [x] 1.2 OpenSpec proposal, spec, design, tasks
- [ ] 1.3 Merge delta into `openspec/specs/project-references/` when the fixture and UI scenarios pass

## 2. Identity and wire
- [x] 2.1 `project_uid`, references, connection bindings; bare-string local targets
- [x] 2.2 Save mints a uid without clobbering one already on disk; consumer save does not write owners
- [x] 2.3 Semantic revision in `dwh-pipeline`, including authoritative seed bytes

## 3. Resolver
- [x] 3.1 Closure walk, diamond dedupe, cycle path, unused-reference tolerance
- [x] 3.2 Owner-relative paths, Hive source copy, connection binding
- [x] 3.3 Dialect failure for raw SQL; ref-mapping preview limit preserved
- [x] 3.4 Lowering to a workspace the existing compilers accept

## 4. Export and host
- [x] 4.1 Namespaced models, seeds, Postgres `source()` names, provenance file
- [x] 4.2 Preview, describe, and export lower one snapshot
- [x] 4.3 Engine fixture: files → DuckDB `dbt build` matches preview; explicit refresh; DuckDB → Postgres project shape (`DWH_PG_DSN` when set)

## 5. UI
- [x] 5.1 Explorer References section: add, status, update, relink, remove-if-unused
- [x] 5.2 Qualified picker and use-in-new-query
- [x] 5.3 External boundary node and read-only inspector; local copy of one object

## 6. Done
- [ ] 6.1 Fixture scenarios in the spec pass
- [x] 6.2 Release notes: local files, explicit update, cycles, read-only consumer, owner-save gate, live rows are not pinned
