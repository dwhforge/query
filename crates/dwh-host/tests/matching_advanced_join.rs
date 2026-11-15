//! Real DuckDB Host acquisition/verification; run serially (native engine).
use dwh_host::api::HostState;
use dwh_pipeline::{KeyMapDef, KeyMapEntry};
use serde_json::{json, Value};

fn args(left: &str, right: &str) -> Value {
    json!({"workspace":{"focus_query_id":"fact", "key_maps":[], "queries":[
        {"id":"fact","name":"fact","steps":[{"type":"SqlModel","payload":{"raw_sql":left}},
            {"type":"Join","payload":{"right_query_id":"dim","join_type":"left","left_on":["key"],"right_on":["out"]}}]},
        {"id":"dim","name":"dim","steps":[{"type":"SqlModel","payload":{"raw_sql":right}}]}
    ]}, "queryId":"fact", "joinIndex":1, "sessionId":"advanced", "runId":"advanced:1",
        "evidenceRevision":7, "mode":"trial", "scope":"unmatched",
        "plan":{"sourceRef":"fact", "targetRef":"dim", "mapKeyFields":["key"],
            "targetIdentityFields":["id"], "outputs":["out"], "normalization":["trim","lower"],
            "comparisons":[{"sourceField":"name","targetField":"label","role":"soft_signal"},
                {"sourceField":"region","targetField":"region","role":"hard_constraint"},
                {"sourceField":"note","targetField":"note","role":"reference_context"}],
            "ambiguity":"leave_for_manual", "scope":"full", "semanticRevision":3, "uiRevision":0}})
}

fn simple() -> Value {
    args("select 'legacy' as key, 'Acme Corporation' as name, 'UK' as region, 'left note' as note",
        "select 'vendor-1' as id, 'canonical' as out, 'Acme Corporation' as label, 'UK' as region, 'right note' as note")
}

fn verify_args(mut args: Value, snapshot: &Value) -> Value {
    let candidate = &snapshot["retrieval"]["candidates"][0];
    args["verification"] = json!({"expectedSemanticRevision":args["plan"]["semanticRevision"],
        "expectedSnapshot":snapshot, "decisions":[{"candidateId":candidate["candidateId"],
            "sourceParts":snapshot["acquisition"]["sourceRows"][0]["mapKey"],
            "outputValues":candidate["outputValues"], "runId":args["runId"],
            "evidenceRevision":args["evidenceRevision"]}]});
    args
}

fn refuse(host: &HostState, args: Value, contains: &str) {
    let error = host.dispatch("matching_acquire_join", args).unwrap_err();
    assert!(error.message().contains(contains), "{}", error.message());
}

#[test]
fn real_fields_identity_outputs_occurrences_and_contextual_verification() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    let left = a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"]
        .as_str()
        .unwrap()
        .to_owned();
    a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] =
        json!(format!("{left} UNION ALL {left}"));
    let right = a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"]
        .as_str()
        .unwrap()
        .to_owned();
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] =
        json!(format!("{right} UNION ALL {right}"));
    let before = a.clone();
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        snapshot["acquisition"]["sourceRows"][0]["affectedSourceRows"],
        2
    );
    assert_eq!(snapshot["acquisition"]["targetRows"][0]["occurrences"], 2);
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["identityValues"],
        json!(["vendor-1"])
    );
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["outputValues"],
        json!(["canonical"])
    );
    assert_eq!(
        snapshot["acquisition"]["sourceRows"][0]["fields"]["note"],
        "left note"
    );
    let pid = snapshot["retrieval"]["proposals"][0]["proposalId"]
        .as_str()
        .unwrap();
    assert_eq!(
        snapshot["retrieval"]["candidateScoresByProposal"][pid][0]["fieldScores"],
        json!([1.0, null, null])
    );
    let request = verify_args(a.clone(), &snapshot);
    // JSON transport, including typed numeric score equality.
    let wire = serde_json::from_str(&serde_json::to_string(&request).unwrap()).unwrap();
    let verified = host
        .dispatch("matching_verify_join_candidates", wire)
        .unwrap();
    assert_eq!(
        verified["materialized"][0]["sourceParts"],
        json!(["legacy"])
    );
    assert_eq!(
        verified["materialized"][0]["outputValues"],
        json!(["canonical"])
    );
    assert_eq!(a, before, "read-only; no Mapping or graph publication");
    assert!(HostState::is_heavy_rpc("matching_acquire_join"));
    assert!(HostState::is_heavy_rpc("matching_verify_join_candidates"));
}

