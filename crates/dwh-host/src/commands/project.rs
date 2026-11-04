//! Project persistence commands (ADR-0013 / ADR-0030 / ADR-0032 / ADR-0029).

use crate::error::{HostError, RpcError};
use crate::secrets_io;
use dwh_pipeline::Project;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// IPC args for `save_project` (ADR-0029 wire DTO).
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectArgs {
    pub path: String,
    /// Full project document — typed in Rust; TS uses pipeline `Project` until exported.
    #[ts(type = "import(\"../pipeline\").Project")]
    pub project: Project,
}

/// IPC args for `load_project` (ADR-0029 wire DTO).
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
pub struct LoadProjectArgs {
    pub path: String,
    /// When true, update last-opened session path (Open / Restore). Peek loads stay false.
    #[serde(default)]
    #[ts(optional)]
    pub remember: Option<bool>,
}

pub fn save_project(args: SaveProjectArgs) -> Result<Project, RpcError> {
    secrets_io::save_project_with_secrets(&args.path, &args.project).map_err(|e| {
        HostError::validation(format!("Failed to save project: {e}")).into()
    })
}

pub fn load_project(args: LoadProjectArgs) -> Result<(Project, bool), RpcError> {
    let mut project = secrets_io::load_project_with_secrets(&args.path).map_err(|e| {
        if e.contains("Unsupported project format_version") {
            HostError::unsupported(e)
        } else {
            HostError::validation(format!("Failed to load project: {e}"))
        }
    })?;
    project.root_path = Some(args.path.clone());
    let remember = args.remember.unwrap_or(false);
    Ok((project, remember))
}
