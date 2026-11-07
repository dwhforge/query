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
    /// Join-anchored attrs overview ([ADR-0035](../../../docs/adr/0035-mapping-check-attrs-ux.md)).
    /// Prefer `left_attrs` / `right_attrs` / `sample_columns`; singular fields soft-migrate on load.
    Attrs {
        host_query_id: String,
        /// First left-axis column (legacy wire + convenience).
        #[serde(default)]
        left_attr: String,
        /// First right-axis column (legacy wire + convenience).
        #[serde(default)]
        right_attr: String,
        /// First sample column (legacy wire + convenience).
        #[serde(default)]
        sample_column: String,
        /// Full row-axis columns (From/ON tuple when composite; includes date parts).
        #[serde(default)]
        #[serde(skip_serializing_if = "Vec::is_empty")]
        left_attrs: Vec<String>,
        /// Full column-axis columns (usually one right-side label).
        #[serde(default)]
        #[serde(skip_serializing_if = "Vec::is_empty")]
        right_attrs: Vec<String>,
        /// Inspect grain columns (typically aligns with left_attrs or Join left_on).
        #[serde(default)]
        #[serde(skip_serializing_if = "Vec::is_empty")]
        sample_columns: Vec<String>,
    },
}

impl MappingCheckProjection {
    /// Normalize singular ↔ array fields after deserialize (ADR-0035).
    pub fn normalize_attrs(self) -> Self {
        match self {
            MappingCheckProjection::LabV1 => MappingCheckProjection::LabV1,
            MappingCheckProjection::Attrs {
                host_query_id,
                left_attr,
                right_attr,
                sample_column,
                left_attrs,
                right_attrs,
                sample_columns,
            } => {
                let left_attrs = if !left_attrs.is_empty() {
                    left_attrs
                } else if !left_attr.is_empty() {
                    vec![left_attr.clone()]
                } else {
                    vec![]
                };
                let right_attrs = if !right_attrs.is_empty() {
                    right_attrs
                } else if !right_attr.is_empty() {
                    vec![right_attr.clone()]
                } else {
                    vec![]
                };
                let sample_columns = if !sample_columns.is_empty() {
                    sample_columns
                } else if !sample_column.is_empty() {
                    vec![sample_column.clone()]
                } else {
                    left_attrs.clone()
                };
                MappingCheckProjection::Attrs {
                    host_query_id,
                    left_attr: left_attrs.first().cloned().unwrap_or_default(),
                    right_attr: right_attrs.first().cloned().unwrap_or_default(),
                    sample_column: sample_columns.first().cloned().unwrap_or_default(),
                    left_attrs,
                    right_attrs,
                    sample_columns,
                }
            }
        }
    }
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
    fn attrs_singular_soft_migrates_to_arrays() {
        let json = serde_json::json!({
            "kind": "attrs",
            "host_query_id": "q1",
            "left_attr": "a",
            "right_attr": "b",
            "sample_column": "id"
        });
        let p: MappingCheckProjection = serde_json::from_value(json).unwrap();
        let n = p.normalize_attrs();
        match n {
            MappingCheckProjection::Attrs {
                left_attrs,
                right_attrs,
                sample_columns,
                ..
            } => {
                assert_eq!(left_attrs, vec!["a"]);
                assert_eq!(right_attrs, vec!["b"]);
                assert_eq!(sample_columns, vec!["id"]);
            }
            _ => panic!("expected attrs"),
        }
    }

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
