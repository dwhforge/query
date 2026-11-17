# Harness tools capability (experimental)

## Requirements

1. **Discoverability:** an external process invoking `dwhq tools` SHALL receive machine-readable tool descriptions without requiring Electron or an LLM provider.
2. **Project creation:** an agent SHALL be able to create a valid versioned Project using DWHQuery's canonical model, then add source queries and transformations through existing application logic.
3. **Host execution:** schema description, bounded previews, JOIN diagnostics and dbt export SHALL use the real Rust Host, not fabricated or embedded SQL results.
4. **Preserved provenance:** emitted project files SHALL be consumable by the ordinary desktop Project loader. The CLI SHALL not modify the desktop's last-opened project state.
5. **Data minimization:** raw rows SHALL be withheld from tool output by default. An operator-controlled opt-in SHALL be required to return raw samples.
6. **Write restrictions:** no command in the first version SHALL execute dbt builds or mutate external source databases.
7. **Conflict behavior:** conflicting CLI writers SHALL refuse to save; modifying the same project from Electron concurrently remains explicitly unsupported.
8. **Verification:** a mocked Host test MAY validate CLI control flow, but real DuckDB + desktop reopen SHALL be required before product-ready status.
