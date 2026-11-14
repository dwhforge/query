//! Real framed RPC, real CSVs, and a fresh host process after Save/Reopen.
//! Map/Apply payloads mirror planTupleMapping + the existing ApplyKeyMap fold.
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct Host {
    child: Child,
    stream: TcpStream,
    next_id: u64,
}

impl Host {
    fn start(home: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dwh-host"))
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("DWH_HOST_TCP", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let port = ready
            .trim()
            .strip_prefix("DWH_HOST_READY tcp ")
            .unwrap_or_else(|| panic!("host did not become ready: {ready}"));
        let stream = TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        Self {
            child,
            stream,
            next_id: 0,
        }
    }

    fn rpc(&mut self, cmd: &str, args: Value) -> Value {
        self.next_id += 1;
        let request =
            serde_json::to_vec(&json!({"id": self.next_id, "cmd": cmd, "args": args})).unwrap();
        self.stream
            .write_all(&(request.len() as u32).to_le_bytes())
            .unwrap();
        self.stream.write_all(&request).unwrap();
        let mut length = [0; 4];
        self.stream.read_exact(&mut length).unwrap();
        let mut body = vec![0; u32::from_le_bytes(length) as usize];
        self.stream.read_exact(&mut body).unwrap();
        let reply: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(reply["id"], self.next_id, "{cmd}: {reply}");
        assert_eq!(reply["ok"], true, "{cmd}: {reply}");
        reply["result"].clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct TempRoot(PathBuf);
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn preview(host: &mut Host, workspace: &Value) -> Value {
    host.rpc(
        "preview_workspace",
        json!({"workspace": workspace, "rowLimit": 50}),
    )
}

fn assert_join(result: &Value, expected: &[Option<&str>]) {
    let columns = result["columns"].as_array().unwrap();
    let index = |name: &str| columns.iter().position(|c| c["name"] == name).unwrap();
    let id = index("row_id");
    let marker = index("partner");
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        expected.len(),
        "Apply/Join must not multiply rows: {result}"
    );
    for (i, wanted) in expected.iter().enumerate() {
        let row = rows
            .iter()
            .find(|r| r[id].as_str() == Some(&format!("row{i}")))
            .unwrap();
        assert_eq!(
            row[marker],
            wanted.map(Value::from).unwrap_or(Value::Null),
            "row{i}: {result}"
        );
    }
}

fn lifecycle(width: usize, batch: bool) {
    let root = TempRoot(std::env::temp_dir().join(format!(
        "dwh-tuple-lifecycle-{}-{width}-{batch}",
        std::process::id()
    )));
    fs::create_dir_all(&root.0).unwrap();
    let left_on: Vec<_> = ["company", "country", "channel", "status", "revision"][..width]
        .iter()
        .map(|s| s.to_string())
        .collect();
    // Deliberately unrelated names and reversed physical CSV column order.
    let right_on: Vec<_> = ["legal_name", "nation", "route", "state", "version"][..width]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let source = if width == 1 {
        vec!["ABC UK"]
    } else {
        vec!["ABC", "UK", "retail", "old", "v1"][..width].to_vec()
    };
    let target = if width == 1 {
        vec!["ABC Limited UK"]
    } else {
        vec!["ABC Limited", "GB", "store", "active", "v2"][..width].to_vec()
    };
    let mut us = source.clone();
    us[if width == 1 { 0 } else { 1 }] = if width == 1 { "ABC US" } else { "US" };
    let mut other = source.clone();
    other[if width >= 3 { 2 } else { 0 }] = if width >= 3 { "wholesale" } else { "XYZ" };
    let mut other_target = target.clone();
    other_target[if width >= 3 { 2 } else { 0 }] =
        if width >= 3 { "trade" } else { "XYZ Canonical" };
    let left = root.0.join("left.csv");
    let right = root.0.join("right.csv");
    fs::write(
        &left,
        format!(
            "row_id,{}\nrow0,{}\nrow1,{}\nrow2,{}\n",
            left_on.join(","),
            source.join(","),
            us.join(","),
            other.join(",")
        ),
    )
    .unwrap();
    let reverse = |parts: &[&str]| parts.iter().rev().copied().collect::<Vec<_>>().join(",");
    fs::write(
        &right,
        format!(
            "partner,{}\nuk,{}\nother,{}\n",
            right_on.iter().rev().cloned().collect::<Vec<_>>().join(","),
            reverse(&target),
            reverse(&other_target)
        ),
    )
    .unwrap();
    let mut workspace = json!({"focus_query_id": "fact", "key_maps": [], "queries": [
        {"id": "fact", "name": "fact", "steps": [
            {"type": "LoadCsv", "payload": {"path": left}},
            {"type": "Join", "payload": {"right_query_id": "dim", "join_type": "left", "left_on": left_on, "right_on": right_on}}
        ]},
        {"id": "dim", "name": "dim", "steps": [{"type": "LoadCsv", "payload": {"path": right}}]}
    ]});
    let mut host = Host::start(&root.0);
    assert_join(&preview(&mut host, &workspace), &[None, None, None]);
    let before = workspace.clone();
    let suggest = host.rpc("join_key_fuzzy_suggest", json!({"workspace": workspace, "hostQueryId": "fact", "joinStepIndex": 1, "tuple": {"source_parts": source}}));
    let report = &suggest["tuple_report"];
    assert_eq!(report["left_on"], json!(left_on));
    assert_eq!(report["right_on"], json!(right_on));
    assert_eq!(report["sources"][0]["source"]["parts"], json!(source));
    assert!(report["right_universe"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["parts"] == json!(target)));
    assert_eq!(workspace, before, "Suggest is read-only");
    if batch {
        let all = host.rpc(
            "join_key_fuzzy_suggest",
            json!({"workspace": workspace,
            "hostQueryId": "fact", "joinStepIndex": 1, "tuple": {}}),
        );
        let groups = all["tuple_report"]["sources"].as_array().unwrap();
        assert_eq!(
            groups.len(),
            3,
            "batch retrieval includes every unmatched context"
        );
        for parts in [&source, &us, &other] {
            assert!(groups.iter().any(|g| g["source"]["parts"] == json!(parts)));
        }
        assert_eq!(workspace, before, "batch retrieval must remain read-only");
        assert_join(&preview(&mut host, &workspace), &[None, None, None]);
    }
    let from_columns: Vec<_> = left_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("from_{}_{c}", i + 1))
        .collect();
    let output_columns: Vec<_> = right_on
        .iter()
        .enumerate()
        .map(|(i, c)| format!("to_{}_{c}", i + 1))
        .collect();
    let entry = |from: &[&str], to: &[&str]| json!({"from": from[0], "from_parts": from, "to": to[0], "output_values": to});
    workspace["key_maps"] = json!([{
        "id": "tuple_map", "name": "Join aliases fact", "from_column": from_columns[0], "from_columns": from_columns,
        "to_column": output_columns[0], "output_columns": output_columns, "storage": {"kind": "seed"},
        "entries": if batch { vec![entry(&source, &target), entry(&other, &other_target)] }
            else { vec![entry(&source, &target)] }
    }]);
    let bindings: Vec<_> = output_columns
        .iter()
        .zip(&left_on)
        .map(|(map, dest)| json!({"map_column": map, "destination_column": dest}))
        .collect();
    workspace["queries"][0]["steps"].as_array_mut().unwrap().insert(1, json!({"type": "ApplyKeyMap", "payload": {
        "column": left_on[0], "columns": left_on, "output_bindings": bindings, "map_id": "tuple_map", "entries": []
    }}));
    if !batch {
        assert_join(&preview(&mut host, &workspace), &[Some("uk"), None, None]);
        // A second full tuple can share its first two fields without overwriting the first.
        workspace["key_maps"][0]["entries"]
            .as_array_mut()
            .unwrap()
            .push(entry(&other, &other_target));
    }
    // Batch mode's first mutation contains both complete entries and one Apply.
    assert_eq!(workspace["key_maps"].as_array().unwrap().len(), 1);
    assert_eq!(
        workspace["queries"][0]["steps"].as_array().unwrap().len(),
        3
    );
    let mapped = preview(&mut host, &workspace);
    assert_join(&mapped, &[Some("uk"), None, Some("other")]);
    let project_path = root.0.join("saved.dwhproj.json");
    let mut project: Value = serde_json::from_str(include_str!(
        "../../../e2e/electron/fixtures/mapping-create/smoke.dwhproj.json"
    ))
    .unwrap();
    project["workspace"] = workspace.clone();
    host.rpc(
        "save_project",
        json!({"path": project_path, "project": project}),
    );
    let disk: Value = serde_json::from_slice(&fs::read(&project_path).unwrap()).unwrap();
    assert_eq!(
        disk["workspace"]["key_maps"][0]["entries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    drop(host);
    let mut reopened = Host::start(&root.0);
    let loaded = reopened.rpc(
        "load_project",
        json!({"path": project_path, "remember": false}),
    );
    assert_eq!(
        loaded["workspace"]["key_maps"][0]["from_columns"],
        json!(from_columns)
    );
    assert_eq!(
        loaded["workspace"]["key_maps"][0]["output_columns"],
        json!(output_columns)
    );
    assert_eq!(
        loaded["workspace"]["key_maps"][0]["entries"], disk["workspace"]["key_maps"][0]["entries"],
        "all full-context From/output tuples must survive Save/Reopen"
    );
    assert_eq!(
        loaded["workspace"]["queries"][0]["steps"][1]["payload"]["output_bindings"],
        json!(bindings)
    );
    let result = reopened.rpc(
        "preview_workspace",
        json!({
            "workspace": loaded["workspace"], "projectFile": project_path, "rowLimit": 50
        }),
    );
    assert_join(&result, &[Some("uk"), None, Some("other")]);
    assert_eq!(result["columns"], mapped["columns"]);
    let sorted_rows = |result: &Value| {
        let mut rows = result["rows"].as_array().unwrap().clone();
        rows.sort_by_key(Value::to_string);
        rows
    };
    assert_eq!(sorted_rows(&result), sorted_rows(&mapped));
}

#[test]
fn one_key_save_reopen() {
    lifecycle(1, false);
}
#[test]
fn two_key_save_reopen() {
    lifecycle(2, false);
}
#[test]
fn three_key_save_reopen() {
    lifecycle(3, false);
}
#[test]
fn four_key_save_reopen() {
    lifecycle(4, false);
}
#[test]
fn five_key_save_reopen() {
    lifecycle(5, false);
}

#[test]
fn batch_one_through_five_keys_execute_save_and_cold_reopen() {
    for width in 1..=5 {
        lifecycle(width, true);
    }
}
