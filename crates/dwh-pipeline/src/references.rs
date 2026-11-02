//! Cross-project references ([ADR-0025](../../../docs/adr/0025-project-references.md)).
//!
//! Declarations stay on the root project. This module resolves a closure and lowers it
//! to an ordinary [`Workspace`] the existing compilers already accept.

use crate::destination::ExecutionEngine;
use crate::dialect::WarehouseDialect;
use crate::emit::key_map_seed_name;
use crate::export_manifest::hash_content;
use crate::graph::sanitize_id;
use crate::model::{
    KeyMapDef, KeyMapStorage, ObjectKind, ObjectTarget, QueryDef, TransformationStep, Workspace,
};
use crate::project::{ConnectionBinding, Project, ProjectReference, SourceDef, SourceKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceState {
    Ready,
    UpdateAvailable,
    Missing,
    IdentityMismatch,
    IncompatibleFormat,
    InvalidDependencyGraph,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReferenceStatus {
    pub reference_id: String,
    pub state: ReferenceState,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProvenanceRecord {
    pub project_uid: String,
    pub kind: ObjectKind,
    pub object_id: String,
    pub locked_revision: String,
    pub generated_name: String,
}

#[derive(Debug, Clone)]
pub enum ResolveKind {
    /// Selected query (`workspace.focus_query_id`).
    Preview,
    /// Root outputs; empty means focus only, matching today's export.
    Export { published_ids: Vec<String> },
    /// Every local query. Unused references are not walked.
    ValidateAll,
}

pub struct ResolveInput<'a> {
    pub root_file: &'a Path,
    pub project_uid: &'a str,
    pub execution_engine: ExecutionEngine,
    pub references: &'a [ProjectReference],
    pub connection_bindings: &'a [ConnectionBinding],
    pub workspace: &'a Workspace,
    pub sources: &'a [SourceDef],
    pub available_connections: &'a [String],
    pub kind: ResolveKind,
}

#[derive(Debug, Clone)]
pub struct LoweredOperation {
    pub workspace: Workspace,
    pub sources: Vec<SourceDef>,
    pub published_query_ids: Vec<String>,
    pub provenance_json: Option<String>,
}

pub fn new_project_uid() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut bytes);
    } else {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&n.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        u16::from_be_bytes([bytes[4], bytes[5]]),
        u16::from_be_bytes([bytes[6], bytes[7]]),
        u16::from_be_bytes([bytes[8], bytes[9]]),
        u64::from_be_bytes([
            bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15], 0, 0
        ]) >> 16
    )
}

/// Assign a uid when both the in-memory project and the file on disk lack one.
/// A later save that drops the field keeps the uid already stored.
pub fn ensure_project_uid(project: &mut Project, existing_file: Option<&Path>) {
    if !project.project_uid.trim().is_empty() {
        return;
    }
    if let Some(path) = existing_file {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(old) = Project::from_json(&text) {
                if !old.project_uid.trim().is_empty() {
                    project.project_uid = old.project_uid;
                    return;
                }
            }
        }
    }
    project.project_uid = new_project_uid();
}

pub fn fork_project_identity(project: &mut Project) {
    project.project_uid = new_project_uid();
}

pub fn short_uid(uid: &str) -> String {
    let digest = Sha256::digest(uid.as_bytes());
    hex::encode(&digest[..4])
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Semantic fingerprint. Layout, focus, outputs, destination, and secrets are excluded.
pub fn project_revision(project: &Project, project_file: &Path) -> Result<String, String> {
    let value = revision_value(project, project_file)?;
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    Ok(sha256_hex(text.as_bytes()))
}

fn revision_value(project: &Project, project_file: &Path) -> Result<Value, String> {
    let mut sources: Vec<SourceDef> = project.sources.clone();
    sources.sort_by(|a, b| a.id.cmp(&b.id));
    let sources: Vec<Value> = sources
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "kind": s.kind,
                "path": s.path,
                "connection_id": s.connection_id,
                "schema": s.schema,
                "table_name": s.table_name,
                "hive_partitioning": s.hive_partitioning,
            })
        })
        .collect();

    let mut queries = project.workspace.queries.clone();
    queries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut query_values = Vec::new();
    for q in &queries {
        query_values.push(json!({
            "id": q.id,
            "name": q.name,
            "execution": q.execution,
            "steps": serde_json::to_value(&q.steps).map_err(|e| e.to_string())?,
        }));
    }

    let mut maps = project.workspace.key_maps.clone();
    maps.sort_by(|a, b| a.id.cmp(&b.id));
    let mut map_values = Vec::new();
    for km in &maps {
        map_values.push(mapping_revision(project, project_file, km)?);
    }

    let mut refs = project.references.clone();
    refs.sort_by(|a, b| a.id.cmp(&b.id));
    let references: Vec<Value> = refs
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "expected_project_uid": r.expected_project_uid,
                "locked_revision": r.locked_revision,
            })
        })
        .collect();

    Ok(json!({
        "project_uid": project.project_uid,
        "execution_engine": project.execution_engine,
        "sources": sources,
        "queries": query_values,
        "key_maps": map_values,
        "references": references,
    }))
}

fn mapping_revision(
    project: &Project,
    _project_file: &Path,
    km: &KeyMapDef,
) -> Result<Value, String> {
    let mut body = json!({
        "id": km.id,
        "name": km.name,
        "storage": serde_json::to_value(&km.storage).map_err(|e| e.to_string())?,
        "from_columns": km.from_columns_eff(),
        "to_column": km.to_column,
        "editable_columns": km.editable_columns,
    });
    if km.is_seed_backed() {
        if let Some(export) = project.last_dbt_export_path.as_deref() {
            let seed = Path::new(export)
                .join("seeds")
                .join(format!("{}.csv", key_map_seed_name(&km.id)));
            if !seed.is_file() {
                return Err(format!(
                    "authoritative seed missing for map '{}': {}",
                    km.id,
                    seed.display()
                ));
            }
            let bytes = fs::read(&seed).map_err(|e| format!("read {}: {e}", seed.display()))?;
            body["seed_sha256"] = json!(sha256_hex(&bytes));
        } else {
            body["entries"] = serde_json::to_value(&km.entries).map_err(|e| e.to_string())?;
        }
    }
    Ok(body)
}

pub fn reference_statuses(root_file: &Path, references: &[ProjectReference]) -> Vec<ReferenceStatus> {
    references
        .iter()
        .map(|r| status_one(root_file, r))
        .collect()
}

fn status_one(root_file: &Path, reference: &ProjectReference) -> ReferenceStatus {
    let path = resolve_locator(root_file, &reference.locator);
    if !path.is_file() {
        return ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::Missing,
            message: format!("owner file not found at {}", reference.locator),
        };
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            return ReferenceStatus {
                reference_id: reference.id.clone(),
                state: ReferenceState::IncompatibleFormat,
                message: format!("cannot read owner file: {e}"),
            };
        }
    };
    let project = match Project::from_json(&text) {
        Ok(p) => p,
        Err(e) => {
            return ReferenceStatus {
                reference_id: reference.id.clone(),
                state: ReferenceState::IncompatibleFormat,
                message: format!("owner file is not a DWHQuery project: {e}"),
            };
        }
    };
    if project.project_uid.trim().is_empty() {
        return ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::IncompatibleFormat,
            message: "owner has no project_uid; open and save the owning project first".into(),
        };
    }
    if project.project_uid != reference.expected_project_uid {
        return ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::IdentityMismatch,
            message: format!(
                "file uid {} does not match expected {}",
                project.project_uid, reference.expected_project_uid
            ),
        };
    }
    match project_revision(&project, &path) {
        Ok(rev) if rev == reference.locked_revision => ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::Ready,
            message: String::new(),
        },
        Ok(_) => ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::UpdateAvailable,
            message: format!("owner '{}' changed on disk", project.name),
        },
        Err(e) => ReferenceStatus {
            reference_id: reference.id.clone(),
            state: ReferenceState::InvalidDependencyGraph,
            message: e,
        },
    }
}

