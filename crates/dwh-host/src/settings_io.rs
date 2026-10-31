//! App preferences: `~/.dwhforge-query/settings.json`.
//! See [ADR-0021](../../../docs/adr/0021-app-options-recent-projects.md).

use crate::secrets_io::dwh_home_dir;
use dwh_pipeline::{DbtTarget, DestinationKind, ExecutionEngine, WarehouseDialect};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

fn default_llm_base_url() -> String {
    "https://api.openai.com/v1".into()
}

fn default_llm_model() -> String {
    "gpt-4o-mini".into()
}

/// OpenAI-compatible chat endpoint. `api_key` stays in this file (mode 0600 once set).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmSettings {
    #[serde(default = "default_llm_base_url")]
    pub base_url: String,
    #[serde(default = "default_llm_model")]
    pub model: String,
    /// Bearer token. Empty means the Join Lens chat is not connected.
    #[serde(default)]
    pub api_key: String,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            base_url: default_llm_base_url(),
            model: default_llm_model(),
            api_key: String::new(),
        }
    }
}

pub const RECENT_PROJECTS_MAX: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub default_target_dialect: WarehouseDialect,
    #[serde(default)]
    pub default_dbt_target: DbtTarget,
    /// Soft-migrate: absent in old files → derive from `default_target_dialect`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_execution_engine: Option<ExecutionEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_destination_kind: Option<DestinationKind>,
    /// Absolute path to a Python venv root that contains `bin/dbt` (or Windows `Scripts`).
    #[serde(default)]
    pub dbt_venv_path: String,
    #[serde(default)]
    pub recent_projects: Vec<String>,
    #[serde(default = "default_explorer_width")]
    pub explorer_width_px: u32,
    #[serde(default = "default_inspector_width")]
    pub inspector_width_px: u32,
    #[serde(default)]
    pub llm: LlmSettings,
}

fn default_explorer_width() -> u32 {
    240
}

fn default_inspector_width() -> u32 {
    300
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_target_dialect: WarehouseDialect::Duckdb,
            default_dbt_target: DbtTarget::V1,
            default_execution_engine: Some(ExecutionEngine::Duckdb),
            default_destination_kind: Some(DestinationKind::Duckdb),
            dbt_venv_path: String::new(),
            recent_projects: Vec::new(),
            explorer_width_px: default_explorer_width(),
            inspector_width_px: default_inspector_width(),
            llm: LlmSettings::default(),
        }
    }
}

impl AppSettings {
    pub fn execution_engine_default(&self) -> ExecutionEngine {
        self.default_execution_engine
            .unwrap_or_else(|| ExecutionEngine::from_dialect(self.default_target_dialect))
    }

    pub fn destination_kind_default(&self) -> DestinationKind {
        self.default_destination_kind.unwrap_or_else(|| {
            match self.execution_engine_default() {
                ExecutionEngine::Duckdb => DestinationKind::Duckdb,
                ExecutionEngine::Postgres => DestinationKind::Postgres,
            }
        })
    }

    /// Sync legacy dialect + fill Option engines before write (ADR-0021).
    pub fn normalize_for_save(&mut self) {
        let engine = self.execution_engine_default();
        let dest = self.destination_kind_default();
        self.default_execution_engine = Some(engine);
        self.default_destination_kind = Some(dest);
        self.default_target_dialect = engine.dialect();
        self.dbt_venv_path = self.dbt_venv_path.trim().to_string();
        if self.recent_projects.len() > RECENT_PROJECTS_MAX {
            self.recent_projects.truncate(RECENT_PROJECTS_MAX);
        }
    }
}

/// `{venv}/bin/dbt` or `{venv}/Scripts/dbt.exe`.
pub fn dbt_bin_in_venv(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("dbt.exe")
    } else {
        venv.join("bin").join("dbt")
    }
}

pub fn load_settings() -> Result<AppSettings, String> {
    let path = dwh_home_dir()?.join("settings.json");
    if !path.is_file() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid settings.json: {e}"))
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let mut normalized = settings.clone();
    normalized.normalize_for_save();
    let dir = dwh_home_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // The API key lives in this file. Tighten the mode once a key is present.
    #[cfg(unix)]
    if !normalized.llm.api_key.is_empty() {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_dialect_only_file_derives_engine() {
        let s: AppSettings = serde_json::from_str(
            r#"{"default_target_dialect":"postgres","default_dbt_target":"v1"}"#,
        )
        .unwrap();
        assert_eq!(s.execution_engine_default(), ExecutionEngine::Postgres);
        assert_eq!(s.destination_kind_default(), DestinationKind::Postgres);
    }

    #[test]
    fn dbt_bin_in_venv_unix_shape() {
        let p = dbt_bin_in_venv(Path::new("/opt/my-dbt"));
        if cfg!(windows) {
            assert!(p.ends_with("Scripts/dbt.exe") || p.ends_with(r"Scripts\dbt.exe"));
        } else {
            assert_eq!(p, PathBuf::from("/opt/my-dbt/bin/dbt"));
        }
    }
}
