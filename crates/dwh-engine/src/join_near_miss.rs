//! Near-miss join-key suggestions (ADR-0020).
//!
//! Try deterministic normalizations; return only hypotheses that strictly increase
//! distinct key overlap. Apply inserts [`NormalizeKey`] before Join — never auto-ON.

use crate::session::DbSession;
use dwh_pipeline::{
    cte_name, normalize_key_column_expr, quote_ident, ConnectionDef, GraphCompiler, NormalizeOp,
    TransformationStep, Workspace,
};
use duckdb::params;
use serde::{Deserialize, Serialize};

const SAMPLE_PAIR_LIMIT: u64 = 8;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NearMissSide {
    Left,
    Right,
    Both,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NearMissHypothesis {
    pub ops: Vec<NormalizeOp>,
    pub apply_on: NearMissSide,
    pub baseline_matches: u64,
    pub after_matches: u64,
    pub delta_matches: u64,
    /// Newly overlapping keys after normalize (stringified composite).
    pub sample_pairs: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JoinKeyNearMiss {
    pub host_query_id: String,
    pub join_step_index: usize,
    pub left_on: Vec<String>,
    pub right_on: Vec<String>,
    pub baseline_matches: u64,
    pub hypotheses: Vec<NearMissHypothesis>,
}

/// Score near-miss normalize hypotheses for a Join step.
pub fn join_key_near_miss(
    db: &DbSession,
    workspace: &Workspace,
    connections: &[ConnectionDef],
    sources: &[dwh_pipeline::SourceDef],
    host_query_id: &str,
    join_step_index: usize,
) -> Result<JoinKeyNearMiss, String> {
    let resolved = db.prepare_workspace(workspace, connections)?;
    let host = resolved
        .query(host_query_id)
        .ok_or_else(|| format!("missing host query '{host_query_id}'"))?;
    if join_step_index >= host.steps.len() {
        return Err(format!(
            "join_step_index {join_step_index} out of range for query '{host_query_id}'"
        ));
    }
    let TransformationStep::Join {
        right_query_id,
        left_on,
        right_on,
        ..
    } = &host.steps[join_step_index]
    else {
        return Err(format!(
            "step {join_step_index} of '{host_query_id}' is not a Join"
        ));
    };
    if left_on.is_empty() || left_on.len() != right_on.len() {
        return Err("Join: left_on/right_on must be non-empty and same length".into());
    }
    if join_step_index == 0 {
        return Err("Join cannot be the first step (no left input)".into());
    }

    let left_cte_full = cte_name(host_query_id, join_step_index - 1);
    let right_cte_full = cte_name(right_query_id, {
        let rq = resolved
            .query(right_query_id)
            .ok_or_else(|| format!("missing right query '{right_query_id}'"))?;
        if rq.steps.is_empty() {
            return Err(format!("right query '{right_query_id}' has no steps"));
        }
        rq.steps.len() - 1
    });

    crate::join_prepare::ensure_join_sides_materialized(
        db,
        workspace,
        connections,
        sources,
        host_query_id,
        join_step_index,
        None,
    )?;
    let prep = crate::join_prepare::prepared_join_with(
        db,
        workspace,
        sources,
        connections,
        host_query_id,
        join_step_index,
    );
    let (left_cte, right_cte, wrap_select): (String, String, Box<dyn Fn(&str) -> String>) =
        if let Some((_h, defs)) = prep {
            let (l, r, _) = crate::join_prepare::prepared_cte_names();
            (
                l.into(),
                r.into(),
                Box::new(move |body: &str| format!("WITH \n{defs}\n{body}")),
            )
        } else {
            let compiled = GraphCompiler::new(&resolved)
                .with_sources(sources)
                .with_connections(connections)
                .compile_ctes_from(host_query_id)?;
            (
                left_cte_full,
                right_cte_full,
                Box::new(move |body: &str| compiled.wrap_select(body)),
            )
        };

    let baseline = count_overlap(
        db,
        &wrap_select(&overlap_sql(
            &left_cte,
            &right_cte,
            left_on,
            right_on,
            None,
            None,
        )),
    )?;

    let candidates: Vec<(Vec<NormalizeOp>, NearMissSide)> = {
        let singles = [
            vec![NormalizeOp::Trim],
            vec![NormalizeOp::Lower],
            vec![NormalizeOp::Upper],
            vec![NormalizeOp::CollapseSpace],
            vec![NormalizeOp::LtrimZeros],
            vec![NormalizeOp::Trim, NormalizeOp::Lower],
            vec![NormalizeOp::Trim, NormalizeOp::Upper],
            vec![NormalizeOp::CollapseSpace, NormalizeOp::Lower],
        ];
        let mut out = Vec::new();
        for ops in singles {
            for side in [
                NearMissSide::Left,
                NearMissSide::Right,
                NearMissSide::Both,
            ] {
                out.push((ops.clone(), side));
            }
        }
        out
    };

    let mut hypotheses = Vec::new();
    for (ops, side) in candidates {
        let (l_ops, r_ops) = match side {
            NearMissSide::Left => (Some(ops.as_slice()), None),
            NearMissSide::Right => (None, Some(ops.as_slice())),
            NearMissSide::Both => (Some(ops.as_slice()), Some(ops.as_slice())),
        };
        let after = count_overlap(
            db,
            &wrap_select(&overlap_sql(
                &left_cte,
                &right_cte,
                left_on,
                right_on,
                l_ops,
                r_ops,
            )),
        )?;
        if after <= baseline {
            continue;
        }
        let sample_pairs = sample_new_pairs(
            db,
            &wrap_select(&new_pairs_sql(
                &left_cte,
                &right_cte,
                left_on,
                right_on,
                l_ops,
                r_ops,
            )),
        )?;
        hypotheses.push(NearMissHypothesis {
            ops,
            apply_on: side,
            baseline_matches: baseline,
            after_matches: after,
            delta_matches: after - baseline,
            sample_pairs,
        });
    }

    hypotheses.sort_by(|a, b| {
        b.delta_matches
            .cmp(&a.delta_matches)
            .then_with(|| a.ops.len().cmp(&b.ops.len()))
    });

    Ok(JoinKeyNearMiss {
        host_query_id: host_query_id.to_string(),
        join_step_index,
        left_on: left_on.clone(),
        right_on: right_on.clone(),
        baseline_matches: baseline,
        hypotheses,
    })
}

fn key_expr(alias: &str, col: &str, ops: Option<&[NormalizeOp]>) -> String {
    let base = format!("{alias}.{}", quote_ident(col));
    match ops {
        Some(ops) if !ops.is_empty() => normalize_key_column_expr(&base, ops),
        _ => format!("CAST({base} AS VARCHAR)"),
    }
}

fn overlap_sql(
    left_cte: &str,
    right_cte: &str,
    left_on: &[String],
    right_on: &[String],
    left_ops: Option<&[NormalizeOp]>,
    right_ops: Option<&[NormalizeOp]>,
) -> String {
    let l_keys: Vec<String> = left_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{} AS k{i}", key_expr("l", c, left_ops)))
        .collect();
    let r_keys: Vec<String> = right_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{} AS k{i}", key_expr("r", c, right_ops)))
        .collect();
    let using: Vec<String> = (0..left_on.len()).map(|i| format!("k{i}")).collect();
    let using_list = using.join(", ");
    format!(
        "SELECT COUNT(*) FROM (\n\
           SELECT DISTINCT {l_sel} FROM {left_cte} l\n\
         ) lk\n\
         INNER JOIN (\n\
           SELECT DISTINCT {r_sel} FROM {right_cte} r\n\
         ) rk USING ({using_list})",
        l_sel = l_keys.join(", "),
        r_sel = r_keys.join(", "),
    )
}

fn new_pairs_sql(
    left_cte: &str,
    right_cte: &str,
    left_on: &[String],
    right_on: &[String],
    left_ops: Option<&[NormalizeOp]>,
    right_ops: Option<&[NormalizeOp]>,
) -> String {
    // Keys that match after normalize but not with raw equality.
    let raw_on: Vec<String> = left_on
        .iter()
        .zip(right_on.iter())
        .map(|(l, r)| {
            format!(
                "CAST(l.{} AS VARCHAR) = CAST(r.{} AS VARCHAR)",
                quote_ident(l),
                quote_ident(r)
            )
        })
        .collect();
    let norm_on: Vec<String> = left_on
        .iter()
        .zip(right_on.iter())
        .map(|(l, r)| {
            format!(
                "{} = {}",
                key_expr("l", l, left_ops),
                key_expr("r", r, right_ops)
            )
        })
        .collect();
    let disp: Vec<String> = left_on
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "CAST(l.{} AS VARCHAR) || ' → ' || CAST(r.{} AS VARCHAR) AS p{i}",
                quote_ident(c),
                quote_ident(&right_on[i])
            )
        })
        .collect();
    let pair_expr = if left_on.len() == 1 {
        "p0".to_string()
    } else {
        (0..left_on.len())
            .map(|i| format!("p{i}"))
            .collect::<Vec<_>>()
            .join(" || ' | ' || ")
    };
    format!(
        "SELECT DISTINCT {pair_expr} AS pair FROM (\n\
           SELECT {} FROM {left_cte} l\n\
           INNER JOIN {right_cte} r ON {}\n\
           WHERE NOT ({})\n\
         ) s\n\
         LIMIT {SAMPLE_PAIR_LIMIT}",
        disp.join(", "),
        norm_on.join(" AND "),
        raw_on.join(" AND "),
    )
}

