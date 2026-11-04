# Proposal: typed-wire-contract

## Why

Stop dual-maintaining IR/IPC shapes in TS and opaque JSON in Rust. ADR-0029.

## In scope

- Rust MappingCheck / CheckRun / related IR on Project
- ts-rs export → `src/types/generated/`
- CI freshness check
- Structured `HostError` (and use on new/updated commands)
- TS re-exports; helpers stay in TS

## Out of scope

- format_version migrations (next)
- Job scheduler / DuckDB ownership rewrite
- Mapping rows out of IR
- Big-bang rewrite of all IPC methods

## Related

- ADR-0029, ADR-0027
