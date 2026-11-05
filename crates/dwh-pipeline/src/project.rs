//! Durable Project document (`project.json`) — ADR-0009 / ADR-0012 / engine×destination.
//! Document versioning: [ADR-0030](../../../docs/adr/0030-project-format-version.md).

use crate::connection::ConnectionDef;
use crate::destination::{Destination, ExecutionEngine, Materialization};
use crate::dialect::WarehouseDialect;
use crate::mapping_check::{CheckRun, MappingCheck};
use crate::model::Workspace;
use crate::producers::DbtTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// On-disk project document version (ADR-0030). Independent of IPC protocol version.
pub const PROJECT_FORMAT_VERSION: u32 = 3;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Csv,
    Parquet,
    Postgres,
    Duckdb,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SourceDef {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table_name: Option<String>,
    /// Hive-style `key=value` partition folders → columns (Parquet sources only).
    #[serde(default)]
    pub hive_partitioning: bool,
}

/// Look up source-specific Hive partitioning for a LoadParquet path.
pub fn parquet_hive_partitioning(
    sources: &[SourceDef],
    path: &str,
    connection_id: Option<&str>,
) -> bool {
    let path = path.trim();
    sources.iter().any(|s| {
        s.kind == SourceKind::Parquet
            && s.hive_partitioning
            && s.path.as_deref().map(str::trim) == Some(path)
            && s.connection_id.as_deref() == connection_id
    })
}

/// Saved React Flow node positions (query id → canvas coords).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct CanvasLayout {
    #[serde(default)]
    pub positions: std::collections::BTreeMap<String, CanvasPosition>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CanvasPosition {
    pub x: f64,
    pub y: f64,
}

/// A dependency on another saved DWHQuery project ([ADR-0025](../../../docs/adr/0025-project-references.md)).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ProjectReference {
    /// Stable within the declaring project. Not derived from `alias`.
    pub id: String,
    /// Display and search label. Not object identity.
    pub alias: String,
    /// Project-file path, relative to the declaring project file.
    pub locator: String,
    pub expected_project_uid: String,
    /// Semantic definition fingerprint of the owner.
    pub locked_revision: String,
}

/// Remap of an owner connection requirement onto a global connection id.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ConnectionBinding {
    pub owner_project_uid: String,
    pub owner_connection_id: String,
    pub local_connection_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
    /// Document schema version ([ADR-0030](../../../docs/adr/0030-project-format-version.md)).
    /// Missing on disk → treated as 0 at load; always written as [`PROJECT_FORMAT_VERSION`] on save.
    #[serde(default)]
    pub format_version: u32,
    pub id: String,
    pub name: String,
    /// Immutable global identity ([ADR-0025](../../../docs/adr/0025-project-references.md)).
    /// Empty until the owner saves. Not a substitute for query/source/mapping ids.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_uid: String,
    /// Other saved projects this file uses. Empty for a local-only project.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<ProjectReference>,
    /// Owner connection id → global connection id. No secrets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connection_bindings: Vec<ConnectionBinding>,
    /// Absolute path of the open project file — **runtime only**, never written to disk
    /// (derived from Open/Save path). Old files may still contain it; load ignores it.
    #[serde(default, skip_serializing)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub connections: Vec<ConnectionDef>,
    #[serde(default)]
    pub sources: Vec<SourceDef>,
    pub workspace: Workspace,
    /// dbt Core major line (v1/v2). Wire name stays `dbt_target` (alias `dbt_runtime`).
    #[serde(default, alias = "dbt_runtime")]
    pub dbt_target: DbtTarget,
    /// SQL emit / free-SQL dialect owner.
    #[serde(default)]
    pub execution_engine: ExecutionEngine,
    /// Where published outputs materialize.
    #[serde(default)]
    pub destination: Destination,
    /// Query ids published as marts (empty → focus_query_id only, legacy behavior).
    #[serde(default)]
    pub outputs: Vec<String>,
    /// Default materialization for published outputs.
    #[serde(default)]
    pub materialization: Materialization,
    /// Legacy mirror of `execution_engine` — kept for older readers; prefer engine.
    #[serde(default)]
    pub target_dialect: WarehouseDialect,
    /// Legacy: postgres connection when dialect was postgres (folded into destination).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_connection_id: Option<String>,
    #[serde(default)]
    pub last_dbt_export_path: Option<String>,
    /// Visual pipeline editor layout (ADR-0007).
    #[serde(default)]
    pub canvas: Option<CanvasLayout>,
    /// Durable mapping quality checks ([ADR-0027](../../../docs/adr/0027-mapping-quality-checks.md);
    /// typed IR [ADR-0029](../../../docs/adr/0029-typed-wire-contract.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mapping_checks: Vec<MappingCheck>,
    /// CheckRun results ([ADR-0027](../../../docs/adr/0027-mapping-quality-checks.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mapping_check_runs: Vec<CheckRun>,
}