#[test]
fn direct_forgery_mutations_and_stale_revisions_are_refused() {
    let host = HostState::new().unwrap();
    let a = simple();
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    let good = verify_args(a, &snapshot);
    let mutations = [
        ("/verification/decisions/0/candidateId", json!("unknown")),
        ("/verification/decisions/0/outputValues", json!(["forged"])),
        ("/verification/decisions/0/sourceParts", json!(["unknown"])),
        ("/verification/decisions/0/runId", json!("another:run")),
        ("/verification/decisions/0/evidenceRevision", json!(8)),
        ("/verification/expectedSemanticRevision", json!(4)),
        (
            "/verification/expectedSnapshot/acquisition/sourceRows/0/fields/note",
            json!("invented"),
        ),
        (
            "/verification/expectedSnapshot/acquisition/targetRows/0/fields/note",
            json!("invented"),
        ),
        (
            "/verification/expectedSnapshot/retrieval/candidates/0/outputValues",
            json!(["invented"]),
        ),
        ("/verification/expectedSnapshot/sessionId", json!("other")),
        (
            "/verification/expectedSnapshot/runId",
            json!("advanced:old"),
        ),
    ];
    for (pointer, value) in mutations {
        let mut forged = good.clone();
        *forged.pointer_mut(pointer).unwrap() = value;
        assert!(
            host.dispatch("matching_verify_join_candidates", forged)
                .is_err(),
            "accepted {pointer}"
        );
    }
    let pid = snapshot["retrieval"]["proposals"][0]["proposalId"]
        .as_str()
        .unwrap();
    let mut forged = good.clone();
    forged["verification"]["expectedSnapshot"]["retrieval"]["candidateScoresByProposal"][pid][0]
        ["fieldScores"][0] = json!(0.123);
    assert!(host
        .dispatch("matching_verify_join_candidates", forged)
        .is_err());
    let mut duplicate = good.clone();
    duplicate["verification"]["decisions"] = json!([
        good["verification"]["decisions"][0],
        good["verification"]["decisions"][0]
    ]);
    assert!(host
        .dispatch("matching_verify_join_candidates", duplicate)
        .is_err());
    let mut wrong_shape = good;
    wrong_shape["plan"]["outputs"] = json!(["id"]);
    assert!(host
        .dispatch("matching_verify_join_candidates", wrong_shape)
        .is_err());
}

#[test]
fn actual_prejoin_transforms_and_consumed_right_output_are_authoritative() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    let source = json!({"id":"base","name":"base","steps":[{"type":"SqlModel","payload":{"raw_sql":
        "select 'old' as key, ' Acme Corporation ' as raw_name, 'UK' as raw_region, 'source' as note, true as keep union all select 'discard', 'bad', 'DE', 'discarded', false"}}]});
    a["workspace"]["queries"]
        .as_array_mut()
        .unwrap()
        .push(source);
    a["workspace"]["queries"][0]["steps"] = json!([
        {"type":"FromQuery","payload":{"query_id":"base"}},
        {"type":"Filter","payload":{"condition":"keep"}},
        {"type":"RenameColumn","payload":{"from":"raw_name","to":"name"}},
        {"type":"NormalizeKey","payload":{"columns":["name"],"ops":["trim"]}},
        {"type":"DeriveColumn","payload":{"name":"region","expression":"upper(raw_region)"}},
        {"type":"ApplyKeyMap","payload":{"column":"key","map_id":"prior_map","entries":[{"from":"old","to":"mapped-key"}]}},
        {"type":"Join","payload":{"right_query_id":"dim","join_type":"left","left_on":["key"],"right_on":["out"]}}
    ]);
    let mut map = KeyMapDef::new("prior_map", "prior");
    map.from_column = "key".into();
    map.to_column = "out".into();
    map.entries = vec![KeyMapEntry::pair("old", "mapped-key")];
    a["workspace"]["key_maps"] = json!([map]);
    a["joinIndex"] = json!(6);
    a["plan"]["sourceRef"] = json!("base"); // guidance must not skip transforms
    a["workspace"]["queries"][1]["steps"].as_array_mut().unwrap().push(json!({"type":"DeriveColumn","payload":{"name":"extra","expression":"'right transformed'"}}));
    a["plan"]["comparisons"][2]["targetField"] = json!("extra");
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    let rows = snapshot["acquisition"]["sourceRows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["mapKey"], json!(["mapped-key"]));
    assert_eq!(rows[0]["fields"]["name"], "Acme Corporation");
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["fields"]["extra"],
        "right transformed"
    );
    assert!(host
        .dispatch("matching_verify_join_candidates", verify_args(a, &snapshot))
        .is_ok());
}

