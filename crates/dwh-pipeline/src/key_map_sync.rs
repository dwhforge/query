//! Seed ↔ KeyMap sync (ADR-0020): after first export, `seeds/map_*.csv` is SoT.

use crate::emit::{key_map_seed_csv, key_map_seed_name, parse_key_map_seed_csv};
use crate::export_manifest::{hash_content, load_manifest, manifest_path, ExportManifest};
use crate::model::{KeyMapDef, KeyMapEntry, TransformationStep, Workspace};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyMapSyncResult {
    pub updated_maps: usize,
    pub created_maps: usize,
    pub seed_files: Vec<String>,
}

/// Load `seeds/map_*.csv` from an export tree into `workspace.key_maps` and
/// refresh ApplyKeyMap entry snapshots. Seed wins (SoT after first export).
pub fn sync_key_maps_from_export(
    workspace: &mut Workspace,
    export_root: &Path,
) -> Result<KeyMapSyncResult, String> {
    let seeds_dir = export_root.join("seeds");
    if !seeds_dir.is_dir() {
        return Ok(KeyMapSyncResult {
            updated_maps: 0,
            created_maps: 0,
            seed_files: vec![],
        });
    }

    let mut updated = 0usize;
    let mut created = 0usize;
    let mut seed_files = Vec::new();

    let rd = fs::read_dir(&seeds_dir).map_err(|e| format!("read seeds/: {e}"))?;
    for ent in rd {
        let ent = ent.map_err(|e| e.to_string())?;
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("csv") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if !stem.starts_with("map_") {
            continue;
        }
        let body = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let entries = parse_key_map_seed_csv(&body)?;
        seed_files.push(format!("seeds/{stem}.csv"));

        let existing = workspace
            .key_maps
            .iter()
            .position(|m| key_map_seed_name(&m.id) == stem || m.id == stem);

        match existing {
            Some(i) => {
                workspace.key_maps[i].entries = entries.clone();
                updated += 1;
                patch_apply_snapshots(workspace, &workspace.key_maps[i].id.clone(), &entries);
            }
            None => {
                let id = stem.clone();
                let mut km = KeyMapDef::new(id.clone(), stem.clone());
                km.entries = entries.clone();
                workspace.key_maps.push(km);
                created += 1;
                patch_apply_snapshots(workspace, &id, &entries);
            }
        }
    }

    Ok(KeyMapSyncResult {
        updated_maps: updated,
        created_maps: created,
        seed_files,
    })
}

fn patch_apply_snapshots(workspace: &mut Workspace, map_id: &str, entries: &[KeyMapEntry]) {
    for q in &mut workspace.queries {
        for step in &mut q.steps {
            if let TransformationStep::ApplyKeyMap {
                map_id: mid,
                entries: step_entries,
                ..
            } = step
            {
                if mid == map_id || key_map_seed_name(mid) == map_id {
                    *step_entries = entries.to_vec();
                }
            }
        }
    }
}

/// Write one KeyMap to `seeds/map_*.csv` and refresh that path’s hash in the
/// export manifest so the next re-export does not treat it as a foreign edit.
pub fn push_key_map_to_export(
    export_root: &Path,
    map: &KeyMapDef,
) -> Result<String, String> {
    let seed = key_map_seed_name(&map.id);
    let rel = format!("seeds/{seed}.csv");
    let seeds_dir = export_root.join("seeds");
    fs::create_dir_all(&seeds_dir).map_err(|e| format!("mkdir seeds: {e}"))?;
    let body = key_map_seed_csv(&map.entries);
    let path = export_root.join(&rel);
    fs::write(&path, &body).map_err(|e| format!("write {rel}: {e}"))?;

    if let Some(mut manifest) = load_manifest(export_root)? {
        manifest.owned.insert(rel.clone(), hash_content(&body));
        write_manifest(export_root, &manifest)?;
    } else {
        let mut owned = std::collections::BTreeMap::new();
        owned.insert(rel.clone(), hash_content(&body));
        let manifest = ExportManifest {
            version: 1,
            pipeline_name: String::new(),
            dialect: String::new(),
            owned,
        };
        write_manifest(export_root, &manifest)?;
    }
    Ok(rel)
}

fn write_manifest(export_root: &Path, manifest: &ExportManifest) -> Result<(), String> {
    let p = manifest_path(export_root);
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(&p, raw).map_err(|e| format!("write {}: {e}", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{KeyMapEntry, QueryDef, TransformationStep};
    use std::path::PathBuf;

    #[test]
    fn sync_seed_updates_keymap_and_apply() {
        let dir = tempfile_dir();
        fs::create_dir_all(dir.join("seeds")).unwrap();
        fs::write(
            dir.join("seeds/map_channel.csv"),
            "from,to\nweb,online\napp,mobile\n",
        )
        .unwrap();

        let mut ws = Workspace {
            queries: vec![QueryDef {
                id: "q".into(),
                name: "q".into(),
                steps: vec![TransformationStep::ApplyKeyMap {
                    column: "channel".into(),
                    map_id: "map_channel".into(),
                    entries: vec![KeyMapEntry {
                        from: "old".into(),
                        to: "x".into(),
                    }],
                }],
                execution: Default::default(),
            }],
            focus_query_id: "q".into(),
            key_maps: vec![KeyMapDef::new("map_channel", "channel")],
        };

        let r = sync_key_maps_from_export(&mut ws, &dir).unwrap();
        assert_eq!(r.updated_maps, 1);
        assert_eq!(ws.key_maps[0].entries.len(), 2);
        assert_eq!(ws.key_maps[0].entries[0].to, "online");
        match &ws.queries[0].steps[0] {
            TransformationStep::ApplyKeyMap { entries, .. } => {
                assert_eq!(entries.len(), 2);
            }
            _ => panic!("expected ApplyKeyMap"),
        }
    }

    fn tempfile_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "dwh-keymap-sync-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
