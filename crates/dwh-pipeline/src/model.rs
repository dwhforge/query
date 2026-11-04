use crate::connection::ConnectionDef;
use crate::derive_ops::{DeriveMode, DeriveOp, SqlDialectTag};
use crate::dialect::QueryExecution;
use serde::{Deserialize, Serialize};

fn default_pg_schema() -> String {
    "public".into()
}

/// Cross-project object kind ([ADR-0025](../../../docs/adr/0025-project-references.md)).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Source,
    Query,
    Mapping,
}

impl ObjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ObjectKind::Source => "source",
            ObjectKind::Query => "query",
            ObjectKind::Mapping => "mapping",
        }
    }

    pub fn tag(self) -> char {
        match self {
            ObjectKind::Source => 's',
            ObjectKind::Query => 'q',
            ObjectKind::Mapping => 'm',
        }
    }
}

/// Local id (bare string on disk) or a reference to an object in another project.
///
/// External form: `{ "scope": "reference", "reference_id", "kind", "id" }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ObjectTarget {
    Local(String),
    External {
        reference_id: String,
        kind: ObjectKind,
        id: String,
    },
}

impl ObjectTarget {
    pub fn external(reference_id: impl Into<String>, kind: ObjectKind, id: impl Into<String>) -> Self {
        ObjectTarget::External {
            reference_id: reference_id.into(),
            kind,
            id: id.into(),
        }
    }

    pub fn is_external(&self) -> bool {
        matches!(self, ObjectTarget::External { .. })
    }

    /// Id the existing compilers understand. External targets must be lowered first.
    pub fn compiler_id(&self) -> Result<&str, String> {
        match self {
            ObjectTarget::Local(id) => Ok(id.as_str()),
            ObjectTarget::External {
                reference_id,
                kind,
                id,
            } => Err(format!(
                "unresolved external {} '{id}' via reference '{reference_id}'",
                kind.as_str()
            )),
        }
    }
}

impl From<&str> for ObjectTarget {
    fn from(id: &str) -> Self {
        ObjectTarget::Local(id.to_string())
    }
}

impl From<String> for ObjectTarget {
    fn from(id: String) -> Self {
        ObjectTarget::Local(id)
    }
}

impl std::fmt::Display for ObjectTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectTarget::Local(id) => f.write_str(id),
            ObjectTarget::External {
                reference_id,
                kind,
                id,
            } => write!(f, "reference:{reference_id}:{}:{id}", kind.as_str()),
        }
    }
}

