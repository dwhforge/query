//! App preferences: `~/.dwhforge-query/settings.json` (defaults / last-used).
//! Distinct from `secrets.json` and from per-project `.dwhproj.json`.

use crate::secrets_io::dwh_home_dir;
use dwh_pipeline::{DbtTarget, WarehouseDialect};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub default_target_dialect: WarehouseDialect,
    #[serde(default)]
    pub default_dbt_target: DbtTarget,
    /// Explorer sidebar width (px).
    #[serde(default = "default_explorer_width")]
    pub explorer_width_px: u32,
    /// Inspector sidebar width (px).
    #[serde(default = "default_inspector_width")]
    pub inspector_width_px: u32,
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
            explorer_width_px: default_explorer_width(),
            inspector_width_px: default_inspector_width(),
        }
    }
}

pub fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(dwh_home_dir()?.join("settings.json"))
}

pub fn load_settings() -> Result<AppSettings, String> {
    let path = settings_path()?;
    if !path.is_file() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid settings.json: {e}"))
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let dir = dwh_home_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip_json() {
        let s = AppSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.default_target_dialect, WarehouseDialect::Duckdb);
        assert_eq!(back.default_dbt_target, DbtTarget::V1);
    }

    #[test]
    fn missing_fields_use_defaults() {
        let back: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(back, AppSettings::default());
    }
}
