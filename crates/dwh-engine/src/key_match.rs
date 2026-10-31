//! Shared, database-independent key matching. Both entry points return proposals;
//! neither changes a KeyMap or a Join. Memory is bounded by inputs and the index,
//! not by the number of possible pairs.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

const MAX_TOKEN_FREQUENCY: usize = 32;
const MAX_TOKEN_CANDIDATES: usize = 16;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FuzzyPair {
    pub from_key: String,
    pub to_key: String,
    pub score: f64,
    pub edits: u32,
    pub ambiguous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_to_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_score: Option<f64>,
    /// Composite From tuple ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)). Empty → `[from_key]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from_parts: Vec<String>,
}

/// The stored key is never normalized. Only the comparison label is normalized.
#[derive(Debug, Clone)]
pub(crate) struct MatchRecord {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KeyMatchOptions {
    pub score_cutoff: f64,
    pub ambiguity_gap: f64,
}

impl Default for KeyMatchOptions {
    fn default() -> Self {
        Self {
            score_cutoff: 0.88,
            ambiguity_gap: 0.03,
        }
    }
}

impl KeyMatchOptions {
    pub fn validate(self) -> Result<(), String> {
        for (name, value) in [
            ("score_cutoff", self.score_cutoff),
            ("ambiguity_gap", self.ambiguity_gap),
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(format!("{name} must be finite and between 0 and 1"));
            }
        }
        Ok(())
    }
}

/// Join Lens retains its conservative typo guards. Label matching permits equal
/// names with unrelated codes, which is the point of a cross-system KeyMap.
#[derive(Clone, Copy)]
pub(crate) enum MatchPolicy {
    JoinKeyTypos,
    Labels,
}

#[derive(Clone, Copy)]
pub(crate) enum CandidateSearch {
    /// Only used by Join Lens for its already capped 200 × 200 sample.
    Exhaustive,
    /// Rare tokens + bounded exact labels. Recall is not exhaustive.
    Indexed,
}

pub(crate) fn normalize_label(label: &str) -> String {
    label
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalized(label: &str, policy: MatchPolicy) -> String {
    match policy {
        MatchPolicy::JoinKeyTypos => label.trim().to_lowercase(),
        MatchPolicy::Labels => normalize_label(label),
    }
}

/// Retains at most 32 row indices per token/name. Overflowed buckets are kept
/// marked as unusable, so a common label never expands into an all-pairs join.
#[derive(Default)]
struct Bucket {
    rows: Vec<usize>,
    overflow: bool,
}

impl Bucket {
    fn insert(&mut self, row: usize) {
        if self.overflow {
            return;
        }
        if self.rows.len() == MAX_TOKEN_FREQUENCY {
            self.rows.clear();
            self.overflow = true;
        } else {
            self.rows.push(row);
        }
    }

    fn rows(&self) -> &[usize] {
        &self.rows
    }
}

struct CandidateIndex<'a> {
    tokens: HashMap<&'a str, Bucket>,
    exact: HashMap<&'a str, Bucket>,
}

impl<'a> CandidateIndex<'a> {
    fn new(labels: &'a [String]) -> Self {
        let mut index = Self {
            tokens: HashMap::new(),
            exact: HashMap::new(),
        };
        for (row, label) in labels.iter().enumerate() {
            index.exact.entry(label).or_default().insert(row);
            for token in label.split_whitespace().collect::<HashSet<_>>() {
                if token.chars().count() >= 2 {
                    index.tokens.entry(token).or_default().insert(row);
                }
            }
        }
        index
    }

    fn candidates(&self, label: &str) -> Vec<usize> {
        let mut hits = HashMap::<usize, usize>::new();
        for token in label.split_whitespace().collect::<HashSet<_>>() {
            if let Some(bucket) = self.tokens.get(token) {
                for row in bucket.rows() {
                    *hits.entry(*row).or_default() += 1;
                }
            }
        }
        let mut ranked: Vec<_> = hits.into_iter().collect();
        ranked.sort_unstable_by(|(a, ah), (b, bh)| bh.cmp(ah).then(a.cmp(b)));
        let mut rows: Vec<_> = ranked
            .into_iter()
            .take(MAX_TOKEN_CANDIDATES)
            .map(|(row, _)| row)
            .collect();
        if let Some(bucket) = self.exact.get(label) {
            rows.extend_from_slice(bucket.rows());
        }
        rows.sort_unstable();
        rows.dedup();
        rows
    }
}