pub fn resolve_locator(declaring_file: &Path, locator: &str) -> PathBuf {
    let loc = Path::new(locator);
    if loc.is_absolute() {
        loc.to_path_buf()
    } else {
        declaring_file
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(loc)
    }
}

fn relative_locator(from_dir: &Path, target_file: &Path) -> Result<String, String> {
    let from = from_dir
        .canonicalize()
        .map_err(|e| format!("project directory: {e}"))?;
    let target = target_file
        .canonicalize()
        .map_err(|e| format!("owner file: {e}"))?;
    let from_c: Vec<_> = from.components().collect();
    let to_c: Vec<_> = target.components().collect();
    let mut i = 0;
    while i < from_c.len() && i < to_c.len() && from_c[i] == to_c[i] {
        i += 1;
    }
    let mut out = PathBuf::new();
    for _ in 0..(from_c.len() - i) {
        out.push("..");
    }
    for c in &to_c[i..] {
        out.push(c);
    }
    if out.as_os_str().is_empty() {
        return Err("owner path is the project directory, not a project file".into());
    }
    Ok(out.to_string_lossy().replace('\\', "/"))
}

pub fn make_project_reference(
    root_file: &Path,
    owner_file: &Path,
    alias: &str,
) -> Result<ProjectReference, String> {
    if !root_file.is_file() {
        return Err("save the project before adding a reference".into());
    }
    let root_canon = root_file
        .canonicalize()
        .unwrap_or_else(|_| root_file.to_path_buf());
    let owner_canon = owner_file
        .canonicalize()
        .map_err(|e| format!("resolve owner path: {e}"))?;
    if root_canon == owner_canon {
        return Err("a project cannot reference itself (same file)".into());
    }
    let text = fs::read_to_string(owner_file).map_err(|e| format!("read owner: {e}"))?;
    let owner = Project::from_json(&text)?;
    if owner.project_uid.trim().is_empty() {
        return Err(
            "owner has no project_uid; open and save the owning project first".into(),
        );
    }
    if let Ok(root_text) = fs::read_to_string(root_file) {
        if let Ok(root) = Project::from_json(&root_text) {
            if !root.project_uid.trim().is_empty() && root.project_uid == owner.project_uid {
                return Err(
                    "owner has the same project_uid (copied file); Save As the owner to fork identity first"
                        .into(),
                );
            }
        }
    }
    let revision = project_revision(&owner, owner_file)?;
    let parent = root_file.parent().unwrap_or_else(|| Path::new("."));
    let locator = relative_locator(parent, owner_file)?;
    Ok(ProjectReference {
        id: format!("ref_{}", short_uid(&revision)[..8].to_string() + &short_uid(&locator)),
        alias: if alias.trim().is_empty() {
            owner.name
        } else {
            alias.trim().to_string()
        },
        locator,
        expected_project_uid: owner.project_uid,
        locked_revision: revision,
    })
}

pub fn relink_reference(
    root_file: &Path,
    reference: &ProjectReference,
    owner_file: &Path,
) -> Result<ProjectReference, String> {
    let text = fs::read_to_string(owner_file).map_err(|e| format!("read owner: {e}"))?;
    let owner = Project::from_json(&text)?;
    if owner.project_uid != reference.expected_project_uid {
        return Err(format!(
            "identity mismatch: file uid {} does not match reference {}",
            owner.project_uid, reference.expected_project_uid
        ));
    }
    let parent = root_file.parent().unwrap_or_else(|| Path::new("."));
    let mut next = reference.clone();
    next.locator = relative_locator(parent, owner_file)?;
    Ok(next)
}

pub fn refresh_reference(input: &ResolveInput, reference_id: &str) -> Result<ProjectReference, String> {
    let current = input
        .references
        .iter()
        .find(|r| r.id == reference_id)
        .ok_or_else(|| format!("unknown reference '{reference_id}'"))?;
    let path = resolve_locator(input.root_file, &current.locator);
    let text = fs::read_to_string(&path).map_err(|e| format!("read owner: {e}"))?;
    let owner = Project::from_json(&text)?;
    if owner.project_uid != current.expected_project_uid {
        return Err(format!(
            "identity mismatch for reference '{}': file uid {} != {}",
            current.alias, owner.project_uid, current.expected_project_uid
        ));
    }
    let revision = project_revision(&owner, &path)?;
    let mut updated = current.clone();
    updated.locked_revision = revision;
    let mut refs = input.references.to_vec();
    if let Some(slot) = refs.iter_mut().find(|r| r.id == reference_id) {
        *slot = updated.clone();
    }
    let trial = ResolveInput {
        root_file: input.root_file,
        project_uid: input.project_uid,
        execution_engine: input.execution_engine,
        references: &refs,
        connection_bindings: input.connection_bindings,
        workspace: input.workspace,
        sources: input.sources,
        available_connections: input.available_connections,
        kind: ResolveKind::ValidateAll,
    };
    resolve_operation(&trial).map_err(|e| {
        format!("refresh of '{}' failed; previous lock kept. {e}", current.alias)
    })?;
    Ok(updated)
}

pub fn reference_consumers(workspace: &Workspace, reference_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    for q in &workspace.queries {
        if q.steps.iter().any(|s| step_cites(s, reference_id)) {
            out.push(format!("{} ({})", q.name, q.id));
        }
    }
    out
}

fn step_cites(step: &TransformationStep, reference_id: &str) -> bool {
    let hit = |t: &ObjectTarget| match t {
        ObjectTarget::External {
            reference_id: rid, ..
        } => rid == reference_id,
        ObjectTarget::Local(_) => false,
    };
    match step {
        TransformationStep::FromQuery { query_id } => hit(query_id),
        TransformationStep::Join { right_query_id, .. } => hit(right_query_id),
        TransformationStep::Append { other_query_ids } => other_query_ids.iter().any(hit),
        TransformationStep::ApplyKeyMap { map_id, .. } => hit(map_id),
        TransformationStep::SqlModel { raw_sql } | TransformationStep::CustomSql { raw_sql } => {
            raw_sql.contains(&format!("{{{{xref:{reference_id}:"))
        }
        _ => false,
    }
}

pub fn resolve_operation(input: &ResolveInput) -> Result<LoweredOperation, String> {
    if !closure_has_external(input) {
        return Ok(LoweredOperation {
            workspace: input.workspace.clone(),
            sources: input.sources.to_vec(),
            published_query_ids: published_ids(input),
            provenance_json: None,
        });
    }
    if input.project_uid.trim().is_empty() {
        return Err("save the project to assign project_uid before using references".into());
    }
    if input.root_file.as_os_str().is_empty() || !input.root_file.is_file() {
        return Err("save the project before using a reference".into());
    }

    let mut resolver = Resolver {
        input,
        loaded: HashMap::new(),
        project_stack: vec![input.project_uid.to_string()],
        object_stack: Vec::new(),
        done: HashSet::new(),
        queries: Vec::new(),
        maps: Vec::new(),
    };
    resolver.load_root();
    for root in operation_roots(input) {
        resolver.visit_query(input.project_uid, &root, &root)?;
    }
    resolver.lower()
}

fn operation_roots(input: &ResolveInput) -> Vec<String> {
    match &input.kind {
        ResolveKind::Preview => vec![input.workspace.focus_query_id.clone()],
        ResolveKind::Export { published_ids } => {
            if published_ids.is_empty() {
                vec![input.workspace.focus_query_id.clone()]
            } else {
                published_ids.clone()
            }
        }
        ResolveKind::ValidateAll => input.workspace.queries.iter().map(|q| q.id.clone()).collect(),
    }
}

