//! Fresh, SQL-bounded Advanced inputs. Deliberately outside the pure matcher.
use crate::{
    compile_ctes_for_execution, DbSession, MatchingPlan, MatchingRunMode, MatchingScopeKind,
    MatchingSourceRow, MatchingTargetRow, LOCAL_TARGET_UNIVERSE_ROWS, MASS_RUN_UNIQUE_KEYS,
    TRIAL_UNIQUE_KEYS,
};
use dwh_pipeline::{
    cte_name, escape_sql_string, quote_ident, ConnectionDef, SourceDef, TransformationStep,
    Workspace,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingJoinScope {
    Unmatched,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchingJoinTarget {
    pub target_id: String,
    pub identity_values: Vec<String>,
    pub fields: HashMap<String, String>,
    pub output_values: Vec<String>,
    pub occurrences: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchingJoinAcquisition {
    pub query_id: String,
    pub join_index: usize,
    pub right_query_id: String,
    pub scope: MatchingJoinScope,
    pub source_fields: Vec<String>,
    pub target_fields: Vec<String>,
    pub source_rows: Vec<MatchingSourceRow>,
    pub target_rows: Vec<MatchingJoinTarget>,
    pub source_key_cap: usize,
    pub target_row_cap: usize,
    pub target_occurrences: usize,
    // Success means the complete explicitly requested scope fits; excess is refused.
    pub complete: bool,
}

impl MatchingJoinAcquisition {
    pub fn retrieval_targets(&self) -> Vec<MatchingTargetRow> {
        self.target_rows
            .iter()
            .map(|r| MatchingTargetRow {
                target_id: r.target_id.clone(),
                fields: r.fields.clone(),
                output_values: r.output_values.clone(),
            })
            .collect()
    }
}

fn query_rows(
    db: &DbSession,
    sql: &str,
    width: usize,
    counted: bool,
) -> Result<Vec<(Vec<String>, u32)>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| format!("Advanced fields unavailable: {e}"))?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut values = Vec::new();
            for i in 0..width {
                let value: Option<String> = row.get(i).map_err(|e| e.to_string())?;
                values.push(value.ok_or_else(|| "refused: NULL in selected Advanced fields; string-only contextual inputs cannot represent NULL".to_string())?);
            }
            let count = if counted {
                let n: i64 = row.get(width).map_err(|e| e.to_string())?;
                u32::try_from(n).map_err(|_| "refused: source occurrence count exceeds u32".to_string())?
            } else { 1 };
            out.push((values, count));
        }
        Ok(out)
    })
}

