# Proposal: mapping-data-plane

## Why

Keep mapping row bodies out of the project IR for warehouse-backed maps (ADR-0033).

## In scope (slice 1)

- Load migrate: clear `entries` on `storage.kind=source`
- Document seed-inline vs source-paged contract
- Tests

## Out of scope

- Seed sidecar / Parquet store (format_version 2+)
- Changing Join / ApplyKeyMap semantics