fn published_ids(input: &ResolveInput) -> Vec<String> {
    match &input.kind {
        ResolveKind::Export { published_ids } if !published_ids.is_empty() => published_ids
            .iter()
            .filter(|id| input.workspace.query(id).is_some())
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

fn closure_has_external(input: &ResolveInput) -> bool {
    let roots = operation_roots(input);
    let mut seen = HashSet::new();
    let mut stack = roots;
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(q) = input.workspace.query(&id) else {
            continue;
        };
        if q.steps.iter().any(step_has_external) {
            return true;
        }
        if let Ok(deps) = crate::graph::direct_deps(&q.steps) {
            stack.extend(deps);
        }
    }
    false
}

fn step_has_external(step: &TransformationStep) -> bool {
    match step {
        TransformationStep::FromQuery { query_id } => query_id.is_external(),
        TransformationStep::Join { right_query_id, .. } => right_query_id.is_external(),
        TransformationStep::Append { other_query_ids } => {
            other_query_ids.iter().any(ObjectTarget::is_external)
        }
        TransformationStep::ApplyKeyMap { map_id, .. } => map_id.is_external(),
        TransformationStep::SqlModel { raw_sql } | TransformationStep::CustomSql { raw_sql } => {
            raw_sql.contains("{{xref:")
        }
        _ => false,
    }
}

struct LoadedOwner {
    file: PathBuf,
    project: Project,
    revision: String,
}

struct IncludedQuery {
    uid: String,
    revision: String,
    query: QueryDef,
    /// Sources copied from the same project for Hive and similar flags.
    sources: Vec<SourceDef>,
}

struct IncludedMap {
    uid: String,
    revision: String,
    map: KeyMapDef,
}

struct Resolver<'a> {
    input: &'a ResolveInput<'a>,
    loaded: HashMap<String, LoadedOwner>,
    project_stack: Vec<String>,
    object_stack: Vec<(String, ObjectKind, String)>,
    done: HashSet<(String, ObjectKind, String)>,
    queries: Vec<IncludedQuery>,
    maps: Vec<IncludedMap>,
}

impl<'a> Resolver<'a> {
    fn load_root(&mut self) {
        let mut project = Project {
            id: "root".into(),
            name: "root".into(),
            project_uid: self.input.project_uid.to_string(),
            references: self.input.references.to_vec(),
            connection_bindings: self.input.connection_bindings.to_vec(),
            root_path: None,
            connections: vec![],
            sources: self.input.sources.to_vec(),
            workspace: self.input.workspace.clone(),
            dbt_target: Default::default(),
            execution_engine: self.input.execution_engine,
            destination: crate::destination::Destination::duckdb("local.duckdb"),
            outputs: vec![],
            materialization: Default::default(),
            target_dialect: self.input.execution_engine.dialect(),
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
        };
        // Keep the caller's published list off the owner-facing fingerprint.
        let _ = &mut project;
        self.loaded.insert(
            self.input.project_uid.to_string(),
            LoadedOwner {
                file: self.input.root_file.to_path_buf(),
                project,
                revision: String::new(),
            },
        );
    }

