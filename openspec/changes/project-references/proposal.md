# Proposal: Project references

## Why

Reusable queries and mappings currently have to be copied into each `.dwhproj.json`. Copied definitions diverge, and `Project.id` is only a name slug, so two projects cannot be told apart when their local ids match.

[ADR-0025](../../../docs/adr/0025-project-references.md) decides the first-release contract: a root project references saved owner projects, resolves a read-only closure, and exports one dbt project.

## What changes

| In scope | Out of scope |
|----------|--------------|
| `project_uid`, reference declarations, typed external targets | Git clone, registry, remote download |
| Explicit refresh and relink; semantic revision | Automatic dependency upgrades |
| One resolver and one lowering adapter | A second SQL compiler |
| Owner-relative paths; global connection bindings | Copying secrets or scanning another vault |
| Seed / Postgres / dbt-ref mapping behavior kept | Local overrides of external definitions |
| One deterministic dbt export plus provenance | dbt Mesh or `packages.yml` for these references |
| Explorer references, qualified pickers, external badges | Showing every owner graph by default |

## Capabilities

1. **project-references** — identity, revision, resolution, resources, UI, export, and the execution fixture

## Success

- Existing projects load and export as they do today.
- Two owners with the same name and the same query id stay distinct.
- Preview and `dbt build` of a consumer agree on a known fixture without hand-edited SQL.
- An owner save does not change the consumer until an explicit update.
- The consumer never writes the owner file or the owner seed.

## References

- [ADR-0025](../../../docs/adr/0025-project-references.md)