impl Project {
    pub fn to_json_pretty(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| e.to_string())
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let mut v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        migrate_project_document(&mut v)?;
        let mut p: Self = serde_json::from_value(v).map_err(|e| e.to_string())?;
        p.format_version = PROJECT_FORMAT_VERSION;
        // ADR-0035: singular left_attr ↔ left_attrs[] soft-migrate.
        for check in &mut p.mapping_checks {
            check.projection = check.projection.clone().normalize_attrs();
        }
        Ok(p)
    }

    /// Dialect used for SQL emit (= execution engine).
    pub fn emit_dialect(&self) -> WarehouseDialect {
        self.execution_engine.dialect()
    }
}

/// Peek on-disk `format_version` without full migrate (default 0). Used for `.bak` on save.
/// Malformed values are treated as 0 so bak still runs; load path validates strictly.
pub fn peek_format_version(raw: &str) -> u32 {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_object().and_then(|o| read_format_version(o).ok()))
        .unwrap_or(0)
}

/// Only absence → v0. Wrong type / non-integer / out of u32 range → error (ADR-0030).
fn read_format_version(obj: &serde_json::Map<String, Value>) -> Result<u32, String> {
    match obj.get("format_version") {
        None => Ok(0),
        Some(Value::Number(n)) => {
            let Some(u) = n.as_u64() else {
                return Err(
                    "format_version must be a non-negative integer (not float/negative)".into(),
                );
            };
            if u > u32::MAX as u64 {
                return Err(format!("format_version {u} out of range for u32"));
            }
            Ok(u as u32)
        }
        Some(_) => Err("format_version must be a JSON number".into()),
    }
}

/// Ordered document migrations + stamp [`PROJECT_FORMAT_VERSION`] (ADR-0030).
pub fn migrate_project_document(v: &mut Value) -> Result<(), String> {
    let Some(obj) = v.as_object_mut() else {
        return Err("project root must be a JSON object".into());
    };
    let mut ver = read_format_version(obj)?;
    if ver > PROJECT_FORMAT_VERSION {
        return Err(format!(
            "Unsupported project format_version {ver} (this app supports ≤ {PROJECT_FORMAT_VERSION})"
        ));
    }
    while ver < PROJECT_FORMAT_VERSION {
        match ver {
            0 => migrate_v0_to_v1(obj),
            // ADR-0036: query-backed KeyMap storage — stamp only, no row rewrite.
            1 => migrate_v1_to_v2(obj),
            // ADR-0037: multi-output KeyMap fields.
            2 => migrate_v2_to_v3(obj)?,
            other => {
                return Err(format!(
                    "missing migration from format_version {other} → {}",
                    other + 1
                ));
            }
        }
        ver += 1;
    }
    // ADR-0033: always strip warehouse KeyMap row bodies from the document (idempotent).
    strip_source_keymap_entries(obj);
    obj.insert(
        "format_version".into(),
        Value::Number(PROJECT_FORMAT_VERSION.into()),
    );
    Ok(())
}

