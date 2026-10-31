use crate::model::{TransformationStep, Workspace};
use std::collections::{HashMap, HashSet, VecDeque};

/// Query ids that `query_id` depends on via Join/Append.
pub fn direct_deps(steps: &[TransformationStep]) -> Vec<String> {
    let mut deps = Vec::new();
    for step in steps {
        match step {
            TransformationStep::FromQuery { query_id } => {
                deps.push(query_id.clone());
            }
            TransformationStep::Join { right_query_id, .. } => {
                deps.push(right_query_id.clone());
            }
            TransformationStep::Append { other_query_ids } => {
                deps.extend(other_query_ids.iter().cloned());
            }
            TransformationStep::SqlModel { raw_sql }
            | TransformationStep::CustomSql { raw_sql } => {
                // {{query:id}}
                for cap in extract_query_placeholders(raw_sql) {
                    deps.push(cap);
                }
            }
            _ => {}
        }
    }
    deps.sort();
    deps.dedup();
    deps
}

fn extract_query_placeholders(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(start) = rest.find("{{query:") {
        rest = &rest[start + "{{query:".len()..];
        if let Some(end) = rest.find("}}") {
            let id = rest[..end].trim();
            if !id.is_empty() {
                out.push(id.to_string());
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    out
}

pub fn sanitize_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "q".into()
    } else if s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("q_{s}")
    } else {
        s
    }
}

pub fn cte_name(query_id: &str, step_idx: usize) -> String {
    format!("q_{}_s{}", sanitize_id(query_id), step_idx)
}

/// All query ids reachable as dependencies of `root_id` (including itself).
pub fn reachable_from(workspace: &Workspace, root_id: &str) -> Result<HashSet<String>, String> {
    let ids: HashSet<String> = workspace.queries.iter().map(|q| q.id.clone()).collect();
    if !ids.contains(root_id) {
        return Err(format!("query '{root_id}' not found in workspace"));
    }
    let mut need = HashSet::new();
    let mut stack = vec![root_id.to_string()];
    while let Some(id) = stack.pop() {
        if !need.insert(id.clone()) {
            continue;
        }
        let q = workspace
            .query(&id)
            .ok_or_else(|| format!("missing query {id}"))?;
        for dep in direct_deps(&q.steps) {
            if !ids.contains(&dep) {
                return Err(format!(
                    "query '{id}' references unknown query '{dep}'"
                ));
            }
            if dep == id {
                return Err(format!("query '{id}' cannot depend on itself"));
            }
            stack.push(dep);
        }
    }
    Ok(need)
}

/// Topological order of **all** query ids. Error on unknown deps or cycles.
pub fn topo_queries(workspace: &Workspace) -> Result<Vec<String>, String> {
    if !workspace
        .queries
        .iter()
        .any(|q| q.id == workspace.focus_query_id)
    {
        return Err(format!(
            "focus_query_id '{}' not found in workspace",
            workspace.focus_query_id
        ));
    }
    let all: HashSet<String> = workspace.queries.iter().map(|q| q.id.clone()).collect();
    topo_subset(workspace, &all)
}

/// Topological order of `root_id` and its transitive deps only.
/// Preview/compile of one query must not fail because an unrelated query is empty/broken.
pub fn topo_queries_from(workspace: &Workspace, root_id: &str) -> Result<Vec<String>, String> {
    let need = reachable_from(workspace, root_id)?;
    topo_subset(workspace, &need)
}

fn topo_subset(workspace: &Workspace, need: &HashSet<String>) -> Result<Vec<String>, String> {
    let mut indegree: HashMap<String, usize> = HashMap::new();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();

    for id in need {
        indegree.entry(id.clone()).or_insert(0);
    }
    for id in need {
        let q = workspace
            .query(id)
            .ok_or_else(|| format!("missing query {id}"))?;
        for dep in direct_deps(&q.steps) {
            if !need.contains(&dep) {
                continue;
            }
            if dep == *id {
                return Err(format!("query '{id}' cannot depend on itself"));
            }
            adj.entry(dep.clone()).or_default().push(id.clone());
            *indegree.entry(id.clone()).or_insert(0) += 1;
            indegree.entry(dep).or_insert(0);
        }
    }

    let mut queue: VecDeque<String> = indegree
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(id, _)| id.clone())
        .collect();
    queue.make_contiguous().sort(); // deterministic

    let mut order = Vec::new();
    while let Some(id) = queue.pop_front() {
        order.push(id.clone());
        if let Some(children) = adj.get(&id) {
            let mut children = children.clone();
            children.sort();
            for child in children {
                if let Some(d) = indegree.get_mut(&child) {
                    *d -= 1;
                    if *d == 0 {
                        queue.push_back(child);
                    }
                }
            }
        }
    }

    if order.len() != need.len() {
        return Err("cycle detected in query dependencies".into());
    }
    Ok(order)
}