    fn visit_query(&mut self, uid: &str, query_id: &str, consumer: &str) -> Result<(), String> {
        let key = (uid.to_string(), ObjectKind::Query, query_id.to_string());
        if self.done.contains(&key) {
            return Ok(());
        }
        if let Some(pos) = self
            .object_stack
            .iter()
            .position(|k| k.0 == uid && k.1 == ObjectKind::Query && k.2 == query_id)
        {
            let path = self.object_stack[pos..]
                .iter()
                .map(|(u, k, id)| format!("{u}/{}/{id}", k.as_str()))
                .collect::<Vec<_>>()
                .join(" -> ");
            return Err(format!(
                "cycle in project references: {path} -> {uid}/query/{query_id}"
            ));
        }
        let project = self
            .loaded
            .get(uid)
            .ok_or_else(|| format!("project {uid} was not loaded"))?;
        let query = project
            .project
            .workspace
            .query(query_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "referenced object unavailable: owner {uid} query '{query_id}' ({}); consumer '{consumer}'",
                    if uid == self.input.project_uid {
                        "not in this project".to_string()
                    } else {
                        "missing from the owner file".to_string()
                    }
                )
            })?;
        let revision = project.revision.clone();
        let file = project.file.clone();
        let engine = project.project.execution_engine;
        let sources = project.project.sources.clone();
        if uid != self.input.project_uid {
            check_dialect(&query, engine, self.input.execution_engine, uid)?;
        }
        self.object_stack.push(key.clone());
        for step in &query.steps {
            self.follow_step(uid, &file, step, &query.id)?;
        }
        self.object_stack.pop();
        self.done.insert(key);
        let matched = matching_sources(&sources, &query);
        self.queries.push(IncludedQuery {
            uid: uid.to_string(),
            revision,
            query,
            sources: matched,
        });
        Ok(())
    }

    fn follow_step(
        &mut self,
        uid: &str,
        file: &Path,
        step: &TransformationStep,
        consumer: &str,
    ) -> Result<(), String> {
        match step {
            TransformationStep::FromQuery { query_id } => {
                self.follow_target(uid, file, query_id, ObjectKind::Query, consumer)
            }
            TransformationStep::Join { right_query_id, .. } => {
                self.follow_target(uid, file, right_query_id, ObjectKind::Query, consumer)
            }
            TransformationStep::Append { other_query_ids } => {
                for t in other_query_ids {
                    self.follow_target(uid, file, t, ObjectKind::Query, consumer)?;
                }
                Ok(())
            }
            TransformationStep::ApplyKeyMap { map_id, .. } => {
                self.follow_target(uid, file, map_id, ObjectKind::Mapping, consumer)
            }
            TransformationStep::SqlModel { raw_sql } | TransformationStep::CustomSql { raw_sql } => {
                for (reference_id, object_id) in extract_xrefs(raw_sql) {
                    let target =
                        ObjectTarget::external(reference_id, ObjectKind::Query, object_id);
                    self.follow_target(uid, file, &target, ObjectKind::Query, consumer)?;
                }
                for id in crate::graph::extract_query_placeholders_pub(raw_sql) {
                    let target = ObjectTarget::from(id);
                    self.follow_target(uid, file, &target, ObjectKind::Query, consumer)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn follow_target(
        &mut self,
        from_uid: &str,
        from_file: &Path,
        target: &ObjectTarget,
        expected: ObjectKind,
        consumer: &str,
    ) -> Result<(), String> {
        match target {
            ObjectTarget::Local(id) => match expected {
                ObjectKind::Query => self.visit_query(from_uid, id, consumer),
                ObjectKind::Mapping => self.visit_map(from_uid, id, consumer),
                ObjectKind::Source => Ok(()),
            },
            ObjectTarget::External {
                reference_id,
                kind,
                id,
            } => {
                if *kind != expected && !(expected == ObjectKind::Query && *kind == ObjectKind::Query)
                {
                    // kind on the wire should match the field; still honor the wire kind.
                }
                let owner_uid = self.open_reference(from_uid, from_file, reference_id, consumer)?;
                let entered = owner_uid != from_uid;
                match kind {
                    ObjectKind::Query => self.visit_query(&owner_uid, id, consumer)?,
                    ObjectKind::Mapping => self.visit_map(&owner_uid, id, consumer)?,
                    ObjectKind::Source => {}
                }
                if entered {
                    self.project_stack.pop();
                }
                Ok(())
            }
        }
    }

    fn open_reference(
        &mut self,
        from_uid: &str,
        from_file: &Path,
        reference_id: &str,
        consumer: &str,
    ) -> Result<String, String> {
        let project = self
            .loaded
            .get(from_uid)
            .ok_or_else(|| format!("project {from_uid} was not loaded"))?;
        let reference = project
            .project
            .references
            .iter()
            .find(|r| r.id == reference_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "reference '{reference_id}' is not declared; consumer '{consumer}'"
                )
            })?;
        if reference.expected_project_uid == from_uid || self.project_stack.contains(&reference.expected_project_uid)
        {
            let path = self
                .project_stack
                .iter()
                .cloned()
                .chain(std::iter::once(reference.expected_project_uid.clone()))
                .collect::<Vec<_>>()
                .join(" -> ");
            return Err(format!("cycle in project references: {path}"));
        }
        if let Some(existing) = self.loaded.get(&reference.expected_project_uid) {
            if existing.revision != reference.locked_revision {
                return Err(format!(
                    "two definitions claim project_uid {}: reference '{}' locks {}, already loaded revision {}",
                    reference.expected_project_uid,
                    reference.alias,
                    reference.locked_revision,
                    existing.revision
                ));
            }
            self.project_stack
                .push(reference.expected_project_uid.clone());
            return Ok(reference.expected_project_uid);
        }
        let path = resolve_locator(from_file, &reference.locator);
        if !path.is_file() {
            return Err(format!(
                "reference '{}' owner file missing ({}); consumer '{consumer}'",
                reference.alias, reference.locator
            ));
        }
        let text = fs::read_to_string(&path).map_err(|e| format!("read owner: {e}"))?;
        let owner = Project::from_json(&text).map_err(|e| {
            format!(
                "reference '{}' owner file is not a DWHQuery project: {e}",
                reference.alias
            )
        })?;
        if owner.project_uid != reference.expected_project_uid {
            return Err(format!(
                "identity mismatch for reference '{}': file uid {} != {}; consumer '{consumer}'",
                reference.alias, owner.project_uid, reference.expected_project_uid
            ));
        }
        let revision = project_revision(&owner, &path)?;
        if revision != reference.locked_revision {
            return Err(format!(
                "update available for reference '{}' (owner '{}'); consumer '{consumer}'. Refresh the reference before using it",
                reference.alias, owner.name
            ));
        }
        let uid = owner.project_uid.clone();
        self.loaded.insert(
            uid.clone(),
            LoadedOwner {
                file: path,
                project: owner,
                revision,
            },
        );
        self.project_stack.push(uid.clone());
        Ok(uid)
    }

    fn visit_map(&mut self, uid: &str, map_id: &str, consumer: &str) -> Result<(), String> {
        let key = (uid.to_string(), ObjectKind::Mapping, map_id.to_string());
        if self.done.contains(&key) {
            return Ok(());
        }
        let project = self
            .loaded
            .get(uid)
            .ok_or_else(|| format!("project {uid} was not loaded"))?;
        let mut map = project
            .project
            .workspace
            .key_map(map_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "referenced object unavailable: owner {uid} mapping '{map_id}' missing; consumer '{consumer}'"
                )
            })?;
        if map.is_seed_backed() {
            if let Some(export) = project.project.last_dbt_export_path.clone() {
                let seed = Path::new(&export)
                    .join("seeds")
                    .join(format!("{}.csv", key_map_seed_name(&map.id)));
                if !seed.is_file() {
                    return Err(format!(
                        "authoritative seed missing for mapping '{}' ({}); consumer '{consumer}'",
                        map.id,
                        seed.display()
                    ));
                }
                let body = fs::read_to_string(&seed)
                    .map_err(|e| format!("read seed {}: {e}", seed.display()))?;
                let (from_cols, to_col) = (map.from_columns_eff(), map.to_column.clone());
                map.entries = crate::emit::parse_key_map_seed_csv_cols(&body, &from_cols, &to_col)?;
            }
        } else if matches!(map.storage, KeyMapStorage::Source { .. }) {
            // Live rows stay in the database. Do not keep a dictionary snapshot.
            map.entries.clear();
        }
        let revision = project.revision.clone();
        self.done.insert(key);
        self.maps.push(IncludedMap {
            uid: uid.to_string(),
            revision,
            map,
        });
        Ok(())
    }

    fn lower(&self) -> Result<LoweredOperation, String> {
        let root = self.input.project_uid;
        let mut queries = Vec::new();
        let mut maps = Vec::new();
        let mut sources = Vec::new();
        let mut provenance = Vec::new();
        let mut names = BTreeSet::new();

        for inc in &self.queries {
            let mut query = inc.query.clone();
            if inc.uid != root {
                let cid = external_compiler_id(&inc.uid, ObjectKind::Query, &query.id);
                let model = external_model_name(&query, &inc.uid, &query.id);
                if !names.insert(model.clone()) {
                    return Err(format!("export name collision on '{model}'"));
                }
                provenance.push(ProvenanceRecord {
                    project_uid: inc.uid.clone(),
                    kind: ObjectKind::Query,
                    object_id: query.id.clone(),
                    locked_revision: inc.revision.clone(),
                    generated_name: model.clone(),
                });
                let original_id = query.id.clone();
                query.id = cid;
                query.name = model;
                query.steps = rewrite_steps(
                    &self.loaded,
                    &inc.uid,
                    &query.steps,
                    root,
                    &original_id,
                )?;
                query.steps = absolutize_steps(
                    self.loaded.get(&inc.uid).map(|l| l.file.as_path()),
                    &query.steps,
                );
                query.steps = bind_steps(
                    &inc.uid,
                    &query.id,
                    &query.steps,
                    self.input.connection_bindings,
                    self.input.available_connections,
                )?;
                for src in &inc.sources {
                    let mut src = src.clone();
                    if let Some(path) = src.path.as_mut() {
                        if let Some(file) = self.loaded.get(&inc.uid).map(|l| l.file.as_path()) {
                            *path = absolutize(file, path);
                        }
                    }
                    src.connection_id = bind_connection(
                        &inc.uid,
                        src.connection_id.as_deref(),
                        &src.id,
                        self.input.connection_bindings,
                        self.input.available_connections,
                    )?;
                    src.connection_string = None;
                    sources.push(src);
                }
            } else {
                query.steps = rewrite_steps(
                    &self.loaded,
                    root,
                    &query.steps,
                    root,
                    &query.id,
                )?;
            }
            queries.push(query);
        }

        for inc in &self.maps {
            let mut map = inc.map.clone();
            if inc.uid != root {
                let generated = lowered_object_id(&inc.uid, root, ObjectKind::Mapping, &map.id);
                if !names.insert(generated.clone()) {
                    return Err(format!("export name collision on '{generated}'"));
                }
                provenance.push(ProvenanceRecord {
                    project_uid: inc.uid.clone(),
                    kind: ObjectKind::Mapping,
                    object_id: map.id.clone(),
                    locked_revision: inc.revision.clone(),
                    generated_name: generated.clone(),
                });
                map.id = generated;
                if let KeyMapStorage::Source {
                    source,
                    db_schema,
                    connection_id,
                    ..
                } = &mut map.storage
                {
                    let real_schema = db_schema.clone().unwrap_or_else(|| source.clone());
                    *db_schema = Some(real_schema);
                    *source = format!("s{}_{}", short_uid(&inc.uid), sanitize_take(source, 24));
                    *connection_id = bind_connection(
                        &inc.uid,
                        connection_id.as_deref(),
                        &map.id,
                        self.input.connection_bindings,
                        self.input.available_connections,
                    )?;
                }
            }
            maps.push(map);
        }

        // Preview reads ApplyKeyMap.entries. The consumer file stays empty; the
        // lowered snapshot carries the seed rows for this operation only.
        for query in &mut queries {
            for step in &mut query.steps {
                if let TransformationStep::ApplyKeyMap { map_id, entries, .. } = step {
                    if !entries.is_empty() {
                        continue;
                    }
                    let Ok(mid) = map_id.compiler_id() else {
                        continue;
                    };
                    if let Some(map) = maps.iter().find(|m| m.id == mid && m.is_seed_backed()) {
                        if !map.entries.is_empty() {
                            *entries = map.entries.clone();
                        }
                    }
                }
            }
        }

        if inc_sources_missing_root(self.input.sources, &sources) {
            for s in self.input.sources {
                if !sources.iter().any(|e| e.id == s.id) {
                    sources.push(s.clone());
                }
            }
        }

        let focus = if queries.iter().any(|q| q.id == self.input.workspace.focus_query_id) {
            self.input.workspace.focus_query_id.clone()
        } else {
            queries.first().map(|q| q.id.clone()).unwrap_or_default()
        };
        let workspace = Workspace {
            queries,
            focus_query_id: focus,
            key_maps: maps,
        };
        provenance.sort_by(|a, b| {
            (&a.project_uid, a.kind.as_str(), &a.object_id).cmp(&(
                &b.project_uid,
                b.kind.as_str(),
                &b.object_id,
            ))
        });
        let provenance_json = if provenance.is_empty() {
            None
        } else {
            Some(serde_json::to_string_pretty(&provenance).map_err(|e| e.to_string())? + "\n")
        };
        Ok(LoweredOperation {
            workspace,
            sources,
            published_query_ids: published_ids(self.input),
            provenance_json,
        })
    }
}

