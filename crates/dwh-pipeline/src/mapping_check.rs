//! MappingCheck / CheckRun IR — ADR-0027 / ADR-0029 (Rust SoT for wire + persistence).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How a CheckRun may be compared to a prior run (ADR-0027).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind")]
pub enum CheckComparability {
    Full,
    Limited { reason: String },
}

/// Attribution of delta between two CheckRuns (ADR-0027).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum CheckDeltaAttribution {
    MappingChanged,
    InputsChanged,
    BothChanged,
    DefinitionChanged,
    Unchanged,
    Limited,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
pub struct MappingAllowDecision {
    pub id: String,
    pub group_key: String,
    pub explanation: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind")]
pub enum MappingCheckProjection {
    LabV1,
    Attrs {
        host_query_id: String,
        left_attr: String,
        right_attr: String,
        sample_column: String,
    },
}

/// Durable mapping quality check definition (ADR-0027).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
pub struct MappingCheck {
    pub id: String,
    pub name: String,
    pub map_id: String,
    #[serde(default)]
    pub input_refs: Vec<String>,
    #[serde(default)]
    pub group_attributes: Vec<String>,
    #[serde(default)]
    pub cohort_predicate: String,
    pub projection: MappingCheckProjection,
    #[serde(default)]
    pub allow_decisions: Vec<MappingAllowDecision>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, TS)]
pub struct CheckInputRevision {
    pub ref_id: String,
    pub revision: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unknown_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CheckAggregateCell {
    pub row: String,
    pub column: String,
    pub signal: String,
    #[ts(type = "number")]
    pub positions: i64,
    pub revenue: f64,
    #[serde(default)]
    pub samples: Vec<String>,
}

/// Result of one execution of a MappingCheck (ADR-0027).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CheckRun {
    pub id: String,
    pub check_id: String,
    pub ran_at: String,
    pub map_revision: String,
    #[serde(default)]
    pub input_revisions: Vec<CheckInputRevision>,
    pub check_definition_revision: String,
    #[ts(type = "number")]
    pub total_positions: i64,
    #[serde(default)]
    pub cells: Vec<CheckAggregateCell>,
    pub comparability: CheckComparability,
    /// True when `cells` are a budgeted top-N, not the full aggregate matrix.
    #[serde(default)]
    pub cells_incomplete: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub group_count: Option<i64>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub covered_positions: Option<i64>,
    /// Full-aggregate unmapped positions (not inferred from a truncated cell list).
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub unmapped_positions: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_check_round_trip_json() {
        let check = MappingCheck {
            id: "check_lab_quality".into(),
            name: "Lab quality".into(),
            map_id: "map_lab".into(),
            input_refs: vec!["q_orders".into()],
            group_attributes: vec![],
            cohort_predicate: String::new(),
            projection: MappingCheckProjection::LabV1,
            allow_decisions: vec![],
        };
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["projection"]["kind"], "lab_v1");
        let back: MappingCheck = serde_json::from_value(json).unwrap();
        assert_eq!(back, check);
    }

    #[test]
    fn check_run_rejects_missing_comparability() {
        let bad = serde_json::json!({
            "id": "run_1",
            "check_id": "c1",
            "ran_at": "2026-01-01T00:00:00Z",
            "map_revision": "abc",
            "check_definition_revision": "def",
            "total_positions": 0,
            "cells": []
        });
        assert!(serde_json::from_value::<CheckRun>(bad).is_err());
    }
}