impl Serialize for ObjectTarget {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ObjectTarget::Local(id) => serializer.serialize_str(id),
            ObjectTarget::External {
                reference_id,
                kind,
                id,
            } => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("scope", "reference")?;
                map.serialize_entry("reference_id", reference_id)?;
                map.serialize_entry("kind", kind)?;
                map.serialize_entry("id", id)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ObjectTarget {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::String(id) => Ok(ObjectTarget::Local(id)),
            serde_json::Value::Object(map) => {
                let scope = map.get("scope").and_then(|v| v.as_str()).unwrap_or("");
                if scope != "reference" {
                    return Err(serde::de::Error::custom(
                        "object target scope must be \"reference\" or a local id string",
                    ));
                }
                let reference_id = map
                    .get("reference_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let id = map.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if reference_id.is_empty() || id.is_empty() {
                    return Err(serde::de::Error::custom(
                        "external target needs reference_id and id",
                    ));
                }
                let kind = map
                    .get("kind")
                    .cloned()
                    .ok_or_else(|| serde::de::Error::custom("external target needs kind"))?;
                let kind: ObjectKind = serde_json::from_value(kind).map_err(serde::de::Error::custom)?;
                Ok(ObjectTarget::External {
                    reference_id,
                    kind,
                    id,
                })
            }
            _ => Err(serde::de::Error::custom(
                "object target must be a string or a reference object",
            )),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JoinType {
    Inner,
    Left,
    Right,
    Full,
}

impl JoinType {
    pub fn sql_keyword(&self) -> &'static str {
        match self {
            JoinType::Inner => "INNER JOIN",
            JoinType::Left => "LEFT JOIN",
            JoinType::Right => "RIGHT JOIN",
            JoinType::Full => "FULL OUTER JOIN",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum TransformationStep {
    LoadCsv { path: String },
    LoadParquet {
        path: String,
        /// Project Connection id (`s3`) for remote paths — ADR-0012.
        #[serde(default)]
        connection_id: Option<String>,
    },
    LoadPostgres {
        /// Preferred: Project Connection id (`postgres`).
        #[serde(default)]
        connection_id: Option<String>,
        /// Legacy / resolved DSN (filled when connection_id absent).
        #[serde(default)]
        connection_string: String,
        #[serde(default = "default_pg_schema")]
        schema: String,
        table_name: String,
        /// dbt `source()` name when it must differ from `schema` (external projects).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_alias: Option<String>,
    },
    /// Read a relation from an attached DuckDB database file (read-only source).
    LoadDuckdb {
        #[serde(default)]
        connection_id: Option<String>,
        /// Absolute / project-relative path to `.duckdb` when connection_id absent.
        #[serde(default)]
        path: String,
        #[serde(default = "default_pg_schema")]
        schema: String,
        table_name: String,
        /// dbt `source()` name when it must differ from `schema` (external projects).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_alias: Option<String>,
    },
    /// Start from another query’s output (`ref` in dbt). Must be the first step.
    FromQuery { query_id: ObjectTarget },
    /// Hand-written SQL as the query root (ready-made model body). Must be first.
    /// Dialect = author’s prod warehouse; DuckDB is preview-only.
    SqlModel { raw_sql: String },
    Filter { condition: String },
    SelectColumns { columns: Vec<String> },
    RenameColumn { from: String, to: String },
    /// Derived column: ready-made op or free SQL (legacy projects = Sql + expression).
    DeriveColumn {
        name: String,
        /// Free SQL when `mode=sql` (also set when migrating legacy projects).
        #[serde(default)]
        expression: String,
        #[serde(default)]
        mode: DeriveMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<DeriveOp>,
        /// Dialect of `expression` when mode=sql; unknown if not determinable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sql_dialect: Option<SqlDialectTag>,
    },
    GroupBy {
        dimensions: Vec<String>,
        aggregates: Vec<String>,
    },
    SortBy { column: String, descending: bool },
    /// Keep first N rows after prior steps (typically after SortBy).
    Limit { n: u64 },
    Join {
        right_query_id: ObjectTarget,
        join_type: JoinType,
        left_on: Vec<String>,
        right_on: Vec<String>,
    },
    Append { other_query_ids: Vec<ObjectTarget> },
    CustomSql { raw_sql: String },
    /// Deterministic key cleanup before Join (trim/case/spaces/zeros). Overwrites in place.
    NormalizeKey {
        columns: Vec<String>,
        ops: Vec<NormalizeOp>,
    },
    /// Remap join-key values via a KeyMap (`from` → `to`, or From tuple → to).
    /// Soft-migrate: legacy `column` → `columns: [column]` ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    ApplyKeyMap {
        /// Legacy single fact column (arity 1). Prefer `columns` when set.
        #[serde(default)]
        column: String,
        /// Fact columns matching KeyMap `from_columns` (ordered).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        columns: Vec<String>,
        /// Where COALESCE(map.to, …) is written (default: first of columns).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_column: Option<String>,
        /// Fact event-time column for range SCD maps ([ADR-0028](../../../docs/adr/0028-keymap-stewardship-shapes.md)).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        as_of_column: Option<String>,
        map_id: ObjectTarget,
        #[serde(default)]
        entries: Vec<KeyMapEntry>,
    },
}

/// Optional effectivity mode for a KeyMap ([ADR-0028](../../../docs/adr/0028-keymap-stewardship-shapes.md)).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum KeyMapTimeMode {
    #[default]
    None,
    /// Rows carry valid_from / valid_to; Apply uses half-open range predicate.
    RangeScd,
}

/// One From→To alias row. Unique by trimmed From **tuple** within a [`KeyMapDef`].
/// Optional `attrs` hold whitelisted extra columns for Postgres source maps ([ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyMapEntry {
    /// Legacy / arity-1 convenience From. Prefer `from_parts` when arity > 1.
    #[serde(default)]
    pub from: String,
    /// From tuple aligned to [`KeyMapDef::from_columns_eff`] ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from_parts: Vec<String>,
    pub to: String,
    /// Extra editable column values (keys ⊆ `KeyMapDef.editable_columns`). Ignored by ApplyKeyMap join.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub attrs: std::collections::BTreeMap<String, String>,
}

impl KeyMapEntry {
    pub fn pair(from: impl Into<String>, to: impl Into<String>) -> Self {
        let from = from.into();
        Self {
            from: from.clone(),
            from_parts: vec![from],
            to: to.into(),
            attrs: std::collections::BTreeMap::new(),
        }
    }