#[derive(Clone, Copy)]
struct ScoredCandidate {
    row: usize,
    score: f64,
    // Join-key typo guards need distance during ranking. Label matching only
    // needs it for the winning proposal, so defer that quadratic work.
    edits: Option<u32>,
}

fn score_candidate(
    left: &str,
    right: &str,
    row: usize,
    options: KeyMatchOptions,
    policy: MatchPolicy,
) -> Option<ScoredCandidate> {
    let score = strsim::jaro_winkler(left, right);
    if score < options.score_cutoff {
        return None;
    }
    let edits = if let MatchPolicy::JoinKeyTypos = policy {
        let edits = strsim::levenshtein(left, right) as u32;
        let min_len = left.chars().count().min(right.chars().count());
        let max_len = left.chars().count().max(right.chars().count());
        if left == right
            || min_len < 3
            || max_len >= 200
            || (min_len <= 5 && (score < 0.92 || edits > 2))
            || (min_len <= 8 && max_len > min_len * 22 / 10 && score < 0.96)
        {
            return None;
        }
        Some(edits)
    } else {
        None
    };
    Some(ScoredCandidate { row, score, edits })
}

fn best_first(a: &ScoredCandidate, b: &ScoredCandidate, right: &[&MatchRecord]) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then(a.edits.cmp(&b.edits))
        .then_with(|| right[a.row].key.cmp(&right[b.row].key))
}

