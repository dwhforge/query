//! Guided dbt venv install into `~/.dwhforge-query/dbt-venv` ([ADR-0023](../../../docs/adr/0023-dbt-setup-onboarding.md)).

use crate::secrets_io::dwh_home_dir;
use crate::settings_io::{self, dbt_bin_in_venv};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const DBT_PACKAGES: &[&str] = &[
    "dbt-core>=1.7,<2",
    "dbt-duckdb>=1.7,<2",
    "dbt-postgres>=1.7,<2",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbtSetupStatus {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbt_path: Option<String>,
    pub python_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_path: Option<String>,
    pub suggested_venv: String,
    pub dismissed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbtInstallResult {
    pub venv_path: String,
    pub dbt_path: String,
    pub version_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbtInstallScript {
    pub shell: String,
    pub script: String,
    pub suggested_venv: String,
}

pub fn suggested_venv_path() -> Result<PathBuf, String> {
    Ok(dwh_home_dir()?.join("dbt-venv"))
}

fn find_python() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        for cand in ["py", "python", "python3"] {
            if let Some(p) = which_bin(cand) {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        which_bin("python3").or_else(|| which_bin("python"))
    }
}

fn which_bin(name: &str) -> Option<PathBuf> {
    let out = Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(name)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    Some(PathBuf::from(line))
}

fn run_checked(cmd: &mut Command, label: &str) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{label}: failed to spawn: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "{label} failed (exit {}): {detail}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(stdout)
}

pub fn setup_status(dbt_candidates: &[PathBuf]) -> Result<DbtSetupStatus, String> {
    let settings = settings_io::load_settings().unwrap_or_default();
    let suggested = suggested_venv_path()?;
    let resolved = dwh_pipeline::resolve_dbt_bin(dbt_candidates);
    let python = find_python();
    Ok(DbtSetupStatus {
        found: resolved.as_ref().is_some_and(|p| p.is_file()),
        dbt_path: resolved.map(|p| p.to_string_lossy().into_owned()),
        python_ok: python.is_some(),
        python_path: python.map(|p| p.to_string_lossy().into_owned()),
        suggested_venv: suggested.to_string_lossy().into_owned(),
        dismissed: settings.dbt_setup_dismissed,
    })
}

pub fn install_script() -> Result<DbtInstallScript, String> {
    let venv = suggested_venv_path()?;
    let venv_s = venv.to_string_lossy();
    #[cfg(windows)]
    {
        let py = r#"python"#;
        let script = format!(
            r#"{py} -m venv "{venv_s}"
& "{venv_s}\Scripts\python.exe" -m pip install --upgrade pip
& "{venv_s}\Scripts\python.exe" -m pip install "dbt-core>=1.7,<2" "dbt-duckdb>=1.7,<2" "dbt-postgres>=1.7,<2"
& "{venv_s}\Scripts\dbt.exe" --version
"#
        );
        Ok(DbtInstallScript {
            shell: "powershell".into(),
            script,
            suggested_venv: venv_s.into_owned(),
        })
    }
    #[cfg(not(windows))]
    {
        let script = format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
VENV="{venv_s}"
python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install \
  'dbt-core>=1.7,<2' \
  'dbt-duckdb>=1.7,<2' \
  'dbt-postgres>=1.7,<2'
"$VENV/bin/dbt" --version
"#
        );
        Ok(DbtInstallScript {
            shell: "bash".into(),
            script,
            suggested_venv: venv_s.into_owned(),
        })
    }
}

/// Create/update app-home venv and install dbt packages (may take minutes).
pub fn install_dbt_venv() -> Result<DbtInstallResult, String> {
    let python = find_python().ok_or_else(|| {
        "python3 not found on PATH. Install Python 3, then retry — or use Copy install script."
            .to_string()
    })?;
    let venv = suggested_venv_path()?;
    if let Some(parent) = venv.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    run_checked(
        Command::new(&python).args(["-m", "venv", &venv.to_string_lossy()]),
        "python -m venv",
    )?;

    let venv_python = if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    };
    if !venv_python.is_file() {
        return Err(format!(
            "venv python missing after create: {}",
            venv_python.display()
        ));
    }

    run_checked(
        Command::new(&venv_python).args(["-m", "pip", "install", "--upgrade", "pip"]),
        "pip upgrade",
    )?;

    let mut pip = Command::new(&venv_python);
    pip.args(["-m", "pip", "install"]);
    for pkg in DBT_PACKAGES {
        pip.arg(pkg);
    }
    run_checked(&mut pip, "pip install dbt")?;

    let dbt = dbt_bin_in_venv(&venv);
    if !dbt.is_file() {
        return Err(format!("dbt binary missing after install: {}", dbt.display()));
    }
    let version_out = run_checked(Command::new(&dbt).arg("--version"), "dbt --version")?;
    let version_line = version_out
        .lines()
        .next()
        .unwrap_or("dbt installed")
        .to_string();

    // Persist path + mark dismissed.
    let mut settings = settings_io::load_settings().unwrap_or_default();
    settings.dbt_venv_path = venv.to_string_lossy().into_owned();
    settings.dbt_setup_dismissed = true;
    settings.normalize_for_save();
    settings_io::save_settings(&settings)?;

    Ok(DbtInstallResult {
        venv_path: venv.to_string_lossy().into_owned(),
        dbt_path: dbt.to_string_lossy().into_owned(),
        version_line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_script_mentions_packages() {
        let s = install_script().expect("home dir");
        assert!(s.script.contains("dbt-core"));
        assert!(s.script.contains("dbt-duckdb"));
        assert!(!s.suggested_venv.is_empty());
    }

    #[test]
    fn suggested_venv_ends_with_dbt_venv() {
        let p = suggested_venv_path().expect("home");
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("dbt-venv"));
    }
}