    pub fn parts(from_parts: Vec<String>, to: impl Into<String>) -> Self {
        let from = from_parts.first().cloned().unwrap_or_default();
        Self {
            from,
            from_parts,
            to: to.into(),
            attrs: std::collections::BTreeMap::new(),
        }
    }

    /// Effective From parts (soft-migrate legacy `from`).
    pub fn from_parts_eff(&self) -> Vec<String> {
        if !self.from_parts.is_empty() {
            self.from_parts.clone()
        } else if !self.from.trim().is_empty() {
            vec![self.from.clone()]
        } else {
            vec![]
        }
    }
}

/// Effective ApplyKeyMap fact columns (soft-migrate legacy `column`).
pub fn apply_keymap_columns(column: &str, columns: &[String]) -> Vec<String> {
    if !columns.is_empty() {
        columns.to_vec()
    } else if !column.trim().is_empty() {
        vec![column.to_string()]
    } else {
        vec![]
    }
}

/// Where the From→To table lives (ADR-0020). Default = generated dbt seed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyMapStorage {
    /// Write / sync `seeds/map_*.csv` (git SoT after first export).
    #[default]
    Seed,
    /// Existing dbt model: `{{ ref('model') }}`.
    Ref {
        model: String,
    },
    /// Existing dbt source: `{{ source('name', 'table') }}`.
    Source {
        source: String,
        table: String,
        /// Optional Postgres connection for read/write-back (UI / host).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        /// Database schema when `source` is only the dbt source name (external projects).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        db_schema: Option<String>,
    },
}

fn default_from_col() -> String {
    "from".into()
}
fn default_to_col() -> String {
    "to".into()
}

/// User intent for how a KeyMap was authored from workspace queries
/// ([ADR-0034](../../../docs/adr/0034-keymap-authoring-context.md)).
/// Not ownership of a Join / MappingCheck — Apply consumers are computed separately.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyMapAuthoringContext {
    pub source_query_id: String,
    /// Ordered From columns on the source query (composite arity ≥ 1).
    pub source_columns: Vec<String>,
    pub target_query_id: String,
    pub target_column: String,
}

/// Named join-key alias table (project resource).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KeyMapDef {
    pub id: String,
    pub name: String,
    /// Row cache for editor / DuckDB preview (SoT when `storage=seed`).
    /// For `storage=source` at scale, prefer empty cache + paged WH reads ([ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)).
    #[serde(default)]
    pub entries: Vec<KeyMapEntry>,
    /// Backend relation — seed (default), dbt ref, or dbt source.
    #[serde(default)]
    pub storage: KeyMapStorage,
    /// Legacy single From column on the map relation (default `from`). Prefer `from_columns`.
    #[serde(default = "default_from_col")]
    pub from_column: String,
    /// From columns on the map relation (ordered). Soft-migrate: empty → `[from_column]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from_columns: Vec<String>,
    /// Column on the map relation used as To (default `to`).
    #[serde(default = "default_to_col")]
    pub to_column: String,
    /// Extra columns editable in the KeyMap UI (not From/To). Empty = from/to only.
    /// Seed export includes these after `to` ([ADR-0028](../../../docs/adr/0028-keymap-stewardship-shapes.md)).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub editable_columns: Vec<String>,
    /// Effectivity mode (default none = classic unique From).
    #[serde(default, skip_serializing_if = "is_time_mode_none")]
    pub time_mode: KeyMapTimeMode,
    /// Map column for range start when `time_mode = range_scd` (default `valid_from`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from_column: Option<String>,
    /// Map column for range end when `time_mode = range_scd` (default `valid_to`; NULL = open).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to_column: Option<String>,
    /// Optional creation intent from query-based mapping wizard ([ADR-0034](../../../docs/adr/0034-keymap-authoring-context.md)).
    /// Absent on legacy maps. No `format_version` bump (additive optional; old readers may drop on re-save).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authoring_context: Option<KeyMapAuthoringContext>,
}

fn is_time_mode_none(m: &KeyMapTimeMode) -> bool {
    matches!(m, KeyMapTimeMode::None)
}

