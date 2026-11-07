//! Postgres schema import commands (ADR-0040). Catalog reads stay separate from the project fold.

use crate::error::RpcError;
use dwh_engine::{diagnose_mapping_relation, scan_postgres_import, DbSession};
use dwh_pipeline::pg_import::{
    adopt_fresh_write_metadata, default_prefixes, metadata_matches, rule_matches,
    MappingKeyDiagnosis, PgImportOutcome,
    PgImportPlan, PgRelationSnapshot,
};
use dwh_pipeline::{commit_pg_import, import_fingerprint, Project};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectArgs {
    project: Project,
}

#[derive(Deserialize)]
struct RelName {
    schema: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanArgs {
    connection_string: String,
    relations: Vec<RelName>,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    rule_schemas: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitArgs {
    project: Project,
    plan: PgImportPlan,
    #[serde(default)]
    connection_string: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnoseArgs {
    connection_string: String,
    schema: String,
    table: String,
    from_columns: Vec<String>,
    output_columns: Vec<String>,
    #[serde(default)]
    valid_from: Option<String>,
    #[serde(default)]
    valid_to: Option<String>,
}

#[derive(Serialize)]
struct ScanHit {
    #[serde(flatten)]
    snapshot: PgRelationSnapshot,
    rule_match: bool,
    schema_fingerprint: String,
}

pub fn pg_import_fingerprint(args: Value) -> Result<Value, RpcError> {
    let a: ProjectArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
    Ok(json!({ "fingerprint": import_fingerprint(&a.project) }))
}

pub fn scan_pg_import(db: &DbSession, args: Value) -> Result<Value, RpcError> {
    let a: ScanArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
    let pairs: Vec<(String, String)> = a
        .relations
        .into_iter()
        .map(|r| (r.schema, r.name))
        .collect();
    let snaps = scan_postgres_import(db, &a.connection_string, &pairs)?;
    let prefixes = if a.prefixes.is_empty() {
        default_prefixes()
    } else {
        a.prefixes
    };
    let hits: Vec<ScanHit> = snaps
        .into_iter()
        .map(|snapshot| {
            let rule_match = rule_matches(
                &snapshot.name,
                &snapshot.schema,
                &prefixes,
                &a.rule_schemas,
            );
            let schema_fingerprint = snapshot.fingerprint();
            ScanHit {
                snapshot,
                rule_match,
                schema_fingerprint,
            }
        })
        .collect();
    serde_json::to_value(hits).map_err(|e| RpcError::from(e.to_string()))
}

pub fn diagnose_pg_import(db: &DbSession, args: Value) -> Result<Value, RpcError> {
    let a: DiagnoseArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
    let out: MappingKeyDiagnosis = diagnose_mapping_relation(
        db,
        &a.connection_string,
        &a.schema,
        &a.table,
        &a.from_columns,
        &a.output_columns,
        a.valid_from.as_deref(),
        a.valid_to.as_deref(),
    )?;
    serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
}

pub fn commit_pg_import_cmd(db: &DbSession, args: Value) -> Result<Value, RpcError> {
    let a: CommitArgs = serde_json::from_value(args).map_err(|e| RpcError::from(e.to_string()))?;
    let present: Vec<(String, String)> = a
        .plan
        .relations
        .iter()
        .filter(|r| r.present)
        .map(|r| (r.schema.clone(), r.name.clone()))
        .collect();
    if !present.is_empty() {
        let dsn = a
            .connection_string
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                RpcError::from("connection string is required to recheck metadata".to_string())
            })?;
        let fresh = scan_postgres_import(db, dsn, &present)?;
        metadata_matches(&a.plan, &fresh)?;
        let mut plan = a.plan;
        adopt_fresh_write_metadata(&mut plan, &fresh);
        let out: PgImportOutcome = commit_pg_import(&a.project, &plan)?;
        return serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()));
    }
    let out: PgImportOutcome = commit_pg_import(&a.project, &a.plan)?;
    serde_json::to_value(out).map_err(|e| RpcError::from(e.to_string()))
}