/// Score one source at a time and retain only its best two eligible targets.
/// Input order does not affect results: indexed candidates use key-sorted rows.
pub(crate) fn match_keys(
    left: &[MatchRecord],
    right: &[MatchRecord],
    options: KeyMatchOptions,
    policy: MatchPolicy,
    search: CandidateSearch,
) -> Vec<FuzzyPair> {
    let mut right: Vec<_> = right.iter().collect();
    right.sort_unstable_by(|a, b| a.key.cmp(&b.key));
    let right_labels: Vec<_> = right.iter().map(|r| normalized(&r.label, policy)).collect();
    let index = match search {
        CandidateSearch::Indexed => Some(CandidateIndex::new(&right_labels)),
        CandidateSearch::Exhaustive => None,
    };
    let mut out = Vec::new();
    for from in left {
        let label = normalized(&from.label, policy);
        if label.is_empty() {
            continue;
        }
        let candidates = match &index {
            Some(index) => index.candidates(&label),
            None => (0..right.len()).collect(),
        };
        let mut best = None;
        let mut runner = None;
        for row in candidates {
            let Some(candidate) = score_candidate(&label, &right_labels[row], row, options, policy)
            else {
                continue;
            };
            if best
                .as_ref()
                .is_none_or(|b| best_first(&candidate, b, &right).is_lt())
            {
                runner = best;
                best = Some(candidate);
            } else if runner
                .as_ref()
                .is_none_or(|b| best_first(&candidate, b, &right).is_lt())
            {
                runner = Some(candidate);
            }
        }
        let Some(best) = best else {
            continue;
        };
        let alternative = runner
            .filter(|r| best.score == r.score || best.score - r.score < options.ambiguity_gap);
        out.push(FuzzyPair {
            from_key: from.key.clone(),
            to_key: right[best.row].key.clone(),
            score: best.score,
            edits: best
                .edits
                .unwrap_or_else(|| strsim::levenshtein(&label, &right_labels[best.row]) as u32),
            ambiguous: alternative.is_some(),
            alt_to_key: alternative.map(|r| right[r.row].key.clone()),
            alt_score: alternative.map(|r| r.score),
            from_parts: vec![],
        });
    }
    out.sort_unstable_by(|a, b| a.from_key.cmp(&b.from_key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(rows: &[(&str, &str)]) -> Vec<MatchRecord> {
        rows.iter()
            .map(|(key, label)| MatchRecord {
                key: (*key).into(),
                label: (*label).into(),
            })
            .collect()
    }

    #[test]
    fn labels_return_codes_allow_many_to_one_and_report_alternative() {
        let left = records(&[
            ("C1", "Кофе Арабика 1001"),
            ("C2", "кофе-арабика 1001"),
            ("C3", "чай 1002"),
            ("C4", "unrelated"),
        ]);
        let right = records(&[
            ("P3", "чай 1002"),
            ("P1", "Кофе Арабика 1001"),
            ("P2", "чай 1002"),
        ]);
        let got = match_keys(
            &left,
            &right,
            KeyMatchOptions::default(),
            MatchPolicy::Labels,
            CandidateSearch::Indexed,
        );
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].to_key, "P1");
        assert_eq!(got[1].to_key, "P1");
        assert!(got[2].ambiguous);
        assert_eq!(got[2].to_key, "P2");
        assert_eq!(got[2].alt_to_key.as_deref(), Some("P3"));
        let mut reversed = right;
        reversed.reverse();
        assert_eq!(
            got,
            match_keys(
                &left,
                &reversed,
                KeyMatchOptions::default(),
                MatchPolicy::Labels,
                CandidateSearch::Indexed
            )
        );
    }

    #[test]
    fn join_policy_rejects_normalization_only_and_short_abbreviations() {
        for (left, right, expected) in [
            ("Widget", "widget", false),
            ("acme", "acme corp", false),
            ("Acme Corporation", "Acme Corp", true),
        ] {
            let got = match_keys(
                &records(&[(left, left)]),
                &records(&[(right, right)]),
                KeyMatchOptions::default(),
                MatchPolicy::JoinKeyTypos,
                CandidateSearch::Exhaustive,
            );
            assert_eq!(!got.is_empty(), expected, "{left} → {right}");
        }
    }

    #[test]
    fn options_and_empty_inputs() {
        for value in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            assert!(KeyMatchOptions {
                score_cutoff: value,
                ..Default::default()
            }
            .validate()
            .is_err());
            assert!(KeyMatchOptions {
                ambiguity_gap: value,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert!(match_keys(
            &[],
            &[],
            KeyMatchOptions::default(),
            MatchPolicy::Labels,
            CandidateSearch::Indexed
        )
        .is_empty());
    }

    #[test]
    fn common_labels_do_not_expand_into_an_unbounded_candidate_set() {
        let labels = vec!["common label".to_string(); 1000];
        assert!(CandidateIndex::new(&labels)
            .candidates("common label")
            .is_empty());
        let labels: Vec<_> = (0..1000)
            .map(|i| format!("recipe {i:06} common label"))
            .collect();
        assert_eq!(
            CandidateIndex::new(&labels).candidates("receipe 000042 common label"),
            vec![42]
        );
    }

    #[test]
    fn equal_best_scores_stay_ambiguous_even_with_zero_gap() {
        let result = match_keys(
            &records(&[("sale", "recipe 1001")]),
            &records(&[("a", "recipe 1001"), ("b", "recipe 1001")]),
            KeyMatchOptions {
                score_cutoff: 1.0,
                ambiguity_gap: 0.0,
            },
            MatchPolicy::Labels,
            CandidateSearch::Indexed,
        );
        assert_eq!(result.len(), 1);
        assert!(result[0].ambiguous);
        assert_eq!(result[0].alt_to_key.as_deref(), Some("b"));
    }

    #[test]
    fn cutoff_and_gap_control_proposals_without_changing_codes() {
        let left = records(&[("sku", "Arabica series 1001")]);
        let right = records(&[
            ("technical-a", "Arabica serie 1001"),
            ("technical-b", "Arabica series 1002"),
        ]);
        let strict = match_keys(
            &left,
            &right,
            KeyMatchOptions {
                score_cutoff: 1.0,
                ..Default::default()
            },
            MatchPolicy::Labels,
            CandidateSearch::Exhaustive,
        );
        assert!(strict.is_empty());
        let loose = match_keys(
            &left,
            &right,
            KeyMatchOptions {
                ambiguity_gap: 1.0,
                ..Default::default()
            },
            MatchPolicy::Labels,
            CandidateSearch::Exhaustive,
        );
        assert_eq!(loose[0].from_key, "sku");
        assert!(loose[0].ambiguous);
    }
}
