//! Existing wire command integration: tuple retrieval is opt-in and read-only.
use dwh_engine::{JoinKeyFuzzySuggest, JoinTupleReport};
use dwh_host::api::HostState;
use dwh_pipeline::{JoinType, QueryDef, TransformationStep, Workspace};
use serde_json::{json, Value};
use std::fs;

#[test]
fn real_basic_fractional_scores_survive_rpc_roundtrip() {
    let root = std::env::temp_dir().join(format!("dwh-basic-wire-f64-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let left = root.join("left.csv"); let right = root.join("right.csv");
    fs::write(&left, "company,country\nAcme Corporaton,United Kingdm\nBeacon Industris,United Stats\nZXQ legacy,ZZ\n").unwrap();
    fs::write(&right, "legal_name,nation\nAcme Corporation,United Kingdom\nBeacon Industries,United States\nOrion Holdings,Canada\n").unwrap();
    let host = HostState::new().unwrap();
    let args = json!({"workspace":{"focus_query_id":"fact", "key_maps":[], "queries":[
        {"id":"fact","name":"fact","steps":[{"type":"LoadCsv","payload":{"path":left}},
            {"type":"Join","payload":{"right_query_id":"dim","join_type":"left","left_on":["company","country"],"right_on":["legal_name","nation"]}}]},
        {"id":"dim","name":"dim","steps":[{"type":"LoadCsv","payload":{"path":right}}]}
    ]}, "hostQueryId":"fact", "joinStepIndex":1, "tuple":{}});
    let reply = host.dispatch("join_key_fuzzy_suggest", args).unwrap();
    let original: JoinTupleReport = serde_json::from_value(reply["tuple_report"].clone()).unwrap();
    let wire: JoinTupleReport = serde_json::from_str(&serde_json::to_string(&reply["tuple_report"]).unwrap()).unwrap();
    assert_eq!(original, wire, "Host must preserve fractional score evidence through JSON; no epsilon changes to tuple validation");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn existing_suggest_wire_supports_full_tuples_and_preserves_legacy_auto() {
    let root = std::env::temp_dir().join(format!("dwh-tuple-wire-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let host = HostState::new().unwrap();
    for width in 1..=5 {
        let left_on = (0..width).map(|i| format!("left_{i}")).collect::<Vec<_>>();
        let right_on = (0..width).map(|i| format!("right_{i}")).collect::<Vec<_>>();
        let row = |label: &str| {
            (0..width)
                .map(|i| format!("{label} {i}"))
                .collect::<Vec<_>>()
                .join(",")
        };
        let left_path = root.join(format!("left-{width}.csv"));
        let right_path = root.join(format!("right-{width}.csv"));
        fs::write(
            &left_path,
            format!(
                "{}\n{}\n{}\n{}\n",
                left_on.join(","),
                row("Acme Corporation"),
                row("Exact"),
                row("Unrelated")
            ),
        )
        .unwrap();
        fs::write(
            &right_path,
            format!(
                "{}\n{}\n{}\n{}\n",
                right_on.join(","),
                row("Acme Corp"),
                row("Acme Corp"),
                row("Exact")
            ),
        )
        .unwrap();
        let workspace = Workspace {
            queries: vec![
                QueryDef {
                    id: "fact".into(),
                    name: "fact".into(),
                    execution: Default::default(),
                    steps: vec![
                        TransformationStep::LoadCsv {
                            path: left_path.to_string_lossy().into(),
                            path_kind: Default::default(),
                        },
                        TransformationStep::Join {
                            right_query_id: "dim".into(),
                            join_type: JoinType::Left,
                            left_on: left_on.clone(),
                            right_on: right_on.clone(),
                        },
                    ],
                },
                QueryDef {
                    id: "dim".into(),
                    name: "dim".into(),
                    execution: Default::default(),
                    steps: vec![TransformationStep::LoadCsv {
                        path: right_path.to_string_lossy().into(),
                        path_kind: Default::default(),
                    }],
                },
            ],
            focus_query_id: "fact".into(),
            key_maps: vec![],
        };
        let original = serde_json::to_value(&workspace).unwrap();
        let args = json!({"workspace": workspace, "hostQueryId": "fact", "joinStepIndex": 1});
        let legacy = host
            .dispatch("join_key_fuzzy_suggest", args.clone())
            .unwrap();
        assert!(legacy.get("tuple_report").is_none());
        let legacy_decoded: JoinKeyFuzzySuggest = serde_json::from_value(legacy.clone()).unwrap();
        assert!(
            legacy_decoded.tuple_report.is_none(),
            "old response shape must still deserialize"
        );
        if width > 1 {
            assert!(legacy["disabled_reason"]
                .as_str()
                .unwrap()
                .contains("per-column"));
        } else {
            assert!(!legacy["suggestions"].as_array().unwrap().is_empty());
        }
        let source = (0..width)
            .map(|i| Some(format!("Acme Corporation {i}")))
            .collect::<Vec<_>>();
        let mut focused_args = args.clone();
        focused_args["tuple"] = json!({"source_parts": source});
        let result = host
            .dispatch("join_key_fuzzy_suggest", focused_args.clone())
            .unwrap();
        let report: JoinTupleReport =
            serde_json::from_value(result["tuple_report"].clone()).unwrap();
        assert_eq!(result["left_on"], json!(left_on));
        assert_eq!(result["right_on"], json!(right_on));
        assert_eq!(report.left_distinct_total, 1);
        assert_eq!(report.sources[0].source.parts, source);
        assert_eq!(report.right_distinct_total, 2);
        assert_eq!(report.right_occurrences_total, 3);
        assert_eq!(report.sources[0].candidates.len(), 2);
        let best = &report.sources[0].candidates[0];
        assert!(best.score.unwrap() >= 0.88);
        assert_eq!(best.field_scores.len(), width);
        assert_eq!(report.right_universe[best.right_index].occurrences, 2);
        assert_eq!(
            args["workspace"], original,
            "retrieval must not rewrite the workspace"
        );

        let mut all_args = args.clone();
        all_args["tuple"] = json!({});
        let all = host.dispatch("join_key_fuzzy_suggest", all_args.clone()).unwrap();
        assert_eq!(all["tuple_report"]["left_distinct_total"], 2);

        // ADR-0051: direct API calls must re-acquire real tuples, not trust bodies.
        let run_id = "session:run1";
        let target = &report.right_universe[best.right_index].parts;
        let mut verified_args = all_args.clone();
        verified_args["verification"] = json!({"sessionId": "session", "runId": run_id,
            "semanticRevision": 1, "expectedSemanticRevision": 1, "evidenceRevision": 1,
            "expectedReport": all["tuple_report"], "decisions": [{
                "candidateId": serde_json::to_string(&json!([run_id, target])).unwrap(),
                "sourceParts": source, "outputValues": target, "runId": run_id, "evidenceRevision": 1
            }]});
        let verified = host.dispatch("matching_verify_join_tuples", verified_args.clone()).unwrap();
        assert_eq!(verified["materialized"][0]["outputValues"], json!(target));
        assert_eq!(args["workspace"], original, "verification is read-only");
        // Exercise real RPC number decoding, not only in-memory serde Values.
        let wire_args: Value = serde_json::from_str(&serde_json::to_string(&verified_args).unwrap()).unwrap();
        assert!(host.dispatch("matching_verify_join_tuples", wire_args).is_ok());
        let mut js_numbers = verified_args.clone();
        for group in js_numbers["verification"]["expectedReport"]["sources"].as_array_mut().unwrap() {
            for candidate in group["candidates"].as_array_mut().unwrap() {
                if candidate["score"].as_f64() == Some(0.0) { candidate["score"] = json!(0); }
                for score in candidate["field_scores"].as_array_mut().unwrap() {
                    if score.as_f64() == Some(0.0) { *score = json!(0); }
                    else if score.as_f64() == Some(1.0) { *score = json!(1); }
                }
            }
        }
        assert!(host.dispatch("matching_verify_join_tuples", js_numbers).is_ok());
        for (field, value) in [
            ("candidateId", json!("unknown")), ("outputValues", json!(vec!["invented"; width])),
            ("sourceParts", json!(vec!["wrong-source"; width])), ("runId", json!("session:old")),
            ("evidenceRevision", json!(2)),
        ] {
            let mut bad = verified_args.clone();
            bad["verification"]["decisions"][0][field] = value;
            assert!(host.dispatch("matching_verify_join_tuples", bad).is_err(), "must reject {field}");
        }
        for (field, value) in [("sessionId", json!("other-session")), ("expectedSemanticRevision", json!(2))] {
            let mut bad = verified_args.clone(); bad["verification"][field] = value;
            assert!(host.dispatch("matching_verify_join_tuples", bad).is_err());
        }
        let mut bad = verified_args.clone();
        bad["verification"]["expectedReport"]["right_universe"][0]["parts"][0] = json!("mutated-evidence");
        assert!(host.dispatch("matching_verify_join_tuples", bad).is_err());

        let mut per_column = args.clone();
        per_column["keyIndex"] = json!(0);
        let old_per_column = host.dispatch("join_key_fuzzy_suggest", per_column).unwrap();
        assert!(old_per_column.get("tuple_report").is_none());
        assert!(!old_per_column["suggestions"].as_array().unwrap().is_empty());

        focused_args["keyIndex"] = json!(0);
        assert!(host
            .dispatch("join_key_fuzzy_suggest", focused_args.clone())
            .is_err());
        focused_args.as_object_mut().unwrap().remove("keyIndex");
        focused_args["tuple"] = json!({"source_parts": []});
        assert!(host
            .dispatch("join_key_fuzzy_suggest", focused_args.clone())
            .is_err());
        focused_args["tuple"] = json!({"unknown_option": true});
        assert!(host
            .dispatch("join_key_fuzzy_suggest", focused_args)
            .is_err());

        // An explicit null is equivalent to omission, as with other optional args.
        let mut null_args = args;
        null_args["tuple"] = Value::Null;
        assert!(host
            .dispatch("join_key_fuzzy_suggest", null_args)
            .unwrap()
            .get("tuple_report")
            .is_none());
    }
    fs::remove_dir_all(root).unwrap();
}