impl KeyMapDef {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            entries: vec![],
            storage: KeyMapStorage::Seed,
            from_column: default_from_col(),
            from_columns: vec![],
            to_column: default_to_col(),
            editable_columns: vec![],
            time_mode: KeyMapTimeMode::None,
            valid_from_column: None,
            valid_to_column: None,
            authoring_context: None,
        }
    }

    pub fn valid_from_col_eff(&self) -> String {
        self.valid_from_column
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("valid_from")
            .to_string()
    }

    pub fn valid_to_col_eff(&self) -> String {
        self.valid_to_column
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("valid_to")
            .to_string()
    }

    /// Seed / relation columns after From+To: range bounds (if any) then editable attrs.
    pub fn stewardship_columns(&self) -> Vec<String> {
        let mut cols = Vec::new();
        if matches!(self.time_mode, KeyMapTimeMode::RangeScd) {
            cols.push(self.valid_from_col_eff());
            cols.push(self.valid_to_col_eff());
        }
        for c in &self.editable_columns {
            let t = c.trim();
            if t.is_empty() {
                continue;
            }
            if cols.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                continue;
            }
            cols.push(t.to_string());
        }
        cols
    }

    pub fn is_range_scd(&self) -> bool {
        matches!(self.time_mode, KeyMapTimeMode::RangeScd)
    }

    /// Effective From column names on the map relation ([ADR-0024](../../../docs/adr/0024-keymap-composite.md)).
    pub fn from_columns_eff(&self) -> Vec<String> {
        if !self.from_columns.is_empty() {
            self.from_columns.clone()
        } else if !self.from_column.trim().is_empty() {
            vec![self.from_column.clone()]
        } else {
            vec![default_from_col()]
        }
    }

    pub fn arity(&self) -> usize {
        self.from_columns_eff().len().max(1)
    }

    /// Reject empty / duplicate From **tuples** and empty `to` for seed-backed maps.
    pub fn validate(&self) -> Result<(), String> {
        match &self.storage {
            KeyMapStorage::Ref { model } => {
                if model.trim().is_empty() {
                    return Err(format!("KeyMap '{}': ref model is empty", self.id));
                }
            }
            KeyMapStorage::Source { source, table, .. } => {
                if source.trim().is_empty() || table.trim().is_empty() {
                    return Err(format!(
                        "KeyMap '{}': source name and table are required",
                        self.id
                    ));
                }
            }
            KeyMapStorage::Seed => {}
        }
        let from_cols = self.from_columns_eff();
        if from_cols.iter().any(|c| c.trim().is_empty()) || self.to_column.trim().is_empty() {
            return Err(format!(
                "KeyMap '{}': from_columns/to_column must be non-empty",
                self.id
            ));
        }
        let n = from_cols.len();
        let range = self.is_range_scd();
        let vf_col = self.valid_from_col_eff();
        let vt_col = self.valid_to_col_eff();
        // External relations may have empty local entries (SoT is the table).
        if matches!(self.storage, KeyMapStorage::Seed) || !self.entries.is_empty() {
            let mut seen = std::collections::HashSet::new();
            // from_key → list of (valid_from_epoch, valid_to_epoch_opt) for overlap checks
            let mut ranges: std::collections::BTreeMap<Vec<String>, Vec<(i64, Option<i64>)>> =
                std::collections::BTreeMap::new();
            for e in &self.entries {
                let parts = e.from_parts_eff();
                if parts.len() != n {
                    return Err(format!(
                        "KeyMap '{}': entry from_parts len {} != arity {n}",
                        self.id,
                        parts.len()
                    ));
                }
                let key: Vec<String> = parts.iter().map(|p| p.trim().to_string()).collect();
                if key.iter().any(|p| p.is_empty()) {
                    return Err(format!("KeyMap '{}': empty from part", self.id));
                }
                if e.to.is_empty() {
                    return Err(format!(
                        "KeyMap '{}': empty to for from {:?}",
                        self.id, key
                    ));
                }
                if range {
                    let vf_raw = e
                        .attrs
                        .get(&vf_col)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            format!(
                                "KeyMap '{}': range SCD requires {vf_col} for from {:?}",
                                self.id, key
                            )
                        })?;
                    let vf = parse_scd_bound(&vf_raw).map_err(|err| {
                        format!(
                            "KeyMap '{}': invalid {vf_col} '{vf_raw}' for from {:?}: {err}",
                            self.id, key
                        )
                    })?;
                    let vt_raw = e
                        .attrs
                        .get(&vt_col)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let vt = match &vt_raw {
                        None => None,
                        Some(end) => Some(parse_scd_bound(end).map_err(|err| {
                            format!(
                                "KeyMap '{}': invalid {vt_col} '{end}' for from {:?}: {err}",
                                self.id, key
                            )
                        })?),
                    };
                    if let Some(end) = vt {
                        if end <= vf {
                            return Err(format!(
                                "KeyMap '{}': {vt_col} must be > {vf_col} for from {:?} ({vf_raw} .. {})",
                                self.id,
                                key,
                                vt_raw.as_deref().unwrap_or("")
                            ));
                        }
                    }
                    ranges.entry(key).or_default().push((vf, vt));
                } else if !seen.insert(key.clone()) {
                    return Err(format!(
                        "KeyMap '{}': duplicate from tuple {:?}",
                        self.id, key
                    ));
                }
            }
            if range {
                for (key, mut ivals) in ranges {
                    // ivals: (epoch_secs, Option<epoch_secs>)
                    ivals.sort_by(|a, b| a.0.cmp(&b.0));
                    for w in ivals.windows(2) {
                        let (a_from, a_to) = &w[0];
                        let (b_from, _) = &w[1];
                        let a_end = a_to.unwrap_or(i64::MAX);
                        // Half-open [from,to): overlap if a_from < b_end && b_from < a_end
                        if *a_from < i64::MAX && *b_from < a_end {
                            return Err(format!(
                                "KeyMap '{}': overlapping ranges for from {:?} (epochs {a_from}..{a_end} vs {b_from}..)",
                                self.id, key
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn is_seed_backed(&self) -> bool {
        matches!(self.storage, KeyMapStorage::Seed)
    }
}

/// Parse SCD bound as UTC epoch seconds.
/// Formats: `YYYY-MM-DD` (midnight) or `YYYY-MM-DD[T ]HH:MM:SS[Z]`.
/// v1 rejects fractional seconds and timezone offsets (must match TS `scdBound.ts`).
/// Never panics on arbitrary input.
pub fn parse_scd_bound(raw: &str) -> Result<i64, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("empty bound".into());
    }
    // Strict whole-string match — no early byte slicing.
    let (date, time) = if let Some((d, t)) = s.split_once('T').or_else(|| s.split_once(' ')) {
        (d, Some(t))
    } else {
        (s, None)
    };
    if !is_ymd(date) {
        return Err("expected YYYY-MM-DD or YYYY-MM-DD[T ]HH:MM:SS[Z]".into());
    }
    let y: i32 = date[0..4].parse().map_err(|_| "invalid year".to_string())?;
    let m: u32 = date[5..7].parse().map_err(|_| "invalid month".to_string())?;
    let d: u32 = date[8..10].parse().map_err(|_| "invalid day".to_string())?;
    if !valid_civil(y, m, d) {
        return Err(format!("invalid calendar date {date}"));
    }
    let mut secs = civil_days_utc(y, m, d)? * 86_400;
    if let Some(t) = time {
        // No trim of the time part — must match TS exact regex (no space after T/ ).
        let t = if let Some(stripped) = t.strip_suffix('Z') {
            stripped
        } else {
            t
        };
        if t.contains('+') || t.contains('-') {
            return Err("timezone offsets not supported (use UTC / Z)".into());
        }
        if t.contains('.') {
            return Err("fractional seconds not supported in v1".into());
        }
        // Exact HH:MM:SS — reject garbage / short forms.
        if t.len() != 8 || t.as_bytes().get(2) != Some(&b':') || t.as_bytes().get(5) != Some(&b':')
        {
            return Err("expected HH:MM:SS[Z]".into());
        }
        if !t.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 2 || i == 5 {
                *b == b':'
            } else {
                b.is_ascii_digit()
            }
        }) {
            return Err("expected HH:MM:SS[Z]".into());
        }
        let hh: i64 = t[0..2].parse().map_err(|_| "invalid hour".to_string())?;
        let mm: i64 = t[3..5].parse().map_err(|_| "invalid minute".to_string())?;
        let ss: i64 = t[6..8].parse().map_err(|_| "invalid second".to_string())?;
        // Align with TS: seconds 00–59 only (no leap-second 60).
        if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) || !(0..=59).contains(&ss) {
            return Err("time out of range".into());
        }
        secs += hh * 3600 + mm * 60 + ss;
    }
    Ok(secs)
}

