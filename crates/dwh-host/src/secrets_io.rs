//! Local secrets file: `~/.dwhforge-query/secrets.json` (mode 0600 when possible).

use dwh_pipeline::{merge_project_secrets, project_for_disk, Project, SecretsFile};
use std::fs;
use std::path::PathBuf;

pub fn dwh_home_dir() -> Result<PathBuf, String> {
    let home = dirs_next_home().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home.join(".dwhforge-query"))
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn secrets_path() -> Result<PathBuf, String> {
    Ok(dwh_home_dir()?.join("secrets.json"))
}

pub fn load_secrets_file() -> Result<SecretsFile, String> {
    let path = secrets_path()?;
    if !path.is_file() {
        return Ok(SecretsFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid secrets.json: {e}"))
}

pub fn save_secrets_file(file: &SecretsFile) -> Result<(), String> {
    let dir = dwh_home_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("secrets.json");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn save_project_with_secrets(path: &str, project: &Project) -> Result<(), String> {
    let (disk, secrets) = project_for_disk(project);
    let json = disk.to_json_pretty()?;
    if let Some(parent) = PathBuf::from(path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, json).map_err(|e| e.to_string())?;

    let mut store = load_secrets_file()?;
    store.projects.insert(project.id.clone(), secrets);
    save_secrets_file(&store)?;
    Ok(())
}

pub fn load_project_with_secrets(path: &str) -> Result<Project, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut project = Project::from_json(&raw)?;
    project.root_path = None;
    let store = load_secrets_file()?;
    if let Some(map) = store.projects.get(&project.id) {
        merge_project_secrets(&mut project, map);
    }
    Ok(project)
}
