//! Per-step result column schema (ADR-0018).
//!
//! Derived from Workspace AST + optional Load* seed metadata — not a second editable truth.
//! Propagation needs **explicit output names**; raw expressions / unknown aliases → [`None`].

use crate::emit::{ascii_fold_name, union_column_names, validate_unambiguous_ascii_names};
use crate::graph::topo_queries;
use crate::model::{apply_keymap_columns, TransformationStep, Workspace};
use std::collections::HashMap;

/// Ordered column names after a step, or unknown.
pub type StepSchema = Option<Vec<String>>;

/// Inferred schemas for a workspace (topo order).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceSchemas {
    /// After each step: `steps[query_id][i]` = schema leaving step `i`.
    pub steps: HashMap<String, Vec<StepSchema>>,
    /// Final output of each query (`steps[qid].last()`).
    pub query_out: HashMap<String, StepSchema>,
}

impl WorkspaceSchemas {
    pub fn step(&self, query_id: &str, idx: usize) -> StepSchema {
        self.steps
            .get(query_id)
            .and_then(|v| v.get(idx).cloned())
            .unwrap_or(None)
    }

    pub fn query_final(&self, query_id: &str) -> StepSchema {
        self.query_out.get(query_id).cloned().unwrap_or(None)
    }
}

/// `load_seeds`: optional column lists for queries whose first step is `Load*` (from catalog/describe).
/// Key = query id. Absent → that Load yields unknown schema.
pub fn infer_workspace_schemas(
    workspace: &Workspace,
    load_seeds: &HashMap<String, Vec<String>>,
) -> Result<WorkspaceSchemas, String> {
    infer_workspace_schemas_ex(workspace, load_seeds, &HashMap::new())
}

/// Like [`infer_workspace_schemas`], plus live-described SqlModel column lists (engine preview).
pub fn infer_workspace_schemas_ex(
    workspace: &Workspace,
    load_seeds: &HashMap<String, Vec<String>>,
    sql_model_schemas: &HashMap<String, Vec<String>>,
) -> Result<WorkspaceSchemas, String> {
    let order = topo_queries(workspace)?;
    let mut out = WorkspaceSchemas::default();

    for qid in order {
        let query = workspace
            .query(&qid)
            .ok_or_else(|| format!("missing query {qid}"))?;
        let mut step_schemas = Vec::with_capacity(query.steps.len());
        let mut prev: StepSchema = None;

        for (idx, step) in query.steps.iter().enumerate() {
            let next = apply_step_schema_ex(
                step,
                prev.as_deref(),
                &out.query_out,
                load_seeds,
                sql_model_schemas,
                &qid,
                idx,
            )?;
            step_schemas.push(next.clone());
            prev = next;
        }

        out.query_out.insert(qid.clone(), prev);
        out.steps.insert(qid, step_schemas);
    }

    Ok(out)
}

/// Schema leaving `step` given previous schema and already-finished query outputs.
pub fn apply_step_schema(
    step: &TransformationStep,
    prev: Option<&[String]>,
    query_out: &HashMap<String, StepSchema>,
    load_seeds: &HashMap<String, Vec<String>>,
    query_id: &str,
    step_idx: usize,
) -> Result<StepSchema, String> {
    apply_step_schema_ex(
        step,
        prev,
        query_out,
        load_seeds,
        &HashMap::new(),
        query_id,
        step_idx,
    )
}