/// Step that forces a real recompute (not a thin source read / projection).
///
/// Cheap: Load*, FromQuery, Filter, Select, Rename, Sort, Limit, NormalizeKey, ApplyKeyMap.
/// Expensive: GroupBy, Join, Append, SqlModel, CustomSql, DeriveColumn.
pub fn step_is_derived_expensive(step: &TransformationStep) -> bool {
    matches!(
        step,
        TransformationStep::GroupBy { .. }
            | TransformationStep::Join { .. }
            | TransformationStep::Append { .. }
            | TransformationStep::SqlModel { .. }
            | TransformationStep::CustomSql { .. }
            | TransformationStep::DeriveColumn { .. }
    )
}

pub fn steps_are_derived_expensive(steps: &[TransformationStep]) -> bool {
    steps.iter().any(step_is_derived_expensive)
}

/// True if `query_id` or any transitive dep contains an expensive step.
pub fn query_closure_is_expensive(
    workspace: &Workspace,
    query_id: &str,
) -> Result<bool, String> {
    let need = reachable_from(workspace, query_id)?;
    for id in need {
        let q = workspace
            .query(&id)
            .ok_or_else(|| format!("missing query {id}"))?;
        if steps_are_derived_expensive(&q.steps) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Left input of a Join: host steps before the Join + deps those steps reference.
pub fn join_left_input_is_expensive(
    workspace: &Workspace,
    host_query_id: &str,
    join_step_index: usize,
) -> Result<bool, String> {
    let host = workspace
        .query(host_query_id)
        .ok_or_else(|| format!("missing host query '{host_query_id}'"))?;
    if join_step_index > host.steps.len() {
        return Err(format!(
            "join_step_index {join_step_index} out of range for '{host_query_id}'"
        ));
    }
    let prefix = &host.steps[..join_step_index];
    if steps_are_derived_expensive(prefix) {
        return Ok(true);
    }
    for dep in direct_deps(prefix) {
        if query_closure_is_expensive(workspace, &dep)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Right input of a Join: the right query and its full closure.
pub fn join_right_input_is_expensive(
    workspace: &Workspace,
    right_query_id: &str,
) -> Result<bool, String> {
    query_closure_is_expensive(workspace, right_query_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{JoinType, QueryDef, TransformationStep};

    #[test]
    fn topo_join_dependency() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "orders".into(),
                    name: "orders".into(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: "o.csv".into(),
                    }],
                 execution: Default::default(),
},
                QueryDef {
                    id: "joined".into(),
                    name: "joined".into(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: "c.csv".into(),
                        },
                        TransformationStep::Join {
                            right_query_id: "orders".into(),
                            join_type: JoinType::Inner,
                            left_on: vec!["id".into()],
                            right_on: vec!["id".into()],
                        },
                    ],
                 execution: Default::default(),
},
            ],
            focus_query_id: "joined".into(),
            key_maps: vec![],
        };
        let order = topo_queries(&ws).unwrap();
        assert!(
            order.iter().position(|x| x == "orders").unwrap()
                < order.iter().position(|x| x == "joined").unwrap()
        );
        assert!(!join_left_input_is_expensive(&ws, "joined", 1).unwrap());
        assert!(!join_right_input_is_expensive(&ws, "orders").unwrap());
    }

    #[test]
    fn expensive_right_via_groupby() {
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "batches".into(),
                    name: "batches".into(),
                    steps: vec![TransformationStep::LoadParquet {
                        path: "b.parquet".into(),
                        connection_id: None,
                    }],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "batch_cost".into(),
                    name: "batch_cost".into(),
                    steps: vec![
                        TransformationStep::FromQuery {
                            query_id: "batches".into(),
                        },
                        TransformationStep::GroupBy {
                            dimensions: vec!["batch_id".into()],
                            aggregates: vec!["sum(kg) as total".into()],
                        },
                        TransformationStep::DeriveColumn {
                            name: "unit_cost".into(),
                            expression: "1.0".into(),
                            mode: Default::default(),
                            op: None,
                            sql_dialect: None,
                        },
                    ],
                    execution: Default::default(),
                },
                QueryDef {
                    id: "costed".into(),
                    name: "costed".into(),
                    steps: vec![
                        TransformationStep::LoadParquet {
                            path: "a.parquet".into(),
                            connection_id: None,
                        },
                        TransformationStep::Join {
                            right_query_id: "batch_cost".into(),
                            join_type: JoinType::Left,
                            left_on: vec!["batch_id".into()],
                            right_on: vec!["batch_id".into()],
                        },
                    ],
                    execution: Default::default(),
                },
            ],
            focus_query_id: "costed".into(),
            key_maps: vec![],
        };
        assert!(!join_left_input_is_expensive(&ws, "costed", 1).unwrap());
        assert!(join_right_input_is_expensive(&ws, "batch_cost").unwrap());
    }
}
