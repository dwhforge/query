# OpenCode V2 integration tasks

- [x] Verify updated feature/matching_redesign contains the standalone CLI; preserve its Host and IR boundaries.
- [x] Implement bounded OpenCode V2 plugin invoking CLI via typed argv rather than shell strings.
- [x] Add separate-workspace installation, skill discovery, symlink refusal and no implicit model-provider configuration.
- [x] Add password-required localhost OpenCode Web launcher, remote SSH instructions and tests.
- [x] Add a business-language two-CSV fixture, mock adapter tests and documented limits.
- [ ] Verify official OpenCode V2 tool registration with a configured model in an installed runtime.
- [ ] Run real Rust Host + DuckDB CSV -> JOIN -> aggregation -> export -> Electron-reopen journey.
- [ ] Compare accuracy, coverage, tokens, user effort and time against the same harness without DWHQuery.
- [ ] Evaluate privacy and OS-level restrictions for deployments beyond single-user loopback.
