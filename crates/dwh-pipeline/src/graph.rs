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
    }
}