fn apply_step_schema_ex(
    step: &TransformationStep,
    prev: Option<&[String]>,
    query_out: &HashMap<String, StepSchema>,
    load_seeds: &HashMap<String, Vec<String>>,
    sql_model_schemas: &HashMap<String, Vec<String>>,
    query_id: &str,
    step_idx: usize,
) -> Result<StepSchema, String> {
    match step {
        TransformationStep::LoadCsv { .. }
        | TransformationStep::LoadParquet { .. }
        | TransformationStep::LoadPostgres { .. }
        | TransformationStep::LoadDuckdb { .. } => {
            if step_idx != 0 {
                return Err(format!(
                    "query '{query_id}': Load* must be the first step (got index {step_idx})"
                ));
            }
            Ok(load_seeds.get(query_id).map(|c| c.clone()))
        }
        TransformationStep::FromQuery { query_id: dep } => {
            if step_idx != 0 {
                return Err(format!(
                    "query '{query_id}': FromQuery must be the first step"
                ));
            }
            Ok(query_out.get(dep).cloned().unwrap_or(None))
        }
        TransformationStep::SqlModel { .. } => {
            Ok(sql_model_schemas.get(query_id).cloned())
        }
        TransformationStep::Filter { .. }
        | TransformationStep::SortBy { .. }
        | TransformationStep::Limit { .. }
        | TransformationStep::NormalizeKey { .. } => Ok(prev.map(|p| p.to_vec())),
        TransformationStep::ApplyKeyMap {
            column,
            columns,
            output_column,
            ..
        } => {
            // ADR-0024: new output_column is appended; overwrite keeps the same list.
            let Some(cols) = prev else {
                return Ok(None);
            };
            let fact = apply_keymap_columns(column, columns);
            let out = output_column
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| fact.first().map(|s| s.as_str()))
                .unwrap_or("");
            if out.is_empty() {
                return Ok(Some(cols.to_vec()));
            }
            let fold = ascii_fold_name(out);
            if cols.iter().any(|c| ascii_fold_name(c) == fold) {
                Ok(Some(cols.to_vec()))
            } else {
                let mut next = cols.to_vec();
                next.push(out.to_string());
                Ok(Some(next))
            }
        }
        TransformationStep::SelectColumns { columns } => {
            if columns.is_empty() {
                return Err("SelectColumns: empty columns".into());
            }
            validate_unambiguous_ascii_names(columns, "SelectColumns")?;
            Ok(Some(columns.clone()))
        }
        TransformationStep::RenameColumn { from, to } => {
            let Some(cols) = prev else {
                return Ok(None);
            };
            let mut next = cols.to_vec();
            let fold_from = ascii_fold_name(from);
            let mut found = false;
            for c in &mut next {
                if ascii_fold_name(c) == fold_from {
                    if found {
                        return Err(format!(
                            "RenameColumn: ambiguous match for '{from}' in prior schema"
                        ));
                    }
                    *c = to.clone();
                    found = true;
                }
            }
            if !found {
                return Err(format!(
                    "RenameColumn: column '{from}' not in prior schema {:?}",
                    cols
                ));
            }
            validate_unambiguous_ascii_names(&next, "RenameColumn")?;
            Ok(Some(next))
        }
        TransformationStep::DeriveColumn { name, .. } => {
            let Some(cols) = prev else {
                return Ok(None);
            };
            let mut next = cols.to_vec();
            next.push(name.clone());
            validate_unambiguous_ascii_names(&next, "DeriveColumn")?;
            Ok(Some(next))
        }
        TransformationStep::GroupBy { .. } => {
            // Aggregates are raw SQL without guaranteed aliases → unknown (ADR-0018).
            Ok(None)
        }
        TransformationStep::CustomSql { .. } => Ok(None),
        TransformationStep::Join {
            right_query_id,
            left_on,
            right_on,
            ..
        } => {
            let Some(left) = prev else {
                return Ok(None);
            };
            let Some(Some(right)) = query_out.get(right_query_id).map(|s| s.as_ref()) else {
                return Ok(None);
            };
            join_result_schema(left, right, left_on, right_on)
        }
        TransformationStep::Append { other_query_ids } => {
            let Some(left) = prev else {
                return Ok(None);
            };
            let mut sources: Vec<&[String]> = vec![left];
            let mut owned: Vec<Vec<String>> = Vec::new();
            for oid in other_query_ids {
                match query_out.get(oid) {
                    Some(Some(cols)) => {
                        owned.push(cols.clone());
                    }
                    _ => return Ok(None),
                }
            }
            for c in &owned {
                sources.push(c.as_slice());
            }
            Ok(Some(union_column_names(&sources)?))
        }
    }
}