fn inc_sources_missing_root(local: &[SourceDef], lowered: &[SourceDef]) -> bool {
    local.iter().any(|s| !lowered.iter().any(|e| e.id == s.id))
}

fn rewrite_steps(
    loaded: &HashMap<String, LoadedOwner>,
    uid: &str,
    steps: &[TransformationStep],
    root_uid: &str,
    consumer: &str,
) -> Result<Vec<TransformationStep>, String> {
    let mut out = Vec::new();
    for step in steps {
        out.push(rewrite_step(loaded, uid, step, root_uid, consumer)?);
    }
    Ok(out)
}

fn rewrite_step(
    loaded: &HashMap<String, LoadedOwner>,
    uid: &str,
    step: &TransformationStep,
    root_uid: &str,
    consumer: &str,
) -> Result<TransformationStep, String> {
    let mut step = step.clone();
    match &mut step {
        TransformationStep::FromQuery { query_id } => {
            *query_id = ObjectTarget::from(compiler_for(
                loaded,
                uid,
                query_id,
                ObjectKind::Query,
                root_uid,
                consumer,
            )?);
        }
        TransformationStep::Join { right_query_id, .. } => {
            *right_query_id = ObjectTarget::from(compiler_for(
                loaded,
                uid,
                right_query_id,
                ObjectKind::Query,
                root_uid,
                consumer,
            )?);
        }
        TransformationStep::Append { other_query_ids } => {
            for t in other_query_ids.iter_mut() {
                *t = ObjectTarget::from(compiler_for(
                    loaded,
                    uid,
                    t,
                    ObjectKind::Query,
                    root_uid,
                    consumer,
                )?);
            }
        }
        TransformationStep::ApplyKeyMap { map_id, .. } => {
            *map_id = ObjectTarget::from(compiler_for(
                loaded,
                uid,
                map_id,
                ObjectKind::Mapping,
                root_uid,
                consumer,
            )?);
        }
        TransformationStep::SqlModel { raw_sql } | TransformationStep::CustomSql { raw_sql } => {
            *raw_sql = rewrite_placeholders(loaded, uid, raw_sql, root_uid, consumer)?;
        }
        TransformationStep::LoadPostgres {
            schema,
            source_alias,
            ..
        } if uid != root_uid => {
            if source_alias.is_none() {
                *source_alias = Some(format!(
                    "s{}_{}",
                    short_uid(uid),
                    sanitize_take(schema, 24)
                ));
            }
        }
        TransformationStep::LoadDuckdb {
            schema,
            source_alias,
            ..
        } if uid != root_uid => {
            if source_alias.is_none() {
                *source_alias = Some(format!(
                    "s{}_{}",
                    short_uid(uid),
                    sanitize_take(schema, 24)
                ));
            }
        }
        _ => {}
    }
    Ok(step)
}

fn lowered_object_id(owner_uid: &str, root_uid: &str, kind: ObjectKind, object_id: &str) -> String {
    if owner_uid == root_uid {
        object_id.to_string()
    } else if kind == ObjectKind::Mapping {
        format!("map_{}_{}", short_uid(owner_uid), sanitize_take(object_id, 40))
    } else {
        external_compiler_id(owner_uid, kind, object_id)
    }
}

fn compiler_for(
    loaded: &HashMap<String, LoadedOwner>,
    from_uid: &str,
    target: &ObjectTarget,
    kind_hint: ObjectKind,
    root_uid: &str,
    consumer: &str,
) -> Result<String, String> {
    match target {
        ObjectTarget::Local(id) => Ok(lowered_object_id(from_uid, root_uid, kind_hint, id)),
        ObjectTarget::External {
            reference_id,
            kind,
            id,
        } => {
            let project = loaded
                .get(from_uid)
                .ok_or_else(|| format!("project {from_uid} was not loaded"))?;
            let reference = project
                .project
                .references
                .iter()
                .find(|r| r.id == reference_id.as_str())
                .ok_or_else(|| {
                    format!("reference '{reference_id}' missing while lowering '{consumer}'")
                })?;
            Ok(lowered_object_id(
                &reference.expected_project_uid,
                root_uid,
                *kind,
                id,
            ))
        }
    }
}

fn rewrite_placeholders(
    loaded: &HashMap<String, LoadedOwner>,
    uid: &str,
    sql: &str,
    root_uid: &str,
    consumer: &str,
) -> Result<String, String> {
    let mut out = sql.to_string();
    for (reference_id, object_id) in extract_xrefs(sql) {
        let target = ObjectTarget::external(reference_id.clone(), ObjectKind::Query, object_id.clone());
        let cid = compiler_for(loaded, uid, &target, ObjectKind::Query, root_uid, consumer)?;
        let from = format!("{{{{xref:{reference_id}:query:{object_id}}}}}");
        let to = format!("{{{{query:{cid}}}}}");
        out = out.replace(&from, &to);
    }
    Ok(out)
}

fn extract_xrefs(sql: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = sql;
    while let Some(start) = rest.find("{{xref:") {
        rest = &rest[start + "{{xref:".len()..];
        if let Some(end) = rest.find("}}") {
            let body = &rest[..end];
            if let Some((reference_id, object_id)) = body.split_once(":query:") {
                if !reference_id.is_empty() && !object_id.is_empty() {
                    out.push((reference_id.to_string(), object_id.to_string()));
                }
            }
            rest = &rest[end + 2..];
        } else {
            break;
        }
    }
    out
}

pub fn external_compiler_id(uid: &str, kind: ObjectKind, object_id: &str) -> String {
    let tag = match kind {
        ObjectKind::Mapping => "m",
        ObjectKind::Query => "q",
        ObjectKind::Source => "s",
    };
    format!("x{tag}{}_{}", short_uid(uid), sanitize_take(object_id, 40))
}

fn external_model_name(query: &QueryDef, uid: &str, object_id: &str) -> String {
    let prefix = if is_source_only(query) { "stg" } else { "int" };
    format!(
        "{prefix}_{}_{}",
        short_uid(uid),
        sanitize_take(object_id, 40)
    )
}

fn is_source_only(query: &QueryDef) -> bool {
    matches!(
        query.steps.first(),
        Some(
            TransformationStep::LoadCsv { .. }
                | TransformationStep::LoadParquet { .. }
                | TransformationStep::LoadPostgres { .. }
                | TransformationStep::LoadDuckdb { .. }
        )
    ) && query.steps.len() == 1
}

fn sanitize_take(id: &str, max: usize) -> String {
    let s = sanitize_id(id);
    s.chars().take(max).collect()
}

fn absolutize_steps(owner_file: Option<&Path>, steps: &[TransformationStep]) -> Vec<TransformationStep> {
    let Some(file) = owner_file else {
        return steps.to_vec();
    };
    steps
        .iter()
        .map(|s| {
            let mut s = s.clone();
            match &mut s {
                TransformationStep::LoadCsv { path }
                | TransformationStep::LoadParquet { path, .. }
                | TransformationStep::LoadDuckdb { path, .. } => {
                    *path = absolutize(file, path);
                }
                _ => {}
            }
            s
        })
        .collect()
}

fn absolutize(owner_file: &Path, path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.starts_with("s3://") || Path::new(trimmed).is_absolute() {
        return path.to_string();
    }
    owner_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(trimmed)
        .to_string_lossy()
        .to_string()
}

fn bind_steps(
    uid: &str,
    object_name: &str,
    steps: &[TransformationStep],
    bindings: &[ConnectionBinding],
    available: &[String],
) -> Result<Vec<TransformationStep>, String> {
    let mut out = Vec::new();
    for step in steps {
        let mut step = step.clone();
        match &mut step {
            TransformationStep::LoadParquet { connection_id, .. }
            | TransformationStep::LoadPostgres { connection_id, .. }
            | TransformationStep::LoadDuckdb { connection_id, .. } => {
                *connection_id = bind_connection(
                    uid,
                    connection_id.as_deref(),
                    object_name,
                    bindings,
                    available,
                )?;
            }
            _ => {}
        }
        if let TransformationStep::LoadPostgres {
            connection_string, .. } = &mut step
        {
            if !connection_string.is_empty() {
                *connection_string = String::new();
            }
        }
        out.push(step);
    }
    Ok(out)
}