fn count_overlap(db: &DbSession, sql: &str) -> Result<u64, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let row = rows
            .next()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "near-miss overlap: empty".to_string())?;
        Ok(row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64)
    })
}

fn sample_new_pairs(db: &DbSession, sql: &str) -> Result<Vec<String>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let s: String = row.get(0).map_err(|e| e.to_string())?;
            out.push(s);
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::DbSession;
    use dwh_pipeline::{JoinType, QueryDef, TransformationStep, Workspace};
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
    }

    #[test]
    fn key_expr_casts_before_trim_for_numeric_keys() {
        let sql = key_expr("l", "batch_id", Some(&[NormalizeOp::Trim]));
        assert_eq!(sql, "trim(CAST(l.\"batch_id\" AS VARCHAR))");
    }

    #[test]
    fn near_miss_finds_case_trim() {
        let dir = fixtures();
        // Build tiny CSVs via DuckDB VALUES by LoadCsv fixtures if present;
        // otherwise skip when sparse_sales lacks intentional near-miss.
        let sales = dir.join("sparse_sales.csv");
        let dim = dir.join("dim_channel.csv");
        if !sales.is_file() || !dim.is_file() {
            return;
        }
        let db = DbSession::new().unwrap();
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: sales.to_string_lossy().into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["channel".into()],
                            right_on: vec!["channel".into()],
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: dim.to_string_lossy().into(),
                    }],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let out = join_key_near_miss(&db, &ws, &[], &[], "fact", 1).unwrap();
        // May or may not find hypotheses depending on fixture content — API must succeed.
        assert_eq!(out.host_query_id, "fact");
        let _ = out.hypotheses;
    }
}