/// ADR-0033 / ADR-0036 — source + query maps must not keep dictionary rows in project JSON.
fn strip_source_keymap_entries(obj: &mut serde_json::Map<String, Value>) {
    let Some(ws) = obj.get_mut("workspace").and_then(|w| w.as_object_mut()) else {
        return;
    };
    let mut strip_ids = std::collections::HashSet::new();
    if let Some(maps) = ws.get_mut("key_maps").and_then(|m| m.as_array_mut()) {
        for map in maps {
            let Some(m) = map.as_object_mut() else {
                continue;
            };
            let kind = m
                .get("storage")
                .and_then(|s| s.as_object())
                .and_then(|s| s.get("kind"))
                .and_then(|k| k.as_str());
            if matches!(kind, Some("source") | Some("query")) {
                if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                    strip_ids.insert(id.to_string());
                }
                m.insert("entries".into(), Value::Array(vec![]));
            }
        }
    }
    // Also clear embedded ApplyKeyMap snapshots for source/query maps.
    let Some(queries) = ws.get_mut("queries").and_then(|q| q.as_array_mut()) else {
        return;
    };
    for query in queries {
        let Some(steps) = query
            .as_object_mut()
            .and_then(|q| q.get_mut("steps"))
            .and_then(|s| s.as_array_mut())
        else {
            continue;
        };
        for step in steps {
            let Some(s) = step.as_object_mut() else {
                continue;
            };
            if s.get("type").and_then(|t| t.as_str()) != Some("ApplyKeyMap") {
                continue;
            }
            let map_id = s
                .get("map_id")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    s.get("payload")
                        .and_then(|p| p.as_object())
                        .and_then(|p| p.get("map_id"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                });
            let Some(mid) = map_id else { continue };
            if !strip_ids.contains(&mid) {
                continue;
            }
            if let Some(payload) = s.get_mut("payload").and_then(|p| p.as_object_mut()) {
                payload.insert("entries".into(), Value::Array(vec![]));
            } else {
                s.insert("entries".into(), Value::Array(vec![]));
            }
        }
    }
}

/// ADR-0036 — query-backed KeyMap: document gate only (no IR rewrite).
fn migrate_v1_to_v2(_obj: &mut serde_json::Map<String, Value>) {}

/// ADR-0037 — KeyMap multi-output: fold scalar To into output lists; rewrite Apply bindings.
fn migrate_v2_to_v3(obj: &mut serde_json::Map<String, Value>) -> Result<(), String> {
    let Some(ws) = obj.get_mut("workspace").and_then(|w| w.as_object_mut()) else {
        return Ok(());
    };

    // map_id → single output column name after fold (for Apply bindings).
    let mut map_primary_output: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    if let Some(maps) = ws.get_mut("key_maps").and_then(|m| m.as_array_mut()) {
        for map in maps.iter_mut() {
            let Some(m) = map.as_object_mut() else {
                continue;
            };
            let map_id = m
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let primary = fold_keymap_def_outputs(m)?;
            if !map_id.is_empty() {
                map_primary_output.insert(map_id, primary);
            }
            if let Some(entries) = m.get_mut("entries").and_then(|e| e.as_array_mut()) {
                for entry in entries {
                    let Some(e) = entry.as_object_mut() else {
                        continue;
                    };
                    fold_keymap_entry_outputs(e)?;
                }
            }
            fold_authoring_context_targets(m);
        }
    }

    if let Some(queries) = ws.get_mut("queries").and_then(|q| q.as_array_mut()) {
        for query in queries {
            let Some(steps) = query
                .as_object_mut()
                .and_then(|q| q.get_mut("steps"))
                .and_then(|s| s.as_array_mut())
            else {
                continue;
            };
            for step in steps {
                let Some(s) = step.as_object_mut() else {
                    continue;
                };
                // Serde: `{ "type": "ApplyKeyMap", "payload": { … } }`.
                if s.get("type").and_then(|t| t.as_str()) != Some("ApplyKeyMap") {
                    continue;
                }
                let Some(apply) = s.get_mut("payload").and_then(|p| p.as_object_mut()) else {
                    return Err(
                        "migrate v2→v3: ApplyKeyMap step missing payload object".into(),
                    );
                };
                if let Some(entries) = apply.get_mut("entries").and_then(|e| e.as_array_mut()) {
                    for entry in entries {
                        let Some(e) = entry.as_object_mut() else {
                            continue;
                        };
                        fold_keymap_entry_outputs(e)?;
                    }
                }
                fold_apply_keymap_bindings(apply, &map_primary_output)?;
            }
        }
    }
    Ok(())
}

