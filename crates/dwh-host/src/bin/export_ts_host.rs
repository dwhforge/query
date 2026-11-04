//! Export host wire types to TypeScript (ADR-0029).

use std::path::PathBuf;

use dwh_host::commands::keymap::{KeyMapReadResultDto, KeyMapWhArgs, KeyMapWriteResultDto};
use dwh_host::commands::project::{LoadProjectArgs, SaveProjectArgs};
use dwh_host::error::HostError;
use ts_rs::TS;

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/types/generated");
    std::fs::create_dir_all(&out).expect("create generated dir");

    HostError::export_all_to(&out).expect("export HostError");
    SaveProjectArgs::export_all_to(&out).expect("export SaveProjectArgs");
    LoadProjectArgs::export_all_to(&out).expect("export LoadProjectArgs");
    KeyMapWhArgs::export_all_to(&out).expect("export KeyMapWhArgs");
    KeyMapWriteResultDto::export_all_to(&out).expect("export KeyMapWriteResultDto");
    KeyMapReadResultDto::export_all_to(&out).expect("export KeyMapReadResultDto");

    let index = r#"/* eslint-disable */
/**
 * Generated from Rust via `scripts/export-ts-types.sh` (ADR-0029).
 * Do not edit by hand — regenerate instead.
 */
export type { CheckComparability } from "./CheckComparability";
export type { CheckDeltaAttribution } from "./CheckDeltaAttribution";
export type { MappingAllowDecision } from "./MappingAllowDecision";
export type { MappingCheckProjection } from "./MappingCheckProjection";
export type { MappingCheck } from "./MappingCheck";
export type { CheckInputRevision } from "./CheckInputRevision";
export type { CheckAggregateCell } from "./CheckAggregateCell";
export type { CheckRun } from "./CheckRun";
export type { HostError } from "./HostError";
export type { SaveProjectArgs } from "./SaveProjectArgs";
export type { LoadProjectArgs } from "./LoadProjectArgs";
export type { KeyMapWhArgs } from "./KeyMapWhArgs";
export type { KeyMapWriteResultDto } from "./KeyMapWriteResultDto";
export type { KeyMapReadResultDto } from "./KeyMapReadResultDto";
"#;
    std::fs::write(out.join("index.ts"), index).expect("write index.ts");
    eprintln!("exported host wire types → {}", out.display());
}