fn is_ymd(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[5].is_ascii_digit()
        && b[6].is_ascii_digit()
        && b[8].is_ascii_digit()
        && b[9].is_ascii_digit()
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn valid_civil(y: i32, m: u32, d: u32) -> bool {
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

#[cfg(test)]
mod scd_bound_tests {
    use super::parse_scd_bound;

    #[test]
    fn rejects_lexicographic_fruit() {
        assert!(parse_scd_bound("apple").is_err());
        assert!(parse_scd_bound("banana").is_err());
    }

    #[test]
    fn date_order() {
        let a = parse_scd_bound("2024-01-01").unwrap();
        let b = parse_scd_bound("2024-06-01").unwrap();
        assert!(a < b);
    }

    #[test]
    fn rejects_invalid_calendar_and_garbage() {
        assert!(parse_scd_bound("2026-02-31").is_err());
        assert!(parse_scd_bound("2026-13-01").is_err());
        assert!(parse_scd_bound("2026-11-03T25:00:00").is_err());
        assert!(parse_scd_bound("2026-11-03T10:00:00garbage").is_err());
        assert!(parse_scd_bound("2026-11-03T10:00:00+03:00").is_err());
        assert!(parse_scd_bound("+").is_err());
        assert!(parse_scd_bound("+03:00").is_err());
        assert!(parse_scd_bound("abc+").is_err());
        assert!(parse_scd_bound("2026-11-03T10:00:00.100Z").is_err());
        assert!(parse_scd_bound("2026-11-03T10:00:60").is_err());
        assert!(parse_scd_bound("2026-11-03T 10:00:00").is_err());
    }

    #[test]
    fn timestamp_keeps_time_of_day() {
        let a = parse_scd_bound("2026-11-03T10:00:00").unwrap();
        let b = parse_scd_bound("2026-11-03T11:00:00").unwrap();
        assert_eq!(b - a, 3600);
        let noonish = parse_scd_bound("2026-11-03T10:30:00").unwrap();
        assert!(noonish > a && noonish < b);
    }

    #[test]
    fn never_panics_on_fuzz_inputs() {
        for s in ["", "+", "-", "T", " ", "🚀", "2026-02-31", "....", "10:00:00"] {
            let _ = parse_scd_bound(s);
        }
    }
}

/// Days since Unix epoch (UTC), Howard Hinnant civil-from-days inverse.
fn civil_days_utc(y: i32, m: u32, d: u32) -> Result<i64, String> {
    let mut y = y;
    let m = m as i32;
    let d = d as i32;
    if m <= 2 {
        y -= 1;
    }
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = (yoe * 365 + yoe / 4 - yoe / 100 + doy as u32) as i64;
    Ok(era as i64 * 146_097 + doe - 719_468)
}

/// Deterministic normalize ops (near-miss Apply → NormalizeKey). Order = nest order.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NormalizeOp {
    Trim,
    Lower,
    Upper,
    CollapseSpace,
    LtrimZeros,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct QueryDef {
    pub id: String,
    pub name: String,
    pub steps: Vec<TransformationStep>,
    /// Preview engine for this node only (ADR-0014). Default `local` (DuckDB).
    #[serde(default)]
    pub execution: QueryExecution,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Workspace {
    pub queries: Vec<QueryDef>,
    pub focus_query_id: String,
    /// Join-key alias maps (ADR-0020). Source of truth in project JSON; seeds on export.
    #[serde(default)]
    pub key_maps: Vec<KeyMapDef>,
}

impl Workspace {
    pub fn from_linear_steps(steps: Vec<TransformationStep>) -> Self {
        Self {
            queries: vec![QueryDef {
                id: "main".into(),
                name: "main".into(),
                steps,
                execution: QueryExecution::default(),
            }],
            focus_query_id: "main".into(),
            key_maps: vec![],
        }
    }

    pub fn key_map(&self, id: &str) -> Option<&KeyMapDef> {
        self.key_maps.iter().find(|m| m.id == id)
    }

    pub fn query(&self, id: &str) -> Option<&QueryDef> {
        self.queries.iter().find(|q| q.id == id)
    }

    pub fn uses_postgres(&self) -> bool {
        let load = self.queries.iter().any(|q| {
            q.steps
                .iter()
                .any(|s| matches!(s, TransformationStep::LoadPostgres { .. }))
        });
        if load {
            return true;
        }
        // ADR-0022: source KeyMaps also need Postgres ATTACH for preview ApplyKeyMap.
        self.key_maps.iter().any(|km| {
            matches!(
                km.storage,
                KeyMapStorage::Source {
                    connection_id: Some(_), .. }
            )
        })
    }

    /// Collect connection ids referenced by Load* steps and source KeyMaps.
    pub fn referenced_connection_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for q in &self.queries {
            for s in &q.steps {
                match s {
                    TransformationStep::LoadParquet {
                        connection_id: Some(id),
                        ..
                    }
                    | TransformationStep::LoadPostgres {
                        connection_id: Some(id), .. } => {
                        if !ids.contains(id) {
                            ids.push(id.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        for km in &self.key_maps {
            if let KeyMapStorage::Source {
                connection_id: Some(id), .. } = &km.storage
            {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }

    /// DSNs for source-backed KeyMaps (id → DSN), for preview ATTACH.
    pub fn source_key_map_dsns(
        &self,
        connections: &[crate::connection::ConnectionDef],
    ) -> Result<std::collections::HashMap<String, String>, String> {
        let mut out = std::collections::HashMap::new();
        for km in &self.key_maps {
            if let KeyMapStorage::Source {
                connection_id: Some(cid), .. } = &km.storage
            {
                let c = connections
                    .iter()
                    .find(|c| &c.id == cid)
                    .ok_or_else(|| format!("Unknown connection_id '{cid}' for KeyMap '{}'", km.id))?;
                let dsn = c.postgres_dsn().ok_or_else(|| {
                    format!("Connection '{cid}' is not a postgres connection with DSN")
                })?;
                out.insert(km.id.clone(), dsn.to_string());
            }
        }
        Ok(out)
    }

    /// Resolve `connection_id` → inline DSN for compile/runtime (does not strip ids).
    pub fn resolve_postgres_dsns(&self, connections: &[ConnectionDef]) -> Result<Workspace, String> {
        let mut out = self.clone();
        for q in &mut out.queries {
            for step in &mut q.steps {
                if let TransformationStep::LoadPostgres {
                    connection_id,
                    connection_string, .. } = step
                {
                    if let Some(cid) = connection_id {
                        let c = connections
                            .iter()
                            .find(|c| &c.id == cid)
                            .ok_or_else(|| format!("Unknown connection_id '{cid}'"))?;
                        let dsn = c.postgres_dsn().ok_or_else(|| {
                            format!("Connection '{cid}' is not a postgres connection with DSN")
                        })?;
                        *connection_string = dsn.to_string();
                    } else if connection_string.trim().is_empty() {
                        return Err(
                            "LoadPostgres requires connection_id or connection_string".into()
                        );
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod authoring_context_tests {
    use super::{KeyMapAuthoringContext, KeyMapDef, KeyMapStorage};

    #[test]
    fn authoring_context_round_trips_on_keymap() {
        let mut map = KeyMapDef::new("map_supplier", "Supplier→Catalog");
        map.authoring_context = Some(KeyMapAuthoringContext {
            source_query_id: "supplier_products".into(),
            source_columns: vec!["supplier_id".into(), "product_code".into()],
            target_query_id: "catalog_products".into(),
            target_column: "product_id".into(),
        });
        let json = serde_json::to_string_pretty(&map).unwrap();
        assert!(json.contains("authoring_context"));
        assert!(json.contains("supplier_id"));
        let back: KeyMapDef = serde_json::from_str(&json).unwrap();
        assert_eq!(back.authoring_context, map.authoring_context);
        assert_eq!(back.storage, KeyMapStorage::Seed);
    }

    #[test]
    fn legacy_keymap_without_authoring_context_deserializes() {
        let legacy = r#"{
            "id": "map_old",
            "name": "old",
            "entries": [{"from": "a", "to": "b"}],
            "storage": {"kind": "seed"},
            "from_column": "from",
            "to_column": "to"
        }"#;
        let map: KeyMapDef = serde_json::from_str(legacy).unwrap();
        assert!(map.authoring_context.is_none());
        let out = serde_json::to_value(&map).unwrap();
        assert!(out.get("authoring_context").is_none());
    }
}