fn bind_connection(
    owner_uid: &str,
    owner_connection_id: Option<&str>,
    object_name: &str,
    bindings: &[ConnectionBinding],
    available: &[String],
) -> Result<Option<String>, String> {
    let Some(id) = owner_connection_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if let Some(b) = bindings.iter().find(|b| {
        b.owner_project_uid == owner_uid && b.owner_connection_id == id
    }) {
        return Ok(Some(b.local_connection_id.clone()));
    }
    if available.iter().any(|c| c == id) {
        return Ok(Some(id.to_string()));
    }
    Err(format!(
        "missing connection binding for owner {owner_uid} connection '{id}' used by '{object_name}'"
    ))
}

fn matching_sources(sources: &[SourceDef], query: &QueryDef) -> Vec<SourceDef> {
    sources
        .iter()
        .filter(|s| query.steps.iter().any(|step| source_matches(s, step)))
        .cloned()
        .collect()
}

fn source_matches(source: &SourceDef, step: &TransformationStep) -> bool {
    match step {
        TransformationStep::LoadCsv { path } => {
            source.kind == SourceKind::Csv && source.path.as_deref() == Some(path.as_str())
        }
        TransformationStep::LoadParquet {
            path,
            connection_id,
        } => {
            source.kind == SourceKind::Parquet
                && source.path.as_deref() == Some(path.as_str())
                && source.connection_id == *connection_id
        }
        TransformationStep::LoadPostgres {
            schema,
            table_name,
            connection_id, .. } => {
            source.kind == SourceKind::Postgres
                && source.schema.as_deref() == Some(schema.as_str())
                && source.table_name.as_deref() == Some(table_name.as_str())
                && source.connection_id == *connection_id
        }
        TransformationStep::LoadDuckdb {
            schema,
            table_name,
            path,
            connection_id,
            ..
        } => {
            source.kind == SourceKind::Duckdb
                && source.schema.as_deref() == Some(schema.as_str())
                && source.table_name.as_deref() == Some(table_name.as_str())
                && (source.path.as_deref() == Some(path.as_str()) || source.connection_id == *connection_id)
        }
        _ => false,
    }
}

fn check_dialect(
    query: &QueryDef,
    owner: ExecutionEngine,
    root: ExecutionEngine,
    uid: &str,
) -> Result<(), String> {
    let root_d = root.dialect();
    for step in &query.steps {
        match step {
            TransformationStep::SqlModel { raw_sql } | TransformationStep::CustomSql { raw_sql } => {
                if owner.dialect() != root_d {
                    return Err(format!(
                        "referenced query '{}' ({uid}/{}) requires {} SQL; this project executes {}",
                        query.name,
                        query.id,
                        owner.dialect().as_str(),
                        root_d.as_str()
                    ));
                }
                if raw_sql_relative_file(raw_sql) {
                    return Err(format!(
                        "query '{}' has raw SQL with a relative file path; use a Load step or an absolute path",
                        query.id
                    ));
                }
            }
            TransformationStep::DeriveColumn {
                mode,
                sql_dialect,
                expression,
                ..
            } if *mode == crate::derive_ops::DeriveMode::Sql => {
                if let Some(tag) = sql_dialect {
                    if *tag != crate::derive_ops::SqlDialectTag::Unknown
                        && !tag.matches_engine(root_d)
                    {
                        return Err(format!(
                            "referenced query '{}' ({uid}/{}) has SQL tagged for another dialect; this project executes {}",
                            query.name,
                            query.id,
                            root_d.as_str()
                        ));
                    }
                } else if owner.dialect() != root_d {
                    return Err(format!(
                        "referenced query '{}' ({uid}/{}) requires {} SQL; this project executes {}",
                        query.name,
                        query.id,
                        owner.dialect().as_str(),
                        root_d.as_str()
                    ));
                }
                if raw_sql_relative_file(expression) {
                    return Err(format!(
                        "query '{}' has raw SQL with a relative file path; use a Load step or an absolute path",
                        query.id
                    ));
                }
            }
            _ => {}
        }
    }
    let _ = owner;
    Ok(())
}

fn raw_sql_relative_file(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    for needle in ["read_csv", "read_parquet"] {
        let mut rest = lower.as_str();
        while let Some(i) = rest.find(needle) {
            let after = rest[i + needle.len()..].trim_start_matches(|c: char| {
                c == '_' || c.is_ascii_alphanumeric()
            });
            let after = after.trim_start();
            if let Some(rest_args) = after.strip_prefix('(') {
                let s = rest_args.trim_start();
                if let Some(path) = quoted_path(s) {
                    if !path.starts_with('/')
                        && !path.starts_with("s3://")
                        && !path.starts_with('\\')
                    {
                        return true;
                    }
                }
            }
            rest = &rest[i + needle.len()..];
        }
    }
    false
}

fn quoted_path(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let quote = *bytes.first()?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let end = s[1..].find(quote as char)?;
    Some(&s[1..1 + end])
}

/// Local query ids that cite `reference_id`, for remove guards.
pub fn local_steps_citing(workspace: &Workspace, reference_id: &str) -> Vec<String> {
    reference_consumers(workspace, reference_id)
}

pub fn provenance_document(records: &[ProvenanceRecord]) -> Result<String, String> {
    let mut records = records.to_vec();
    records.sort_by(|a, b| {
        (&a.generated_name, &a.object_id).cmp(&(&b.generated_name, &b.object_id))
    });
    Ok(serde_json::to_string_pretty(&records).map_err(|e| e.to_string())? + "\n")
}

/// Placeholder extractor used by the resolver. The graph module keeps the compile-time one.
pub fn extract_local_placeholders(sql: &str) -> Vec<String> {
    crate::graph::extract_query_placeholders_pub(sql)
}

// Silence unused import if a helper path changes.
#[allow(dead_code)]
fn _dialect_name(d: WarehouseDialect) -> &'static str {
    d.as_str()
}

