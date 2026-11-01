//! KeyMap dirty-delta DTOs + single validator (ADR-0022 / ADR-0024).
//!
//! Wire JSON is accepted at the RPC boundary; DB writers consume
//! [`ValidatedMappingDelta`] only.

use dwh_pipeline::KeyMapEntry;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Warehouse row snapshot at first local edit of a From key (row-level concurrency).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapDirtyBaseline {
    pub from_parts: Vec<String>,
    /// false → row must be absent (insert).
    #[serde(default)]
    pub existed: bool,
    #[serde(default)]
    pub to: String,
    /// Editable attrs: JSON `null` ≡ SQL NULL; string (incl. `""`) ≡ that value.
    #[serde(default)]
    pub attrs: BTreeMap<String, Option<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyMapDirtyDelta {
    pub upserts: Vec<KeyMapEntry>,
    /// Arity-1 deletes (soft-migrated into `deleted_from_parts` when empty parts).
    #[serde(default)]
    pub deleted_froms: Vec<String>,
    /// From-tuple deletes ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    #[serde(default)]
    pub deleted_from_parts: Vec<Vec<String>>,
    /// Per-From baselines frozen for the dirty session (preferred over table content_hash).
    #[serde(default)]
    pub baselines: Vec<KeyMapDirtyBaseline>,
}

/// Canonical, DB-ready mapping change set.
#[derive(Debug, Clone)]
pub struct ValidatedMappingDelta {
    pub upserts: Vec<KeyMapEntry>,
    /// Normalized From tuples (arity-checked, trimmed, no empty parts).
    pub deletes: Vec<Vec<String>>,
    /// Baseline per From-tuple key (`parts.join("\0")`).
    pub baselines: HashMap<String, KeyMapDirtyBaseline>,
}

impl ValidatedMappingDelta {
    pub fn baseline_list(&self) -> Vec<KeyMapDirtyBaseline> {
        self.baselines.values().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.deletes.is_empty()
    }
}

fn tuple_key(parts: &[String]) -> String {
    parts.join("\0")
}

fn normalize_from_parts(parts: &[String], arity: usize, ctx: &str) -> Result<Vec<String>, String> {
    if parts.len() != arity {
        return Err(format!(
            "refused: {ctx} from_parts len {} ≠ arity {arity} ({parts:?})",
            parts.len()
        ));
    }
    let out: Vec<String> = parts.iter().map(|p| p.trim().to_string()).collect();
    // Reject — never drop empty cells (that would shift a composite key).
    if out.iter().any(|p| p.is_empty()) {
        return Err(format!(
            "refused: {ctx} has empty from part (arity {arity}): {parts:?}"
        ));
    }
    Ok(out)
}

fn normalize_entry(entry: &KeyMapEntry, arity: usize) -> Result<KeyMapEntry, String> {
    let parts = normalize_from_parts(&entry.from_parts_eff(), arity, "upsert")?;
    if entry.to.is_empty() {
        return Err(format!("refused: empty to for from {parts:?}"));
    }
    let mut out = entry.clone();
    out.from = parts[0].clone();
    out.from_parts = parts;
    Ok(out)
}

/// Soft-migrate arity-1 `deleted_froms` into parts when `deleted_from_parts` empty.
fn raw_delete_lists(delta: &KeyMapDirtyDelta) -> Vec<Vec<String>> {
    if !delta.deleted_from_parts.is_empty() {
        return delta.deleted_from_parts.clone();
    }
    delta
        .deleted_froms
        .iter()
        .map(|f| vec![f.clone()])
        .collect()
}

/// Build a validated delta. When wire `baselines` is non-empty, every
/// upsert/delete key must have a matching baseline.
pub fn validate_mapping_delta(
    delta: &KeyMapDirtyDelta,
    from_arity: usize,
) -> Result<ValidatedMappingDelta, String> {
    if from_arity == 0 {
        return Err("refused: from_arity must be ≥ 1".into());
    }

    let mut upserts = Vec::with_capacity(delta.upserts.len());
    let mut seen_ups = HashSet::new();
    for e in &delta.upserts {
        let norm = normalize_entry(e, from_arity)?;
        let key = tuple_key(&norm.from_parts_eff());
        if !seen_ups.insert(key) {
            return Err(format!(
                "refused: duplicate upsert from {:?}",
                norm.from_parts_eff()
            ));
        }
        upserts.push(norm);
    }

    let mut deletes = Vec::new();
    let mut seen_del = HashSet::new();
    for raw in raw_delete_lists(delta) {
        let parts = normalize_from_parts(&raw, from_arity, "delete")?;
        let key = tuple_key(&parts);
        if !seen_del.insert(key.clone()) {
            return Err(format!("refused: duplicate delete from {parts:?}"));
        }
        if seen_ups.contains(&key) {
            return Err(format!(
                "refused: from {parts:?} appears in both upserts and deletes"
            ));
        }
        deletes.push(parts);
    }

    let mut baselines: HashMap<String, KeyMapDirtyBaseline> = HashMap::new();
    for b in &delta.baselines {
        let parts = normalize_from_parts(&b.from_parts, from_arity, "baseline")?;
        let key = tuple_key(&parts);
        if baselines.contains_key(&key) {
            return Err(format!("refused: duplicate baseline for {parts:?}"));
        }
        let mut nb = b.clone();
        nb.from_parts = parts;
        baselines.insert(key, nb);
    }

    if !delta.baselines.is_empty() {
        let mut required: HashSet<String> = HashSet::new();
        for e in &upserts {
            required.insert(tuple_key(&e.from_parts_eff()));
        }
        for d in &deletes {
            required.insert(tuple_key(d));
        }
        for key in &required {
            let b = baselines.get(key).ok_or_else(|| {
                let parts: Vec<&str> = key.split('\0').collect();
                format!("refused: missing baseline for from {parts:?}")
            })?;
            let is_delete = deletes.iter().any(|d| tuple_key(d) == *key);
            if is_delete && !b.existed {
                return Err(format!(
                    "refused: delete baseline for {:?} must have existed=true",
                    b.from_parts
                ));
            }
        }
    }

    Ok(ValidatedMappingDelta {
        upserts,
        deletes,
        baselines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upsert(from: &str, to: &str) -> KeyMapEntry {
        KeyMapEntry::pair(from, to)
    }

    fn baseline(from: &str, existed: bool, to: &str) -> KeyMapDirtyBaseline {
        KeyMapDirtyBaseline {
            from_parts: vec![from.into()],
            existed,
            to: to.into(),
            attrs: BTreeMap::new(),
        }
    }

    #[test]
    fn rejects_empty_part_in_composite_delete() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![],
            deleted_froms: vec![],
            deleted_from_parts: vec![vec!["A".into(), "".into()]],
            baselines: vec![KeyMapDirtyBaseline {
                from_parts: vec!["A".into(), "".into()],
                existed: true,
                to: "X".into(),
                attrs: BTreeMap::new(),
            }],
        };
        let err = validate_mapping_delta(&delta, 2).unwrap_err();
        assert!(err.contains("empty from part"), "{err}");
    }

    #[test]
    fn requires_baseline_for_each_key_when_any_present() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![upsert("A", "Y")],
            deleted_froms: vec![],
            deleted_from_parts: vec![],
            baselines: vec![],
        };
        assert!(validate_mapping_delta(&delta, 1).is_ok());

        let delta2 = KeyMapDirtyDelta {
            upserts: vec![upsert("A", "Y")],
            deleted_froms: vec![],
            deleted_from_parts: vec![],
            baselines: vec![baseline("B", true, "X")],
        };
        let err = validate_mapping_delta(&delta2, 1).unwrap_err();
        assert!(err.contains("missing baseline"), "{err}");
    }

    #[test]
    fn soft_migrates_deleted_froms() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![],
            deleted_froms: vec!["A".into()],
            deleted_from_parts: vec![],
            baselines: vec![baseline("A", true, "X")],
        };
        let v = validate_mapping_delta(&delta, 1).unwrap();
        assert_eq!(v.deletes, vec![vec!["A".to_string()]]);
    }

    #[test]
    fn rename_needs_both_baselines() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![upsert("B", "X")],
            deleted_froms: vec![],
            deleted_from_parts: vec![vec!["A".into()]],
            baselines: vec![baseline("A", true, "X"), baseline("B", false, "")],
        };
        let v = validate_mapping_delta(&delta, 1).unwrap();
        assert_eq!(v.deletes.len(), 1);
        assert_eq!(v.upserts.len(), 1);
    }

    #[test]
    fn rejects_upsert_and_delete_same_key() {
        let delta = KeyMapDirtyDelta {
            upserts: vec![upsert("A", "Y")],
            deleted_froms: vec!["A".into()],
            deleted_from_parts: vec![],
            baselines: vec![baseline("A", true, "X")],
        };
        assert!(validate_mapping_delta(&delta, 1)
            .unwrap_err()
            .contains("both upserts and deletes"));
    }
}