fn json_string_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn fold_keymap_def_outputs(
    m: &mut serde_json::Map<String, Value>,
) -> Result<String, String> {
    let legacy_to = json_string_field(m, "to_column");
    let existing = m
        .get("output_columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let output_columns = if !existing.is_empty() {
        if let Some(ref t) = legacy_to {
            if existing.first().map(String::as_str) != Some(t.as_str()) {
                return Err(format!(
                    "migrate v2→v3: to_column '{t}' disagrees with output_columns[0]={:?}",
                    existing.first()
                ));
            }
        }
        existing
    } else if let Some(t) = legacy_to.clone() {
        vec![t]
    } else {
        vec!["to".to_string()]
    };

    let primary = output_columns
        .first()
        .cloned()
        .ok_or_else(|| "migrate v2→v3: empty output_columns".to_string())?;
    m.insert(
        "output_columns".into(),
        Value::Array(
            output_columns
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    m.remove("to_column");
    let _ = legacy_to;
    Ok(primary)
}

fn fold_keymap_entry_outputs(e: &mut serde_json::Map<String, Value>) -> Result<(), String> {
    let legacy_to = e
        .get("to")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let existing = e
        .get("output_values")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let output_values = if !existing.is_empty() {
        if let Some(ref t) = legacy_to {
            if existing.first().map(String::as_str) != Some(t.as_str()) {
                return Err(format!(
                    "migrate v2→v3: entry to '{t}' disagrees with output_values[0]={:?}",
                    existing.first()
                ));
            }
        }
        existing
    } else if let Some(t) = legacy_to {
        vec![t]
    } else {
        return Err("migrate v2→v3: KeyMapEntry missing to/output_values".into());
    };

    e.insert(
        "output_values".into(),
        Value::Array(output_values.into_iter().map(Value::String).collect()),
    );
    e.remove("to");
    Ok(())
}

fn fold_authoring_context_targets(m: &mut serde_json::Map<String, Value>) {
    let Some(ctx) = m.get_mut("authoring_context").and_then(|c| c.as_object_mut()) else {
        return;
    };
    let existing = ctx
        .get("target_columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !existing.is_empty() {
        ctx.remove("target_column");
        return;
    }
    if let Some(t) = json_string_field(ctx, "target_column") {
        ctx.insert(
            "target_columns".into(),
            Value::Array(vec![Value::String(t)]),
        );
    }
    ctx.remove("target_column");
}

fn fold_apply_keymap_bindings(
    apply: &mut serde_json::Map<String, Value>,
    map_primary_output: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let existing = apply
        .get("output_bindings")
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone())
        .unwrap_or_default();

    let map_id = apply
        .get("map_id")
        .and_then(|m| match m {
            Value::String(s) => Some(s.clone()),
            Value::Object(o) => o.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            _ => None,
        })
        .unwrap_or_default();

    if !existing.is_empty() {
        if let Some(legacy_out) = json_string_field(apply, "output_column") {
            let first_dest = existing
                .first()
                .and_then(|b| b.as_object())
                .and_then(|b| b.get("destination_column"))
                .and_then(|d| d.as_str());
            if first_dest != Some(legacy_out.as_str()) {
                return Err(format!(
                    "migrate v2→v3: ApplyKeyMap output_column '{legacy_out}' disagrees with first binding destination"
                ));
            }
            if let Some(primary) = map_primary_output.get(&map_id) {
                let first_map = existing
                    .first()
                    .and_then(|b| b.as_object())
                    .and_then(|b| b.get("map_column"))
                    .and_then(|d| d.as_str());
                if first_map != Some(primary.as_str()) {
                    return Err(format!(
                        "migrate v2→v3: ApplyKeyMap map_column {:?} disagrees with map '{map_id}' output '{primary}'",
                        first_map
                    ));
                }
            }
        }
        apply.remove("output_column");
        return Ok(());
    }

    if map_id.is_empty() || !map_primary_output.contains_key(&map_id) {
        return Err(format!(
            "migrate v2→v3: ApplyKeyMap map_id '{map_id}' not found in document (cannot invent map_column)"
        ));
    }
    let map_column = map_primary_output
        .get(&map_id)
        .cloned()
        .expect("checked contains");

    let dest = json_string_field(apply, "output_column").or_else(|| {
        // fact columns: columns[] or column
        let cols = apply
            .get("columns")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !cols.is_empty() {
            return cols.into_iter().next();
        }
        json_string_field(apply, "column")
    });
    let Some(destination_column) = dest else {
        return Err(format!(
            "migrate v2→v3: ApplyKeyMap for map '{map_id}' has no output_column/columns to bind"
        ));
    };

    apply.insert(
        "output_bindings".into(),
        Value::Array(vec![Value::Object({
            let mut b = serde_json::Map::new();
            b.insert("map_column".into(), Value::String(map_column));
            b.insert(
                "destination_column".into(),
                Value::String(destination_column),
            );
            b
        })]),
    );
    apply.remove("output_column");
    Ok(())
}

/// Soft-migrate legacy fields (engine/destination). Prefer [`migrate_project_document`].
pub fn migrate_project_value(v: &mut Value) {
    let _ = migrate_project_document(v);
}

fn migrate_v0_to_v1(obj: &mut serde_json::Map<String, Value>) {
    let legacy_dialect = obj
        .get("target_dialect")
        .and_then(|x| x.as_str())
        .unwrap_or("duckdb")
        .to_string();

    if !obj.contains_key("execution_engine") {
        obj.insert(
            "execution_engine".into(),
            Value::String(legacy_dialect.clone()),
        );
    }

    let engine = obj
        .get("execution_engine")
        .and_then(|x| x.as_str())
        .unwrap_or(legacy_dialect.as_str())
        .to_string();

    if !obj.contains_key("destination") {
        let conn = obj
            .get("target_connection_id")
            .cloned()
            .filter(|c| !c.is_null());
        let dest = if engine == "postgres" || legacy_dialect == "postgres" {
            let mut d = serde_json::Map::new();
            d.insert("kind".into(), Value::String("postgres".into()));
            if let Some(c) = conn {
                d.insert("connection_id".into(), c);
            }
            Value::Object(d)
        } else {
            serde_json::json!({
                "kind": "duckdb",
                "duckdb_path": "local.duckdb"
            })
        };
        obj.insert("destination".into(), dest);
    }

    // Keep target_dialect in sync with engine for older tooling.
    if let Some(eng) = obj.get("execution_engine").cloned() {
        obj.insert("target_dialect".into(), eng);
    }

    // Fold connection into destination if missing there.
    let fold_conn = obj.get("target_connection_id").cloned();
    if let Some(dest) = obj.get_mut("destination").and_then(|d| d.as_object_mut()) {
        if dest.get("kind").and_then(|k| k.as_str()) == Some("postgres")
            && dest.get("connection_id").is_none()
        {
            if let Some(c) = fold_conn {
                if !c.is_null() {
                    dest.insert("connection_id".into(), c);
                }
            }
        }
    }

    if !obj.contains_key("outputs") {
        obj.insert("outputs".into(), Value::Array(vec![]));
    }
    if !obj.contains_key("materialization") {
        obj.insert("materialization".into(), Value::String("table".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionDef, ConnectionKind, PostgresParams};
    use crate::destination::DestinationKind;
    use crate::model::{QueryDef, TransformationStep, Workspace};

    #[test]
    fn project_json_roundtrip() {
        let p = Project {
            format_version: PROJECT_FORMAT_VERSION,
            id: "proj_1".into(),
            name: "demo".into(),
            project_uid: String::new(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![ConnectionDef {
                id: "conn_pg".into(),
                name: "local".into(),
                kind: ConnectionKind::Postgres,
                postgres: Some(PostgresParams {
                    connection_string: "postgresql://u:p@localhost/db".into(),
                }),
                s3: None,
                duckdb: None,
            }],
            sources: vec![],
            workspace: Workspace {
                queries: vec![QueryDef {
                    id: "q1".into(),
                    name: "q1".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "/tmp/a.csv".into(),
                    }],
                    execution: Default::default(),
                }],
                focus_query_id: "q1".into(),
                key_maps: vec![],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: ExecutionEngine::Duckdb,
            destination: Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: Some(CanvasLayout {
                positions: [("q1".into(), CanvasPosition { x: 12.0, y: 34.0 })]
                    .into_iter()
                    .collect(),
            }),
            mapping_checks: vec![],
            mapping_check_runs: vec![],
        };
        let json = p.to_json_pretty().unwrap();
        let back = Project::from_json(&json).unwrap();
        assert_eq!(back.name, "demo");
        assert_eq!(back.execution_engine, ExecutionEngine::Duckdb);
        assert_eq!(back.destination.kind, DestinationKind::Duckdb);
    }

    #[test]
    fn legacy_postgres_target_migrates_without_sql_change() {
        let legacy = r#"{
            "id": "p",
            "name": "pg_only",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [{
                    "id": "q1",
                    "name": "q1",
                    "steps": [{
                        "type": "LoadPostgres",
                        "payload": {
                            "connection_string": "postgresql://u:p@localhost/db",
                            "schema": "public",
                            "table_name": "t"
                        }
                    }],
                    "execution": "local"
                }],
                "focus_query_id": "q1",
                "key_maps": []
            },
            "dbt_target": "v1",
            "target_dialect": "postgres",
            "target_connection_id": "conn_pg"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.execution_engine, ExecutionEngine::Postgres);
        assert_eq!(p.destination.kind, DestinationKind::Postgres);
        assert_eq!(p.destination.connection_id.as_deref(), Some("conn_pg"));
        assert_eq!(p.emit_dialect(), WarehouseDialect::Postgres);
        // Remains readable as postgres target for old helpers.
        assert_eq!(p.target_dialect, WarehouseDialect::Postgres);
    }

    #[test]
    fn mapping_check_ir_round_trips_on_project() {
        use crate::mapping_check::{
            CheckComparability, CheckRun, MappingCheck, MappingCheckProjection,
        };
        let mut p = Project {
            format_version: PROJECT_FORMAT_VERSION,
            id: "p".into(),
            name: "checks".into(),
            project_uid: String::new(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![],
            sources: vec![],
            workspace: Workspace {
                queries: vec![],
                focus_query_id: String::new(),
                key_maps: vec![],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: ExecutionEngine::Duckdb,
            destination: Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
            mapping_checks: vec![MappingCheck {
                id: "check_lab_quality".into(),
                name: "Lab".into(),
                map_id: "map_lab".into(),
                input_refs: vec!["q1".into()],
                group_attributes: vec![],
                cohort_predicate: String::new(),
                projection: MappingCheckProjection::LabV1,
                allow_decisions: vec![],
            }],
            mapping_check_runs: vec![CheckRun {
                id: "run_1".into(),
                check_id: "check_lab_quality".into(),
                ran_at: "2026-11-03T00:00:00Z".into(),
                map_revision: "abc".into(),
                input_revisions: vec![],
                check_definition_revision: "def".into(),
                total_positions: 1,
                cells: vec![],
                comparability: CheckComparability::Full,
                cells_incomplete: false,
                group_count: None,
                covered_positions: None,
                unmapped_positions: None,
            }],
        };
        let json = p.to_json_pretty().unwrap();
        assert!(json.contains("\"kind\": \"lab_v1\""));
        let back = Project::from_json(&json).unwrap();
        assert_eq!(back.mapping_checks.len(), 1);
        assert_eq!(back.mapping_check_runs[0].comparability, CheckComparability::Full);
        p.mapping_checks[0].projection = MappingCheckProjection::Attrs {
            host_query_id: "q1".into(),
            left_attr: "a".into(),
            right_attr: "b".into(),
            sample_column: "id".into(),
            left_attrs: vec!["a".into()],
            right_attrs: vec!["b".into()],
            sample_columns: vec!["id".into()],
        };
        let back2 = Project::from_json(&p.to_json_pretty().unwrap()).unwrap();
        assert!(matches!(
            back2.mapping_checks[0].projection,
            MappingCheckProjection::Attrs { .. }
        ));
    }

    #[test]
    fn mapping_check_malformed_rejected() {
        let bad = r#"{
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "mapping_checks": [{ "id": "c1", "name": "x" }]
        }"#;
        assert!(Project::from_json(bad).is_err());
    }

    #[test]
    fn format_version_stamped_on_legacy_load() {
        let legacy = r#"{
            "id": "p",
            "name": "legacy",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "target_dialect": "duckdb"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.format_version, PROJECT_FORMAT_VERSION);
        assert!(p
            .to_json_pretty()
            .unwrap()
            .contains(&format!("\"format_version\": {PROJECT_FORMAT_VERSION}")));
    }

    #[test]
    fn v1_stamps_to_current_without_row_rewrite() {
        let v1 = r#"{
            "format_version": 1,
            "id": "p",
            "name": "v1",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1"
        }"#;
        let p = Project::from_json(v1).unwrap();
        assert_eq!(p.format_version, PROJECT_FORMAT_VERSION);
    }

    #[test]
    fn v2_keymap_folds_to_multi_output_fields() {
        let v2 = r#"{
            "format_version": 2,
            "id": "p",
            "name": "v2",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [{
                    "id": "q1",
                    "name": "q1",
                    "steps": [{
                        "type": "ApplyKeyMap",
                        "payload": {
                            "column": "sku",
                            "columns": [],
                            "output_column": "sku",
                            "map_id": "map_sku",
                            "entries": [{"from": "A", "to": "1"}]
                        }
                    }],
                    "execution": "local"
                }],
                "focus_query_id": "q1",
                "key_maps": [{
                    "id": "map_sku",
                    "name": "sku",
                    "from_column": "from",
                    "to_column": "to",
                    "entries": [{"from": "A", "to": "1"}],
                    "storage": {"kind": "seed"},
                    "authoring_context": {
                        "source_query_id": "src",
                        "source_columns": ["sku"],
                        "target_query_id": "tgt",
                        "target_column": "product_id"
                    }
                }]
            },
            "dbt_target": "v1"
        }"#;
        let p = Project::from_json(v2).unwrap();
        assert_eq!(p.format_version, 3);
        let map = &p.workspace.key_maps[0];
        assert_eq!(map.output_columns_eff(), vec!["to".to_string()]);
        assert!(map.to_column.is_empty());
        assert_eq!(map.entries[0].output_values_eff(), vec!["1".to_string()]);
        assert!(map.entries[0].to.is_empty());
        let ctx = map.authoring_context.as_ref().unwrap();
        assert_eq!(ctx.target_columns_eff(), vec!["product_id".to_string()]);
        assert!(ctx.target_column.is_empty());
        match &p.workspace.queries[0].steps[0] {
            TransformationStep::ApplyKeyMap {
                output_bindings,
                output_column,
                entries,
                ..
            } => {
                assert!(output_column.is_none());
                assert_eq!(output_bindings.len(), 1);
                assert_eq!(output_bindings[0].map_column, "to");
                assert_eq!(output_bindings[0].destination_column, "sku");
                assert_eq!(entries[0].output_values_eff(), vec!["1".to_string()]);
            }
            other => panic!("expected ApplyKeyMap, got {other:?}"),
        }
    }

    #[test]
    fn v2_apply_missing_map_refuses() {
        let v2 = r#"{
            "format_version": 2,
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [{
                    "id": "q1",
                    "name": "q1",
                    "steps": [{
                        "type": "ApplyKeyMap",
                        "payload": {
                            "column": "sku",
                            "map_id": "missing_map",
                            "entries": []
                        }
                    }],
                    "execution": "local"
                }],
                "focus_query_id": "q1",
                "key_maps": []
            },
            "dbt_target": "v1"
        }"#;
        let err = Project::from_json(v2).unwrap_err();
        assert!(
            err.contains("not found") || err.contains("cannot invent"),
            "{err}"
        );
    }

    #[test]
    fn newer_format_version_refused() {
        let future = format!(
            r#"{{
            "format_version": {},
            "id": "p",
            "name": "future",
            "connections": [],
            "sources": [],
            "workspace": {{ "queries": [], "focus_query_id": "", "key_maps": [] }},
            "dbt_target": "v1"
        }}"#,
            PROJECT_FORMAT_VERSION + 1
        );
        let err = Project::from_json(&future).unwrap_err();
        assert!(
            err.contains("Unsupported project format_version"),
            "err={err}"
        );
    }

    #[test]
    fn peek_format_version_defaults_to_zero() {
        assert_eq!(peek_format_version(r#"{"id":"p"}"#), 0);
        assert_eq!(peek_format_version(r#"{"format_version":1}"#), 1);
    }

    #[test]
    fn format_version_string_refused() {
        let raw = r#"{
            "format_version": "2",
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1"
        }"#;
        let err = Project::from_json(raw).unwrap_err();
        assert!(
            err.contains("format_version must be a JSON number"),
            "err={err}"
        );
    }

    #[test]
    fn format_version_out_of_u32_refused() {
        let raw = r#"{
            "format_version": 4294967297,
            "id": "p",
            "name": "bad",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1"
        }"#;
        let err = Project::from_json(raw).unwrap_err();
        assert!(err.contains("out of range"), "err={err}");
    }

    #[test]
    fn source_keymap_entries_stripped_on_load() {
        let raw = r#"{
            "format_version": 1,
            "id": "p",
            "name": "src_map",
            "connections": [],
            "sources": [],
            "workspace": {
                "queries": [],
                "focus_query_id": "",
                "key_maps": [{
                    "id": "map_wh",
                    "name": "WH",
                    "from_column": "from",
                    "to_column": "to",
                    "entries": [{"from": "a", "to": "1"}],
                    "storage": {
                        "kind": "source",
                        "connection_id": "c1",
                        "source": "public",
                        "table": "aliases"
                    }
                }]
            },
            "dbt_target": "v1"
        }"#;
        let p = Project::from_json(raw).unwrap();
        assert!(p.workspace.key_maps[0].entries.is_empty());
    }

    #[test]
    fn legacy_duckdb_target_migrates() {
        let legacy = r#"{
            "id": "p",
            "name": "files",
            "connections": [],
            "sources": [],
            "workspace": { "queries": [], "focus_query_id": "", "key_maps": [] },
            "dbt_target": "v1",
            "target_dialect": "duckdb"
        }"#;
        let p = Project::from_json(legacy).unwrap();
        assert_eq!(p.execution_engine, ExecutionEngine::Duckdb);
        assert_eq!(p.destination.kind, DestinationKind::Duckdb);
    }
}
