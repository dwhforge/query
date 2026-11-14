use super::*;

fn parts(values: &[&str]) -> Vec<Option<String>> {
    values.iter().map(|value| Some((*value).into())).collect()
}

fn cte(name: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let select = if rows.is_empty() {
        format!(
            "SELECT {} WHERE FALSE",
            columns
                .iter()
                .map(|column| { format!("NULL::VARCHAR AS {}", quote_ident(column)) })
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        let rows = rows
            .iter()
            .map(|row| {
                format!(
                    "({})",
                    row.iter()
                        .map(|part| {
                            part.as_ref()
                                .map(|value| format!("'{}'", escape_sql_string(value)))
                                .unwrap_or_else(|| "NULL".into())
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "SELECT * FROM (VALUES {rows}) v({})",
            columns
                .iter()
                .map(|c| quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!("{name} AS ({select})")
}

fn retrieve(
    left: &[Vec<Option<String>>],
    right: &[Vec<Option<String>>],
    width: usize,
    source_parts: Option<Vec<Option<String>>>,
) -> JoinTupleReport {
    let left_on: Vec<_> = (0..width).map(|i| format!("left_{i}")).collect();
    let right_on: Vec<_> = (0..width).map(|i| format!("right_{i}")).collect();
    let compiled = CompiledCtes {
        definitions: format!(
            "{}, {}",
            cte("left_input", &left_on, left),
            cte("right_input", &right_on, right)
        ),
        last_by_query: Default::default(),
    };
    let db = DbSession::new().unwrap();
    let response = join_key_fuzzy_suggest_tuple(
        &db,
        &compiled,
        "left_input",
        "right_input",
        "host",
        1,
        &left_on,
        &right_on,
        JoinTupleRequest { source_parts },
    )
    .unwrap();
    assert_eq!(response.left_on, left_on);
    assert_eq!(response.right_on, right_on);
    assert!(
        response.suggestions.is_empty(),
        "tuple retrieval must not produce scalar Apply proposals"
    );
    let json = serde_json::to_value(&response).unwrap();
    let roundtrip: JoinKeyFuzzySuggest = serde_json::from_value(json).unwrap();
    assert_eq!(response.tuple_report, roundtrip.tuple_report);
    response.tuple_report.unwrap()
}

#[test]
fn full_tuple_one_through_five_keys_score_every_field_and_keep_all_real_alternatives() {
    for width in 1..=5 {
        let tuple = |label: &str| {
            (0..width)
                .map(|i| Some(format!("{label} {i}")))
                .collect::<Vec<_>>()
        };
        let source = tuple("Acme Corporation");
        let first = tuple("Acme Corporatoin");
        let second = tuple("Acme Corporaton");
        let unrelated = tuple("Unrelated ZZZ");
        let left = vec![source.clone(), source.clone(), first.clone()];
        let right = vec![
            unrelated.clone(),
            second.clone(),
            first.clone(),
            first.clone(),
        ];
        let report = retrieve(&left, &right, width, None);
        assert_eq!(report.left_distinct_total, 1);
        assert_eq!(report.left_occurrences_total, 2);
        assert_eq!(report.right_distinct_total, 3);
        assert_eq!(report.right_occurrences_total, 4);
        assert_eq!(report.sources.len(), 1);
        assert_eq!(report.sources[0].source.parts, source);
        let candidates = &report.sources[0].candidates;
        assert_eq!(
            candidates.len(),
            3,
            "manual universe must include low scores too"
        );
        for candidate in candidates {
            let target = &report.right_universe[candidate.right_index];
            assert!(
                right.contains(&target.parts),
                "no synthetic Cartesian tuples"
            );
            assert_eq!(candidate.field_scores.len(), width);
            let mean = candidate
                .field_scores
                .iter()
                .map(|score| score.unwrap())
                .sum::<f64>()
                / width as f64;
            assert!((candidate.score.unwrap() - mean).abs() < 1e-12);
            for (i, score) in candidate.field_scores.iter().enumerate() {
                let expected = strsim::jaro_winkler(
                    &source[i].as_ref().unwrap().to_lowercase(),
                    &target.parts[i].as_ref().unwrap().to_lowercase(),
                );
                assert!((score.unwrap() - expected).abs() < 1e-12);
            }
            if target.parts == first || target.parts == second {
                assert!(
                    candidate.score.unwrap() >= SCORE_CUTOFF,
                    "multi-field fuzzy alternatives must survive: {candidate:?}"
                );
            }
            assert_eq!(
                target.occurrences,
                if target.parts == first { 2 } else { 1 }
            );
        }
        assert!(!report.left_truncated && !report.right_truncated);
        let mut reverse_left = left;
        let mut reverse_right = right;
        reverse_left.reverse();
        reverse_right.reverse();
        assert_eq!(report, retrieve(&reverse_left, &reverse_right, width, None));
    }
}

#[test]
fn full_tuple_null_empty_literal_and_separator_identities_stay_distinct() {
    let null = vec![None, Some("x".into())];
    let empty = parts(&["", "x"]);
    let literal = parts(&["∅", "x"]);
    // Same rendered label, different real tuples.
    let separator_left = parts(&["a · b", "c"]);
    let separator_right = parts(&["a", "b · c"]);
    let right = vec![
        null.clone(),
        null.clone(),
        empty.clone(),
        literal.clone(),
        separator_left.clone(),
        separator_right.clone(),
    ];
    let left = vec![
        empty.clone(),
        literal.clone(),
        separator_left,
        separator_right,
        null.clone(),
    ];
    let report = retrieve(&left, &right, 2, None);
    assert_eq!(report.right_distinct_total, 5);
    assert_eq!(report.right_occurrences_total, 6);
    assert_eq!(
        report.sources.len(),
        1,
        "SQL NULLs do not join, empty/literal values do"
    );
    assert_eq!(report.sources[0].source.parts, null);
    assert_eq!(report.right_universe[0].parts, null);
    assert_eq!(report.right_universe[0].occurrences, 2);
    assert_eq!(report.sources[0].candidates[0].score, Some(1.0));
    for value in [empty, literal] {
        let candidate = report.sources[0]
            .candidates
            .iter()
            .find(|candidate| report.right_universe[candidate.right_index].parts == value)
            .unwrap();
        assert_eq!(candidate.field_scores, vec![Some(0.0), Some(1.0)]);
        assert_eq!(candidate.score, Some(0.5));
    }
    let json = serde_json::to_value(&report).unwrap();
    assert!(json["right_universe"][0]["parts"][0].is_null());
    assert!(report
        .right_universe
        .iter()
        .any(|tuple| tuple.parts[0].as_deref() == Some("")));
    assert!(report
        .right_universe
        .iter()
        .any(|tuple| tuple.parts[0].as_deref() == Some("∅")));
}

#[test]
fn full_tuple_counts_truncation_and_focus_beyond_left_cap() {
    let left = (0..KEY_SCAN_CAP + 5)
        .map(|i| parts(&[&format!("left-{i:04}")]))
        .collect::<Vec<_>>();
    let mut right = (0..KEY_SCAN_CAP + 7)
        .map(|i| parts(&[&format!("right-{i:04}")]))
        .collect::<Vec<_>>();
    right.push(right[0].clone());
    let report = retrieve(&left, &right, 1, None);
    assert_eq!(report.left_distinct_total, (KEY_SCAN_CAP + 5) as u64);
    assert_eq!(report.right_distinct_total, (KEY_SCAN_CAP + 7) as u64);
    assert_eq!(report.right_occurrences_total, (KEY_SCAN_CAP + 8) as u64);
    assert_eq!(report.sources.len(), KEY_SCAN_CAP);
    assert_eq!(report.right_universe.len(), KEY_SCAN_CAP);
    assert!(report.left_truncated && report.right_truncated);
    assert!(report
        .sources
        .iter()
        .all(|source| source.candidates.len() == KEY_SCAN_CAP));
    let focus = left.last().unwrap().clone();
    assert!(!report
        .sources
        .iter()
        .any(|source| source.source.parts == focus));
    let focused = retrieve(&left, &right, 1, Some(focus.clone()));
    assert_eq!(focused.left_distinct_total, 1);
    assert_eq!(focused.left_occurrences_total, 1);
    assert!(!focused.left_truncated && focused.right_truncated);
    assert_eq!(focused.sources[0].source.parts, focus);
}

#[test]
fn full_tuple_focus_is_exact_null_safe_and_sql_escaped() {
    let quoted = parts(&["x' OR TRUE --"]);
    let null = vec![None];
    let left = vec![
        parts(&["unrelated"]),
        quoted.clone(),
        quoted.clone(),
        null.clone(),
    ];
    let right = vec![quoted.clone()];
    let focused = retrieve(&left, &right, 1, Some(quoted.clone()));
    assert_eq!(focused.sources.len(), 1);
    assert_eq!(focused.sources[0].source.parts, quoted);
    assert_eq!(focused.sources[0].source.occurrences, 2);
    let focused_null = retrieve(&left, &right, 1, Some(null.clone()));
    assert_eq!(focused_null.sources[0].source.parts, null);
    let missing = retrieve(&left, &right, 1, Some(parts(&["not present"])));
    assert!(missing.sources.is_empty());
    assert_eq!(missing.left_distinct_total, 0);
}

#[test]
fn full_tuple_keeps_overlong_values_unscored_and_empty_universes_honest() {
    let source = parts(&["short"]);
    let long = vec![Some("z".repeat(MAX_KEY_CHARS + 1))];
    let report = retrieve(
        &[source.clone()],
        &[long.clone(), parts(&["shorter"])],
        1,
        None,
    );
    assert_eq!(report.right_distinct_total, 2);
    let candidates = &report.sources[0].candidates;
    assert!(candidates[0].score.is_some());
    assert_eq!(candidates[1].score, None);
    assert_eq!(candidates[1].field_scores, vec![None]);
    assert_eq!(report.right_universe[candidates[1].right_index].parts, long);
    let empty_right = retrieve(&[source], &[], 1, None);
    assert_eq!(empty_right.right_distinct_total, 0);
    assert_eq!(empty_right.right_occurrences_total, 0);
    assert!(empty_right.sources[0].candidates.is_empty());
    let empty_left = retrieve(&[], &[parts(&["right"])], 1, None);
    assert!(empty_left.sources.is_empty());
    assert_eq!(empty_left.left_distinct_total, 0);
    assert_eq!(empty_left.right_universe.len(), 1);
}

#[test]
fn full_tuple_unmatched_scope_uses_join_equality_not_display_cast_equality() {
    let db = DbSession::new().unwrap();
    let compiled = CompiledCtes {
        definitions: "left_input AS (SELECT 1 AS id), right_input AS (SELECT '01' AS code)".into(),
        last_by_query: Default::default(),
    };
    let response = join_key_fuzzy_suggest_tuple(
        &db,
        &compiled,
        "left_input",
        "right_input",
        "host",
        1,
        &["id".into()],
        &["code".into()],
        JoinTupleRequest::default(),
    )
    .unwrap();
    let report = response.tuple_report.unwrap();
    assert!(
        report.sources.is_empty(),
        "DuckDB Join equality matches integer 1 to string 01"
    );
    assert_eq!(report.left_distinct_total, 0);
    assert_eq!(report.right_universe[0].parts, parts(&["01"]));
}