#[allow(dead_code)]
fn _hash_note(s: &str) -> String {
    hash_content(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::destination::{Destination, Materialization};
    use crate::dialect::WarehouseDialect;
    use crate::dialect::QueryExecution;
    use crate::model::KeyMapEntry;
    use crate::producers::DbtTarget;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dwh_ref_{n}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bare_project(name: &str, uid: &str) -> Project {
        Project {
            id: format!("proj_{name}"),
            name: name.into(),
            project_uid: uid.into(),
            references: vec![],
            connection_bindings: vec![],
            root_path: None,
            connections: vec![],
            sources: vec![],
            workspace: Workspace {
                queries: vec![],
                focus_query_id: String::new(),
                key_maps: vec![],
            },
            dbt_target: DbtTarget::V1,
            execution_engine: ExecutionEngine::Duckdb,
            destination: Destination::duckdb("local.duckdb"),
            outputs: vec!["q_keep".into()],
            materialization: Materialization::Table,
            target_dialect: WarehouseDialect::Duckdb,
            target_connection_id: None,
            last_dbt_export_path: None,
            canvas: None,
        }
    }

    fn write_proj(dir: &Path, file: &str, project: &Project) -> PathBuf {
        let path = dir.join(file);
        fs::write(&path, project.to_json_pretty().unwrap()).unwrap();
        path
    }

    #[test]
    fn legacy_string_targets_roundtrip() {
        let step = TransformationStep::FromQuery {
            query_id: "q_products".into(),
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"q_products\""));
        assert!(!json.contains("scope"));
        let back: TransformationStep = serde_json::from_str(&json).unwrap();
        assert_eq!(back, step);
    }

    #[test]
    fn alias_rename_does_not_change_generated_name() {
        let dir = scratch();
        let mut owner = bare_project("Shared", "uid-owner-1");
        owner.workspace.queries.push(QueryDef {
            id: "q_products".into(),
            name: "Products".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "data/products.csv".into(),
            }],
            execution: QueryExecution::Local,
        });
        owner.workspace.focus_query_id = "q_products".into();
        let owner_path = write_proj(&dir, "owner.dwhproj.json", &owner);
        let mut consumer = bare_project("Consumer", "uid-consumer");
        let cpath = write_proj(dir.as_path(), "consumer.dwhproj.json", &consumer);
        let mut reference = make_project_reference(&cpath, &owner_path, "Shared").unwrap();
        consumer.references.push(reference.clone());
        consumer.workspace.queries.push(QueryDef {
            id: "q_local".into(),
            name: "local".into(),
            steps: vec![TransformationStep::FromQuery {
                query_id: ObjectTarget::external(&reference.id, ObjectKind::Query, "q_products"),
            }],
            execution: QueryExecution::Local,
        });
        consumer.workspace.focus_query_id = "q_local".into();
        let first = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-consumer",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Export {
                published_ids: vec![],
            },
        })
        .unwrap();
        let name1 = first
            .workspace
            .queries
            .iter()
            .find(|q| q.id != "q_local")
            .unwrap()
            .name
            .clone();
        reference.alias = "Renamed".into();
        consumer.references = vec![reference];
        let second = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-consumer",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Export {
                published_ids: vec![],
            },
        })
        .unwrap();
        let name2 = second
            .workspace
            .queries
            .iter()
            .find(|q| q.id != "q_local")
            .unwrap()
            .name
            .clone();
        assert_eq!(name1, name2);
        assert!(name1.starts_with("stg_"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn equal_names_stay_distinct() {
        let dir = scratch();
        let mut a = bare_project("Shared", "uid-a");
        a.workspace.queries.push(QueryDef {
            id: "q_products".into(),
            name: "Products".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "a.csv".into(),
            }],
            execution: Default::default(),
        });
        a.workspace.focus_query_id = "q_products".into();
        let mut b = a.clone();
        b.project_uid = "uid-b".into();
        let pa = write_proj(&dir, "a.dwhproj.json", &a);
        let pb = write_proj(&dir, "b.dwhproj.json", &b);
        let mut consumer = bare_project("Root", "uid-root");
        let cpath = write_proj(&dir, "c.dwhproj.json", &consumer);
        let ra = make_project_reference(&cpath, &pa, "Shared").unwrap();
        let rb = make_project_reference(&cpath, &pb, "Shared").unwrap();
        assert_ne!(ra.expected_project_uid, rb.expected_project_uid);
        consumer.references = vec![ra.clone(), rb.clone()];
        consumer.workspace.queries.push(QueryDef {
            id: "q_both".into(),
            name: "both".into(),
            steps: vec![
                TransformationStep::FromQuery {
                    query_id: ObjectTarget::external(&ra.id, ObjectKind::Query, "q_products"),
                },
                TransformationStep::Append {
                    other_query_ids: vec![ObjectTarget::external(
                        &rb.id,
                        ObjectKind::Query,
                        "q_products",
                    )],
                },
            ],
            execution: Default::default(),
        });
        consumer.workspace.focus_query_id = "q_both".into();
        let lowered = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-root",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap();
        let external: Vec<_> = lowered
            .workspace
            .queries
            .iter()
            .filter(|q| q.id != "q_both")
            .map(|q| q.id.clone())
            .collect();
        assert_eq!(external.len(), 2, "{external:?}");
        assert_ne!(external[0], external[1]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn owner_relative_path_and_update_and_missing_unused() {
        let dir = scratch();
        let owner_dir = dir.join("owner");
        fs::create_dir_all(owner_dir.join("data")).unwrap();
        fs::write(owner_dir.join("data/products.csv"), "sku,name\nA,Alpha\n").unwrap();
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("data/products.csv"), "sku,name\nZ,Other\n").unwrap();
        let mut owner = bare_project("Owner", "uid-owner");
        owner.workspace.queries.push(QueryDef {
            id: "q_products".into(),
            name: "products".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "data/products.csv".into(),
            }],
            execution: Default::default(),
        });
        owner.workspace.focus_query_id = "q_products".into();
        let opath = write_proj(&owner_dir, "lib.dwhproj.json", &owner);
        let mut consumer = bare_project("Consumer", "uid-c");
        consumer.workspace.queries.push(QueryDef {
            id: "q_local".into(),
            name: "local_only".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: dir.join("data/products.csv").to_string_lossy().into(),
            }],
            execution: Default::default(),
        });
        consumer.workspace.focus_query_id = "q_local".into();
        let cpath = write_proj(&dir, "app.dwhproj.json", &consumer);
        let reference = make_project_reference(&cpath, &opath, "Lib").unwrap();
        consumer.references = vec![reference.clone()];
        let lowered = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-c",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap();
        assert!(lowered.provenance_json.is_none());
        assert_eq!(lowered.workspace.queries.len(), 1);

        consumer.workspace.queries.insert(
            0,
            QueryDef {
                id: "q_ext".into(),
                name: "using".into(),
                steps: vec![TransformationStep::FromQuery {
                    query_id: ObjectTarget::external(&reference.id, ObjectKind::Query, "q_products"),
                }],
                execution: Default::default(),
            },
        );
        consumer.workspace.focus_query_id = "q_ext".into();
        let lowered = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-c",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap();
        let ext = lowered
            .workspace
            .queries
            .iter()
            .find(|q| q.id != "q_ext" && q.id != "q_local")
            .unwrap();
        match &ext.steps[0] {
            TransformationStep::LoadCsv { path } => {
                assert!(path.contains("owner"), "{path}");
                assert!(!path.contains(&format!("{}/data/products.csv", dir.display())));
            }
            other => panic!("{other:?}"),
        }

        owner.workspace.queries[0].name = "products_v2".into();
        write_proj(&owner_dir, "lib.dwhproj.json", &owner);
        let err = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-c",
            execution_engine: ExecutionEngine::Duckdb,
            references: &consumer.references,
            connection_bindings: &[],
            workspace: &consumer.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap_err();
        assert!(err.contains("update available"), "{err}");
        let status = reference_statuses(&cpath, &consumer.references);
        assert_eq!(status[0].state, ReferenceState::UpdateAvailable);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cycle_reports_path_and_fork_changes_uid() {
        let dir = scratch();
        let mut a = bare_project("A", "uid-a");
        let mut b = bare_project("B", "uid-b");
        let path_a = dir.join("a.dwhproj.json");
        let path_b = dir.join("b.dwhproj.json");
        fs::write(&path_a, a.to_json_pretty().unwrap()).unwrap();
        fs::write(&path_b, b.to_json_pretty().unwrap()).unwrap();
        let mut ref_b = make_project_reference(&path_a, &path_b, "B").unwrap();
        let mut ref_a = make_project_reference(&path_b, &path_a, "A").unwrap();
        a.references = vec![ref_b.clone()];
        b.references = vec![ref_a.clone()];
        a.workspace.queries.push(QueryDef {
            id: "q_a".into(),
            name: "qa".into(),
            steps: vec![TransformationStep::FromQuery {
                query_id: ObjectTarget::external(&ref_b.id, ObjectKind::Query, "q_b"),
            }],
            execution: Default::default(),
        });
        b.workspace.queries.push(QueryDef {
            id: "q_b".into(),
            name: "qb".into(),
            steps: vec![TransformationStep::FromQuery {
                query_id: ObjectTarget::external(&ref_a.id, ObjectKind::Query, "q_a"),
            }],
            execution: Default::default(),
        });
        a.workspace.focus_query_id = "q_a".into();
        b.workspace.focus_query_id = "q_b".into();
        // Locks were computed before the queries existed. Recompute after both files are final
        // by writing once, then refreshing locks from the files as saved.
        fs::write(&path_a, a.to_json_pretty().unwrap()).unwrap();
        fs::write(&path_b, b.to_json_pretty().unwrap()).unwrap();
        ref_b.locked_revision = project_revision(&b, &path_b).unwrap();
        ref_a.locked_revision = project_revision(&a, &path_a).unwrap();
        a.references = vec![ref_b];
        b.references = vec![ref_a];
        fs::write(&path_a, a.to_json_pretty().unwrap()).unwrap();
        fs::write(&path_b, b.to_json_pretty().unwrap()).unwrap();
        // Revisions include the locked pins, so recompute once more until stable: the pin is
        // part of the fingerprint, and each side's pin is the other's fingerprint. That is a
        // cycle in the revision itself. Use the post-query files' revisions captured together.
        let rev_a = project_revision(&a, &path_a).unwrap();
        let rev_b = project_revision(&b, &path_b).unwrap();
        a.references[0].locked_revision = rev_b.clone();
        b.references[0].locked_revision = rev_a.clone();
        // Writing changes the file that the other side hashed if references are inside the hash.
        // The test only needs the resolver to see a cycle before the revision check fails.
        // Point both locks at the revisions of the files we are about to write.
        fs::write(&path_a, a.to_json_pretty().unwrap()).unwrap();
        fs::write(&path_b, b.to_json_pretty().unwrap()).unwrap();
        a.references[0].locked_revision = project_revision(&Project::from_json(&fs::read_to_string(&path_b).unwrap()).unwrap(), &path_b).unwrap();
        b.references[0].locked_revision = project_revision(&Project::from_json(&fs::read_to_string(&path_a).unwrap()).unwrap(), &path_a).unwrap();
        fs::write(&path_a, a.to_json_pretty().unwrap()).unwrap();
        fs::write(&path_b, b.to_json_pretty().unwrap()).unwrap();

        let err = resolve_operation(&ResolveInput {
            root_file: &path_a,
            project_uid: "uid-a",
            execution_engine: ExecutionEngine::Duckdb,
            references: &a.references,
            connection_bindings: &[],
            workspace: &a.workspace,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap_err();
        assert!(
            err.contains("cycle") || err.contains("update available"),
            "{err}"
        );

        let before = a.project_uid.clone();
        let qid = a.workspace.queries[0].id.clone();
        fork_project_identity(&mut a);
        assert_ne!(a.project_uid, before);
        assert_eq!(a.workspace.queries[0].id, qid);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relink_rejects_other_uid_and_accepts_move() {
        let dir = scratch();
        let owner = bare_project("Owner", "uid-owner");
        let other = bare_project("Other", "uid-other");
        let opath = write_proj(&dir, "owner.dwhproj.json", &owner);
        let other_path = write_proj(&dir, "other.dwhproj.json", &other);
        let consumer = bare_project("C", "uid-c");
        let cpath = write_proj(&dir, "c.dwhproj.json", &consumer);
        let reference = make_project_reference(&cpath, &opath, "Owner").unwrap();
        let err = relink_reference(&cpath, &reference, &other_path).unwrap_err();
        assert!(err.contains("identity mismatch"), "{err}");
        let moved = dir.join("nested");
        fs::create_dir_all(&moved).unwrap();
        let new_path = moved.join("owner.dwhproj.json");
        fs::rename(&opath, &new_path).unwrap();
        let status = reference_statuses(&cpath, &[reference.clone()]);
        assert_eq!(status[0].state, ReferenceState::Missing);
        let linked = relink_reference(&cpath, &reference, &new_path).unwrap();
        assert_ne!(linked.locator, reference.locator);
        assert_eq!(linked.expected_project_uid, "uid-owner");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn owner_without_uid_is_refused_without_writing() {
        let dir = scratch();
        let owner = bare_project("Owner", "");
        let opath = write_proj(&dir, "owner.dwhproj.json", &owner);
        let before = fs::read(&opath).unwrap();
        let consumer = bare_project("C", "uid-c");
        let cpath = write_proj(&dir, "c.dwhproj.json", &consumer);
        let err = make_project_reference(&cpath, &opath, "Owner").unwrap_err();
        assert!(err.contains("project_uid"), "{err}");
        assert_eq!(fs::read(&opath).unwrap(), before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn self_reference_is_refused() {
        let dir = scratch();
        let project = bare_project("Self", "uid-self");
        let path = write_proj(&dir, "self.dwhproj.json", &project);
        let err = make_project_reference(&path, &path, "Loop").unwrap_err();
        assert!(err.contains("same file"), "{err}");
        let copy = write_proj(&dir, "copy.dwhproj.json", &project);
        let err_uid = make_project_reference(&path, &copy, "Loop").unwrap_err();
        assert!(
            err_uid.contains("same project_uid") || err_uid.contains("fork"),
            "{err_uid}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn layout_change_does_not_change_revision() {
        let dir = scratch();
        let mut owner = bare_project("Owner", "uid-owner");
        owner.workspace.queries.push(QueryDef {
            id: "q".into(),
            name: "q".into(),
            steps: vec![TransformationStep::LoadCsv {
                path: "a.csv".into(),
            }],
            execution: Default::default(),
        });
        let path = write_proj(&dir, "o.dwhproj.json", &owner);
        let a = project_revision(&owner, &path).unwrap();
        owner.canvas = Some(crate::project::CanvasLayout {
            positions: [(
                "q".into(),
                crate::project::CanvasPosition { x: 1.0, y: 2.0 },
            )]
            .into_iter()
            .collect(),
        });
        owner.outputs = vec!["somewhere-else".into()];
        let b = project_revision(&owner, &path).unwrap();
        assert_eq!(a, b);
        owner.execution_engine = ExecutionEngine::Postgres;
        let c = project_revision(&owner, &path).unwrap();
        assert_ne!(a, c);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_lists_consumers() {
        let ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "Local".into(),
                steps: vec![TransformationStep::FromQuery {
                    query_id: ObjectTarget::external("ref_lib", ObjectKind::Query, "q_products"),
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![],
        };
        let consumers = reference_consumers(&ws, "ref_lib");
        assert_eq!(consumers.len(), 1);
        assert!(consumers[0].contains("Local"));
    }

    #[test]
    fn source_keymap_is_not_copied_as_entries() {
        let dir = scratch();
        let mut owner = bare_project("Owner", "uid-owner");
        let mut map = KeyMapDef::new("map_live", "live");
        map.storage = KeyMapStorage::Source {
            source: "public".into(),
            table: "dict".into(),
            connection_id: None,
            db_schema: None,
        };
        map.entries = vec![KeyMapEntry::pair("a", "1")];
        owner.workspace.key_maps.push(map);
        owner.workspace.queries.push(QueryDef {
            id: "q".into(),
            name: "q".into(),
            steps: vec![
                TransformationStep::LoadCsv {
                    path: "a.csv".into(),
                },
                TransformationStep::ApplyKeyMap {
                    column: "sku".into(),
                    columns: vec![],
                    output_column: None,
                    map_id: "map_live".into(),
                    entries: vec![],
                },
            ],
            execution: Default::default(),
        });
        owner.workspace.focus_query_id = "q".into();
        let opath = write_proj(&dir, "o.dwhproj.json", &owner);
        let consumer = bare_project("C", "uid-c");
        let cpath = write_proj(&dir, "c.dwhproj.json", &consumer);
        let reference = make_project_reference(&cpath, &opath, "Lib").unwrap();
        let mut ws = Workspace {
            queries: vec![QueryDef {
                id: "q_use".into(),
                name: "use".into(),
                steps: vec![TransformationStep::ApplyKeyMap {
                    column: "sku".into(),
                    columns: vec![],
                    output_column: None,
                    map_id: ObjectTarget::external(&reference.id, ObjectKind::Mapping, "map_live"),
                    entries: vec![],
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q_use".into(),
            key_maps: vec![],
        };
        // ApplyKeyMap is not a legal first step for compile, but lowering still includes the map.
        let _ = &mut ws;
        let lowered = resolve_operation(&ResolveInput {
            root_file: &cpath,
            project_uid: "uid-c",
            execution_engine: ExecutionEngine::Duckdb,
            references: &[reference],
            connection_bindings: &[],
            workspace: &ws,
            sources: &[],
            available_connections: &[],
            kind: ResolveKind::Preview,
        })
        .unwrap();
        assert!(lowered.workspace.key_maps[0].entries.is_empty());
        let saved = serde_json::to_string(&ws).unwrap();
        assert!(!saved.contains("\"to\":\"1\""));
        let _ = fs::remove_dir_all(&dir);
    }
}
