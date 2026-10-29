//! App preferences: `~/.dwhforge-query/settings.json`.

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
    #[serde(default = "default_explorer_width")]
    pub explorer_width_px: u32,
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

pub fn load_settings() -> Result<AppSettings, String> {
    let path = dwh_home_dir()?.join("settings.json");
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
    fs::write(path, json).map_err(|e| e.to_string())
}
