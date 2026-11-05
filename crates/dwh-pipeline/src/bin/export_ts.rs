//! Export Rust IR wire types to TypeScript (ADR-0029).
//!
//! Run via `scripts/export-ts-types.sh` or `cargo run -p dwh-pipeline --bin export-ts`.
//! Host DTOs are appended by `export-ts-host` (same script).

use std::path::PathBuf;

use dwh_pipeline::{
    ApplyKeyMapOutputBinding, CheckDeltaAttribution, CheckRun, KeyMapAuthoringContext,
    MappingCheck,
};
use ts_rs::TS;

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/types/generated");
    std::fs::create_dir_all(&out).expect("create generated dir");

    MappingCheck::export_all_to(&out).expect("export MappingCheck");
    CheckRun::export_all_to(&out).expect("export CheckRun");
    CheckDeltaAttribution::export_all_to(&out).expect("export CheckDeltaAttribution");
    KeyMapAuthoringContext::export_all_to(&out).expect("export KeyMapAuthoringContext");
    ApplyKeyMapOutputBinding::export_all_to(&out).expect("export ApplyKeyMapOutputBinding");

    // Index is finalized by export-ts-host after this bin runs.
    eprintln!("exported pipeline IR → {}", out.display());
}