#[test]
fn refuses_conflicting_source_context_and_target_identity_collisions() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] = json!("select 'same' as key, 'Acme' as name, 'UK' as region, 'a' as note union all select 'same', 'Acme', 'UK', 'b'");
    refuse(&host, a, "conflicting source context");
    let mut a = simple();
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!("select 'id' as id, 'one' as out, 'Acme' as label, 'UK' as region, 'a' as note union all select 'id', 'two', 'Acme', 'UK', 'a'");
    refuse(&host, a, "identity collision");
    let mut a = simple();
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!("select 'id' as id, 'one' as out, 'Acme' as label, 'UK' as region, 'a' as note union all select 'id', 'one', 'Acme', 'UK', 'b'");
    refuse(&host, a, "identity collision");
}

#[test]
fn null_missing_and_unsupported_semantics_refuse_without_empty_coercion() {
    let host = HostState::new().unwrap();
    for field in ["key", "name", "region", "note"] {
        let mut a = simple();
        let select = ["key", "name", "region", "note"]
            .iter()
            .map(|f| {
                if *f == field {
                    format!("NULL::VARCHAR AS {f}")
                } else {
                    format!("'value' AS {f}")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] =
            json!(format!("SELECT {select}"));
        refuse(&host, a, "NULL");
    }
    for field in ["id", "out", "label", "region", "note"] {
        let mut a = simple();
        let select = ["id", "out", "label", "region", "note"]
            .iter()
            .map(|f| {
                if *f == field {
                    format!("NULL::VARCHAR AS {f}")
                } else {
                    format!("'value' AS {f}")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] =
            json!(format!("SELECT {select}"));
        refuse(&host, a, "NULL");
    }
    let mut a = simple();
    a["plan"]["comparisons"][0]["sourceField"] = json!("missing");
    refuse(&host, a, "unavailable");
    let mut a = simple();
    a["plan"]["comparisons"][0]["targetField"] = json!("missing");
    refuse(&host, a, "unavailable");
    let mut a = simple();
    a["plan"]["normalization"] = json!(["made_up"]);
    refuse(&host, a, "unsupported normalization");
}

#[test]
fn sql_caps_are_enforced_for_trial_mass_and_raw_target_rows() {
    let host = HostState::new().unwrap();
    for (mode, count, cap) in [("trial", 20, 20), ("mass", 200, 200)] {
        let mut a = simple();
        a["mode"] = json!(mode);
        a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] = json!(format!("select i::varchar as key, 'Acme Corporation' as name, 'UK' as region, 'note' as note from range({count}) t(i)"));
        let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
        assert_eq!(
            snapshot["acquisition"]["sourceRows"]
                .as_array()
                .unwrap()
                .len(),
            cap
        );
        a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] = json!(format!("select i::varchar as key, 'Acme Corporation' as name, 'UK' as region, 'note' as note from range({}) t(i)",count+1));
        refuse(&host, a, "source key/context groups exceed");
    }
    let mut a = simple();
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!("select 'same-id' as id, 'canonical' as out, 'Acme Corporation' as label, 'UK' as region, 'note' as note from range(10000)");
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(snapshot["acquisition"]["targetOccurrences"], 10000);
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["occurrences"],
        10000
    );
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!("select 'same-id' as id, 'canonical' as out, 'Acme Corporation' as label, 'UK' as region, 'note' as note from range(10001)");
    refuse(&host, a, "target exceeds local cap");
}

#[test]
fn unmatched_all_selected_and_cohort_scopes_are_honest() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] = json!("select 'legacy' as key, 'Acme Corporation' as name, 'UK' as region, 'note' as note union all select 'canonical','Acme Corporation','UK','note'");
    let unmatched = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        unmatched["acquisition"]["sourceRows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    a["scope"] = json!("all");
    let all = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        all["acquisition"]["sourceRows"].as_array().unwrap().len(),
        2
    );
    a["plan"]["scope"] = json!("selected");
    refuse(&host, a.clone(), "unsupported scope");
    a["sourceParts"] = json!(["canonical"]);
    let selected = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        selected["acquisition"]["sourceRows"][0]["mapKey"],
        json!(["canonical"])
    );
    a["plan"]["scope"] = json!("cohort");
    refuse(&host, a, "cohort is unavailable");
}