/// No preview sampling and no prepared TEMP reuse: verification must read again.
#[allow(clippy::too_many_arguments)]
pub fn acquire_matching_join(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[SourceDef],
    query_id: &str,
    join_index: usize,
    plan: &MatchingPlan,
    mode: MatchingRunMode,
    scope: MatchingJoinScope,
    source_parts: Option<&[String]>,
) -> Result<MatchingJoinAcquisition, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let host = resolved
        .query(query_id)
        .ok_or("missing original JOIN query")?;
    let Some(TransformationStep::Join {
        right_query_id,
        left_on,
        right_on,
        ..
    }) = host.steps.get(join_index)
    else {
        return Err("original step is not a JOIN".into());
    };
    let right_id = right_query_id.compiler_id()?;
    if join_index == 0
        || left_on.is_empty()
        || left_on.len() != right_on.len()
        || plan.map_key_fields != *left_on
        || plan.outputs != *right_on
        || plan.target_ref != right_id
        || plan.target_identity_fields.is_empty()
        || plan.semantic_revision == 0
    {
        return Err(
            "refused: Advanced plan must retain original ordered JOIN keys/outputs and target"
                .into(),
        );
    }
    // sourceRef is guidance only, never authority to bypass the original prefix.
    match (plan.scope, source_parts) {
        (MatchingScopeKind::Full, None) => {},
        (MatchingScopeKind::Selected, Some(parts)) if parts.len() == left_on.len() => {},
        _ => return Err("refused: unsupported scope; use full or selected with exact sourceParts (cohort is unavailable)".into()),
    }
    let right = resolved
        .query(right_id)
        .ok_or("missing consumed right query")?;
    if right.steps.is_empty() {
        return Err("empty consumed right query".into());
    }
    // Reuse join_prepare's exact pre-JOIN truncation, not nearest FromQuery.
    let left_ws = crate::join_prepare::left_prefix_workspace(&resolved, query_id, join_index)?;
    let lc = compile_ctes_for_execution(db, &left_ws, connections, sources, query_id)?;
    let rc = compile_ctes_for_execution(db, &resolved, connections, sources, right_id)?;
    let left_sql = format!(
        "WITH {} SELECT * FROM {}",
        lc.definitions,
        cte_name(query_id, join_index - 1)
    );
    let right_sql = format!(
        "WITH {} SELECT * FROM {}",
        rc.definitions,
        cte_name(right_id, right.steps.len() - 1)
    );
    let source_fields: Vec<_> = plan
        .map_key_fields
        .iter()
        .cloned()
        .chain(plan.comparisons.iter().map(|c| c.source_field.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let target_fields: Vec<_> = plan
        .outputs
        .iter()
        .chain(plan.target_identity_fields.iter())
        .cloned()
        .chain(plan.comparisons.iter().map(|c| c.target_field.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let projection = |fields: &[String]| {
        fields
            .iter()
            .map(|f| {
                format!(
                    "CAST(l.{} AS VARCHAR) AS {}",
                    quote_ident(f),
                    quote_ident(f)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let target_sql = format!(
        "SELECT {} FROM ({right_sql}) l LIMIT {}",
        projection(&target_fields),
        LOCAL_TARGET_UNIVERSE_ROWS + 1
    );
    let raw_targets = query_rows(db, &target_sql, target_fields.len(), false)?;
    if raw_targets.len() > LOCAL_TARGET_UNIVERSE_ROWS {
        return Err(format!("refused: target exceeds local cap {LOCAL_TARGET_UNIVERSE_ROWS}; reduce scope or use server-side retrieval"));
    }
    let target_occurrences = raw_targets.len();
    let mut target_rows: Vec<MatchingJoinTarget> = Vec::new();
    let mut identities = HashMap::new();
    for (values, _) in raw_targets {
        let fields: HashMap<_, _> = target_fields.iter().cloned().zip(values).collect();
        let identity_values: Vec<_> = plan
            .target_identity_fields
            .iter()
            .map(|f| fields[f].clone())
            .collect();
        let target_id = serde_json::to_string(&identity_values).map_err(|e| e.to_string())?;
        let output_values = plan.outputs.iter().map(|f| fields[f].clone()).collect();
        if let Some(&index) = identities.get(&target_id) {
            let old: &mut MatchingJoinTarget = &mut target_rows[index];
            if old.fields != fields {
                return Err(
                    "refused: target identity collision with differing selected fields/outputs"
                        .into(),
                );
            }
            old.occurrences += 1;
        } else {
            identities.insert(target_id.clone(), target_rows.len());
            target_rows.push(MatchingJoinTarget {
                target_id,
                identity_values,
                fields,
                output_values,
                occurrences: 1,
            });
        }
    }
    target_rows.sort_by(|a, b| a.target_id.cmp(&b.target_id));
    let mut predicates = Vec::new();
    if scope == MatchingJoinScope::Unmatched {
        let on = left_on
            .iter()
            .zip(right_on)
            .map(|(l, r)| format!("l.{} = r.{}", quote_ident(l), quote_ident(r)))
            .collect::<Vec<_>>()
            .join(" AND ");
        predicates.push(format!(
            "NOT EXISTS (SELECT 1 FROM ({right_sql}) r WHERE {on})"
        ));
    }
    if let Some(parts) = source_parts {
        predicates.extend(left_on.iter().zip(parts).map(|(f, v)| {
            format!(
                "CAST(l.{} AS VARCHAR) = '{}'",
                quote_ident(f),
                escape_sql_string(v)
            )
        }));
    }
    let filter = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" AND "))
    };
    let cap = match mode {
        MatchingRunMode::Trial => TRIAL_UNIQUE_KEYS,
        MatchingRunMode::Mass => MASS_RUN_UNIQUE_KEYS,
    };
    let group = (1..=source_fields.len())
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {}, COUNT(*) FROM ({left_sql}) l {filter} GROUP BY {group} ORDER BY {group} LIMIT {}", projection(&source_fields), cap + 1);
    let rows = query_rows(db, &sql, source_fields.len(), true)?;
    if rows.len() > cap {
        return Err(format!(
            "refused: source key/context groups exceed {cap}; narrow scope or use mass mode"
        ));
    }
    let mut source_rows = Vec::new();
    let mut keys = BTreeSet::new();
    for (values, affected_source_rows) in rows {
        let fields: HashMap<_, _> = source_fields.iter().cloned().zip(values).collect();
        let map_key: Vec<_> = plan
            .map_key_fields
            .iter()
            .map(|f| fields[f].clone())
            .collect();
        if !keys.insert(map_key.clone()) {
            return Err("refused: conflicting source context for the same exact map key".into());
        }
        source_rows.push(MatchingSourceRow {
            map_key,
            fields,
            affected_source_rows,
        });
    }
    Ok(MatchingJoinAcquisition {
        query_id: query_id.into(),
        join_index,
        right_query_id: right_id.into(),
        scope,
        source_fields,
        target_fields,
        source_rows,
        target_rows,
        source_key_cap: cap,
        target_row_cap: LOCAL_TARGET_UNIVERSE_ROWS,
        target_occurrences,
        complete: true,
    })
}
