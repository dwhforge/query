//! Map-key merge / bulk classify (ADR-0044). Fixtures before UI.

use super::types::{map_key_token, MatchingMapRowSnapshot};
use super::validate::MaterializedDecision;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchingMergeOutcome {
    /// Key absent; one coherent proposal — may add.
    Add,
    /// Same key has conflicting proposed tuples in the bulk set.
    ConflictProposals,
    /// Live map already has the same output tuple — no-op.
    AlreadyMatches,
    /// Live map has a different tuple — needs explicit replace.
    NeedsExplicitReplace,
    /// Live map diverged from prepare baseline — stale.
    StaleBaseline,
    /// Explicit replace agreed — will change.
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchingMergeItem {
    pub map_key: Vec<String>,
    pub outcome: MatchingMergeOutcome,
    pub affected_source_rows: u32,
    pub proposed_outputs: Option<Vec<String>>,
    pub live_outputs: Option<Vec<String>>,
}

fn outputs_eq(a: &[String], b: &[String]) -> bool {
    a == b
}

/// Classify one confirmed decision against baseline + live map.
///
/// `explicit_replace_keys` — keys the user explicitly agreed to overwrite.
pub fn classify_merge(
    decision: &MaterializedDecision,
    baseline: &HashMap<String, MatchingMapRowSnapshot>,
    live: &HashMap<String, MatchingMapRowSnapshot>,
    explicit_replace_keys: &HashSet<String>,
) -> MatchingMergeItem {
    let token = map_key_token(&decision.map_key);
    let live_row = live.get(&token);
    let base_row = baseline.get(&token);

    // Stale: baseline said one thing (or absence) but live differs from baseline.
    if let Some(base) = base_row {
        match live_row {
            Some(live_r) if !outputs_eq(&base.output_values, &live_r.output_values) => {
                return MatchingMergeItem {
                    map_key: decision.map_key.clone(),
                    outcome: MatchingMergeOutcome::StaleBaseline,
                    affected_source_rows: decision.affected_source_rows,
                    proposed_outputs: Some(decision.output_values.clone()),
                    live_outputs: Some(live_r.output_values.clone()),
                };
            }
            None => {
                return MatchingMergeItem {
                    map_key: decision.map_key.clone(),
                    outcome: MatchingMergeOutcome::StaleBaseline,
                    affected_source_rows: decision.affected_source_rows,
                    proposed_outputs: Some(decision.output_values.clone()),
                    live_outputs: None,
                };
            }
            _ => {}
        }
    } else if live_row.is_some() {
        // Baseline: absent; live: present → concurrent insert.
        return MatchingMergeItem {
            map_key: decision.map_key.clone(),
            outcome: MatchingMergeOutcome::StaleBaseline,
            affected_source_rows: decision.affected_source_rows,
            proposed_outputs: Some(decision.output_values.clone()),
            live_outputs: live_row.map(|r| r.output_values.clone()),
        };
    }

    match live_row {
        None => MatchingMergeItem {
            map_key: decision.map_key.clone(),
            outcome: MatchingMergeOutcome::Add,
            affected_source_rows: decision.affected_source_rows,
            proposed_outputs: Some(decision.output_values.clone()),
            live_outputs: None,
        },
        Some(live_r) if outputs_eq(&live_r.output_values, &decision.output_values) => {
            MatchingMergeItem {
                map_key: decision.map_key.clone(),
                outcome: MatchingMergeOutcome::AlreadyMatches,
                affected_source_rows: decision.affected_source_rows,
                proposed_outputs: Some(decision.output_values.clone()),
                live_outputs: Some(live_r.output_values.clone()),
            }
        }
        Some(live_r) if explicit_replace_keys.contains(&token) => MatchingMergeItem {
            map_key: decision.map_key.clone(),
            outcome: MatchingMergeOutcome::Replace,
            affected_source_rows: decision.affected_source_rows,
            proposed_outputs: Some(decision.output_values.clone()),
            live_outputs: Some(live_r.output_values.clone()),
        },
        Some(live_r) => MatchingMergeItem {
            map_key: decision.map_key.clone(),
            outcome: MatchingMergeOutcome::NeedsExplicitReplace,
            affected_source_rows: decision.affected_source_rows,
            proposed_outputs: Some(decision.output_values.clone()),
            live_outputs: Some(live_r.output_values.clone()),
        },
    }
}

/// Detect same-key conflicting proposed output tuples in a bulk set.
pub fn detect_proposal_conflicts(
    decisions: &[MaterializedDecision],
) -> HashSet<String> {
    let mut first: HashMap<String, Vec<String>> = HashMap::new();
    let mut conflicts = HashSet::new();
    for d in decisions {
        let token = map_key_token(&d.map_key);
        match first.get(&token) {
            None => {
                first.insert(token, d.output_values.clone());
            }
            Some(prev) if prev != &d.output_values => {
                conflicts.insert(token);
            }
            _ => {}
        }
    }
    conflicts
}

/// Ordinary bulk confirm: exclude conflicts, needs-replace, and stale.
/// Does not pick winners by arrival order — conflicts are excluded entirely.
pub fn plan_bulk_confirm(
    decisions: &[MaterializedDecision],
    baseline: &HashMap<String, MatchingMapRowSnapshot>,
    live: &HashMap<String, MatchingMapRowSnapshot>,
    explicit_replace_keys: &HashSet<String>,
) -> Vec<MatchingMergeItem> {
    let conflicts = detect_proposal_conflicts(decisions);
    let mut seen_keys = HashSet::new();
    let mut out = Vec::new();
    for d in decisions {
        let token = map_key_token(&d.map_key);
        if conflicts.contains(&token) {
            if seen_keys.insert(token.clone()) {
                out.push(MatchingMergeItem {
                    map_key: d.map_key.clone(),
                    outcome: MatchingMergeOutcome::ConflictProposals,
                    affected_source_rows: d.affected_source_rows,
                    proposed_outputs: Some(d.output_values.clone()),
                    live_outputs: live.get(&token).map(|r| r.output_values.clone()),
                });
            }
            continue;
        }
        if !seen_keys.insert(token) {
            // Same key + same tuple → one decision (keep first; rows already counted on it).
            continue;
        }
        out.push(classify_merge(d, baseline, live, explicit_replace_keys));
    }
    out
}

/// Items that may proceed to Save in an ordinary bulk (Add + AlreadyMatches + Replace).
/// NeedsExplicitReplace / Conflict / Stale are excluded.
pub fn bulk_saveable(items: &[MatchingMergeItem]) -> Vec<&MatchingMergeItem> {
    items
        .iter()
        .filter(|i| {
            matches!(
                i.outcome,
                MatchingMergeOutcome::Add
                    | MatchingMergeOutcome::AlreadyMatches
                    | MatchingMergeOutcome::Replace
            )
        })
        .collect()
}

/// Final commit: if any selected item is conflict/stale/needs-replace without agreement → stop.
pub fn commit_blocked_reason(items: &[MatchingMergeItem]) -> Option<&'static str> {
    for i in items {
        match i.outcome {
            MatchingMergeOutcome::ConflictProposals => return Some("conflict_proposals"),
            MatchingMergeOutcome::StaleBaseline => return Some("stale_baseline"),
            MatchingMergeOutcome::NeedsExplicitReplace => return Some("needs_explicit_replace"),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod merge_matrix_tests {
    use super::*;
    use crate::matching::validate::MaterializedDecision;

    fn dec(key: &[&str], outs: &[&str], rows: u32) -> MaterializedDecision {
        MaterializedDecision {
            map_key: key.iter().map(|s| (*s).to_string()).collect(),
            candidate_id: "c".into(),
            target_id: outs.first().copied().unwrap_or("").into(),
            output_values: outs.iter().map(|s| (*s).to_string()).collect(),
            proposal_id: "p".into(),
            affected_source_rows: rows,
        }
    }

    fn row(key: &[&str], outs: &[&str]) -> MatchingMapRowSnapshot {
        MatchingMapRowSnapshot {
            from_parts: key.iter().map(|s| (*s).to_string()).collect(),
            output_values: outs.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn map_of(rows: Vec<MatchingMapRowSnapshot>) -> HashMap<String, MatchingMapRowSnapshot> {
        rows.into_iter()
            .map(|r| (r.key_token(), r))
            .collect()
    }

    #[test]
    fn absent_coherent_proposal_adds() {
        let d = dec(&["a1", "Eurpope"], &["1"], 1);
        let item = classify_merge(&d, &HashMap::new(), &HashMap::new(), &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::Add);
    }

    #[test]
    fn conflicting_proposals_block_bulk() {
        let decisions = vec![
            dec(&["a1", "Eurpope"], &["1"], 1),
            dec(&["a1", "Eurpope"], &["2"], 1),
        ];
        let items = plan_bulk_confirm(&decisions, &HashMap::new(), &HashMap::new(), &HashSet::new());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].outcome, MatchingMergeOutcome::ConflictProposals);
        assert!(bulk_saveable(&items).is_empty());
        assert_eq!(commit_blocked_reason(&items), Some("conflict_proposals"));
    }

    #[test]
    fn same_output_is_noop() {
        let live = map_of(vec![row(&["k"], &["1", "x"])]);
        let d = dec(&["k"], &["1", "x"], 3);
        let item = classify_merge(&d, &live, &live, &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::AlreadyMatches);
    }

    #[test]
    fn different_tuple_needs_explicit_replace() {
        let live = map_of(vec![row(&["k"], &["old"])]);
        let d = dec(&["k"], &["new"], 1);
        let item = classify_merge(&d, &live, &live, &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::NeedsExplicitReplace);
        let agreed = HashSet::from([map_key_token(&["k".into()])]);
        let item2 = classify_merge(&d, &live, &live, &agreed);
        assert_eq!(item2.outcome, MatchingMergeOutcome::Replace);
    }

    #[test]
    fn map_changed_after_baseline_is_stale() {
        let baseline = map_of(vec![row(&["k"], &["1"])]);
        let live = map_of(vec![row(&["k"], &["concurrent"])]);
        let d = dec(&["k"], &["2"], 1);
        let item = classify_merge(&d, &baseline, &live, &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::StaleBaseline);
        assert_eq!(commit_blocked_reason(&[item]), Some("stale_baseline"));
    }

    #[test]
    fn chosen_alternative_is_authoritative_outputs() {
        let d = dec(&["a1", "Eurpope"], &["2"], 1); // alternative id=2
        let item = classify_merge(&d, &HashMap::new(), &HashMap::new(), &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::Add);
        assert_eq!(item.proposed_outputs.as_ref().unwrap(), &vec!["2".to_string()]);
    }

    #[test]
    fn many_source_rows_one_decision() {
        let decisions = vec![
            dec(&["k"], &["1"], 24),
            dec(&["k"], &["1"], 24), // duplicate arrival — same tuple
        ];
        let items = plan_bulk_confirm(&decisions, &HashMap::new(), &HashMap::new(), &HashSet::new());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].affected_source_rows, 24);
        assert_eq!(items[0].outcome, MatchingMergeOutcome::Add);
    }

    #[test]
    fn filled_means_row_exists_even_if_outputs_look_empty() {
        // "" is a real stored output value — row is filled.
        let live = map_of(vec![row(&["k"], &[""])]);
        let d = dec(&["k"], &["1"], 1);
        let item = classify_merge(&d, &live, &live, &HashSet::new());
        assert_eq!(item.outcome, MatchingMergeOutcome::NeedsExplicitReplace);
    }

    #[test]
    fn composite_key_and_multi_output() {
        let live = map_of(vec![row(&["p", "r"], &["1", "v1"])]);
        let d = dec(&["p", "r"], &["1", "v1"], 2);
        assert_eq!(
            classify_merge(&d, &live, &live, &HashSet::new()).outcome,
            MatchingMergeOutcome::AlreadyMatches
        );
        let d2 = dec(&["p", "r"], &["1", "v2"], 2);
        assert_eq!(
            classify_merge(&d2, &live, &live, &HashSet::new()).outcome,
            MatchingMergeOutcome::NeedsExplicitReplace
        );
    }

    #[test]
    fn significant_blank_key_part_is_distinct() {
        let live = map_of(vec![row(&["a1", ""], &["1"])]);
        let d_blank = dec(&["a1", ""], &["1"], 1);
        let d_space = dec(&["a1", " "], &["1"], 1);
        assert_eq!(
            classify_merge(&d_blank, &live, &live, &HashSet::new()).outcome,
            MatchingMergeOutcome::AlreadyMatches
        );
        // Different key token — treated as absent → Add
        assert_eq!(
            classify_merge(&d_space, &live, &live, &HashSet::new()).outcome,
            MatchingMergeOutcome::Add
        );
    }

    #[test]
    fn ordinary_bulk_excludes_replace_without_agreement() {
        let live = map_of(vec![row(&["k"], &["old"])]);
        let decisions = vec![dec(&["k"], &["new"], 1), dec(&["n"], &["1"], 1)];
        let items = plan_bulk_confirm(&decisions, &live, &live, &HashSet::new());
        let saveable = bulk_saveable(&items);
        assert_eq!(saveable.len(), 1);
        assert_eq!(saveable[0].map_key, vec!["n".to_string()]);
    }

    #[test]
    fn commit_stops_on_conflict_no_partial_implied() {
        let items = vec![
            MatchingMergeItem {
                map_key: vec!["ok".into()],
                outcome: MatchingMergeOutcome::Add,
                affected_source_rows: 1,
                proposed_outputs: Some(vec!["1".into()]),
                live_outputs: None,
            },
            MatchingMergeItem {
                map_key: vec!["bad".into()],
                outcome: MatchingMergeOutcome::StaleBaseline,
                affected_source_rows: 1,
                proposed_outputs: Some(vec!["2".into()]),
                live_outputs: Some(vec!["x".into()]),
            },
        ];
        // Caller must refuse entire commit when any blocker present in the save set.
        assert_eq!(commit_blocked_reason(&items), Some("stale_baseline"));
    }
}