#[test]
fn contextual_constraints_not_basic_fuzzy_authorize_selection() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!("select 'id' as id, 'canonical' as out, 'Acme Corporation' as label, 'DE' as region, 'note' as note");
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        snapshot["retrieval"]["proposals"][0]["state"],
        "no_candidates"
    );
    assert!(
        host.dispatch("matching_verify_join_candidates", verify_args(a, &snapshot))
            .is_err(),
        "real target with failed hard constraint cannot be committed"
    );
}

#[test]
fn fresh_csv_reacquisition_rejects_changed_context_without_using_preview_or_prepare_cache() {
    let root = std::env::temp_dir().join(format!("dwh-advanced-fresh-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let left = root.join("left.csv");
    let right = root.join("right.csv");
    std::fs::write(
        &left,
        "key,name,region,note\nlegacy,Acme Corporation,UK,old source\n",
    )
    .unwrap();
    std::fs::write(
        &right,
        "id,out,label,region,note\nvendor-1,canonical,Acme Corporation,UK,old target\n",
    )
    .unwrap();
    let host = HostState::new().unwrap();
    let mut a = simple();
    a["workspace"]["queries"][0]["steps"][0] = json!({"type":"LoadCsv","payload":{"path":left}});
    a["workspace"]["queries"][1]["steps"][0] = json!({"type":"LoadCsv","payload":{"path":right}});
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    let request = verify_args(a, &snapshot);
    assert!(host
        .dispatch("matching_verify_join_candidates", request.clone())
        .is_ok());
    std::fs::write(
        &right,
        "id,out,label,region,note\nvendor-1,canonical,Acme Corporation,UK,new target\n",
    )
    .unwrap();
    assert!(host
        .dispatch("matching_verify_join_candidates", request.clone())
        .is_err());
    std::fs::write(
        &right,
        "id,out,label,region,note\nvendor-1,canonical,Acme Corporation,UK,old target\n",
    )
    .unwrap();
    std::fs::write(
        &left,
        "key,name,region,note\nlegacy,Acme Corporation,UK,new source\n",
    )
    .unwrap();
    assert!(host
        .dispatch("matching_verify_join_candidates", request)
        .is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn composite_keys_and_identities_are_exact_structured_values_not_display_tokens() {
    let host = HostState::new().unwrap();
    let mut a = simple();
    a["workspace"]["queries"][0]["steps"][0]["payload"]["raw_sql"] = json!(
        "select 'a|b' as key, 'c' as second, 'Acme Corporaton' as name, 'UK' as region, 'literal ∅' as note union all select 'a', 'b|c', 'Acme Corporaton', 'UK', 'literal ∅'");
    a["workspace"]["queries"][1]["steps"][0]["payload"]["raw_sql"] = json!(
        "select ' id|1 ' as id, ' first output ' as out_a, 'second|output' as out_b, 'Acme Corporation' as label, 'UK' as region, 'literal NULL' as note");
    a["workspace"]["queries"][0]["steps"][1]["payload"]["left_on"] = json!(["key", "second"]);
    a["workspace"]["queries"][0]["steps"][1]["payload"]["right_on"] = json!(["out_b", "out_a"]);
    a["plan"]["mapKeyFields"] = json!(["key", "second"]);
    a["plan"]["outputs"] = json!(["out_b", "out_a"]);
    a["plan"]["targetIdentityFields"] = json!(["id", "region"]);
    let snapshot = host.dispatch("matching_acquire_join", a.clone()).unwrap();
    assert_eq!(
        snapshot["acquisition"]["sourceRows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["identityValues"],
        json!([" id|1 ", "UK"])
    );
    assert_eq!(
        snapshot["acquisition"]["targetRows"][0]["outputValues"],
        json!(["second|output", " first output "])
    );
    let mut request = verify_args(a, &snapshot);
    let mut second = request["verification"]["decisions"][0].clone();
    second["sourceParts"] = snapshot["acquisition"]["sourceRows"][1]["mapKey"].clone();
    request["verification"]["decisions"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let wire = serde_json::from_str(&serde_json::to_string(&request).unwrap()).unwrap();
    let result = host
        .dispatch("matching_verify_join_candidates", wire)
        .unwrap();
    assert_eq!(result["materialized"].as_array().unwrap().len(), 2);
    assert_ne!(
        result["materialized"][0]["sourceParts"],
        result["materialized"][1]["sourceParts"]
    );
}