fn join_result_schema(
    left: &[String],
    right: &[String],
    left_on: &[String],
    right_on: &[String],
) -> Result<StepSchema, String> {
    validate_unambiguous_ascii_names(left, "Join left")?;
    validate_unambiguous_ascii_names(right, "Join right")?;
    if left_on.is_empty() || left_on.len() != right_on.len() {
        return Err("Join: left_on/right_on must be non-empty and same length".into());
    }

    // USING-style when key names match: left wins; drop right key cols.
    // Unequal keys: left + right columns whose fold is not a right_on key
    // (preview renames right keys onto left names — those already on left).
    let drop_right: Vec<String> = right_on.iter().map(|c| ascii_fold_name(c)).collect();
    let mut left_folds: std::collections::HashSet<String> =
        left.iter().map(|c| ascii_fold_name(c)).collect();

    let mut out = left.to_vec();
    for c in right {
        let f = ascii_fold_name(c);
        if drop_right.contains(&f) {
            continue;
        }
        if left_folds.contains(&f) {
            // Name clash on non-key: keep left only (matches dbt left-wins merge intent).
            continue;
        }
        out.push(c.clone());
        left_folds.insert(f);
    }
    validate_unambiguous_ascii_names(&out, "Join result")?;
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::QueryDef;

    fn q(id: &str, steps: Vec<TransformationStep>) -> QueryDef {
        QueryDef {
            id: id.into(),
            name: id.into(),
            steps,
            execution: Default::default(),
        }
    }

    #[test]
    fn select_rename_append_known_chain() {
        let ws = Workspace {
            queries: vec![
                q(
                    "eu",
                    vec![TransformationStep::LoadCsv {
                        path: "eu.csv".into(),
                    }],
                ),
                q(
                    "us",
                    vec![TransformationStep::LoadCsv {
                        path: "us.csv".into(),
                    }],
                ),
                q(
                    "all",
                    vec![
                        TransformationStep::FromQuery {
                            query_id: "eu".into(),
                        },
                        TransformationStep::RenameColumn {
                            from: "amt".into(),
                            to: "amount".into(),
                        },
                        TransformationStep::Append {
                            other_query_ids: vec!["us".into()],
                        },
                    ],
                ),
            ],
            focus_query_id: "all".into(),
            key_maps: vec![],
        };
        let mut seeds = HashMap::new();
        seeds.insert("eu".into(), vec!["id".into(), "amt".into()]);
        seeds.insert(
            "us".into(),
            vec!["id".into(), "amount".into(), "currency".into()],
        );

        let schemas = infer_workspace_schemas(&ws, &seeds).unwrap();
        assert_eq!(
            schemas.step("all", 1).as_ref().unwrap(),
            &vec!["id".to_string(), "amount".to_string()]
        );
        let fin = schemas.query_final("all").unwrap();
        assert_eq!(fin, vec!["id", "amount", "currency"]);
    }

    #[test]
    fn group_by_yields_unknown() {
        let prev = vec!["id".into(), "amt".into()];
        let step = TransformationStep::GroupBy {
            dimensions: vec!["id".into()],
            aggregates: vec!["sum(amt)".into()],
        };
        let next = apply_step_schema(
            &step,
            Some(&prev),
            &HashMap::new(),
            &HashMap::new(),
            "q",
            1,
        )
        .unwrap();
        assert!(next.is_none());
    }

    #[test]
    fn load_without_seed_unknown() {
        let ws = Workspace {
            queries: vec![q(
                "a",
                vec![TransformationStep::LoadCsv {
                    path: "a.csv".into(),
                }],
            )],
            focus_query_id: "a".into(),
            key_maps: vec![],
        };
        let schemas = infer_workspace_schemas(&ws, &HashMap::new()).unwrap();
        assert!(schemas.query_final("a").is_none());
    }

    #[test]
    fn join_using_drops_right_key() {
        let left = vec!["id".into(), "amt".into()];
        let right = vec!["id".into(), "region".into()];
        let out = join_result_schema(&left, &right, &["id".into()], &["id".into()])
            .unwrap()
            .unwrap();
        assert_eq!(out, vec!["id", "amt", "region"]);
    }

    #[test]
    fn apply_keymap_appends_new_output_column() {
        let prev = vec!["ext".into(), "region".into()];
        let step = TransformationStep::ApplyKeyMap {
            column: "ext".into(),
            columns: vec!["ext".into()],
            output_column: Some("canonical".into()),
            map_id: "m".into(),
            entries: vec![],
        };
        let next = apply_step_schema(
            &step,
            Some(&prev),
            &HashMap::new(),
            &HashMap::new(),
            "q",
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next, vec!["ext", "region", "canonical"]);
    }

    #[test]
    fn apply_keymap_keeps_schema_when_overwriting() {
        let prev = vec!["ext".into(), "canonical".into()];
        let step = TransformationStep::ApplyKeyMap {
            column: "ext".into(),
            columns: vec!["ext".into()],
            output_column: Some("canonical".into()),
            map_id: "m".into(),
            entries: vec![],
        };
        let next = apply_step_schema(
            &step,
            Some(&prev),
            &HashMap::new(),
            &HashMap::new(),
            "q",
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(next, vec!["ext", "canonical"]);
    }
}
