//! First-slice Matching run caps (ADR-0044).
//!
//! Project limits, not claimed optima. Align with HEAD fuzzy/LLM relatives —
//! do not invent a second near-duplicate set of magic numbers in UI panels.
//!
//! | Matching | Existing (HEAD) | Note |
//! |----------|-----------------|------|
//! | [`MASS_RUN_UNIQUE_KEYS`] = 200 | Join `KEY_SCAN_CAP` = 200 | Same order; Matching counts unique map keys in scope |
//! | [`RETRIEVAL_SHORTLIST_PER_KEY`] = 40 | Join `MAX_SUGGESTIONS` = 40 | Same number, **different unit** (per-key shortlist vs total suggestions) |
//! | [`LLM_CANDIDATES_PER_KEY`] = 10 | Join LLM universe list = 60 | Stricter per-request shortlist |
//! | [`LOCAL_TARGET_UNIVERSE_ROWS`] = 10_000 | Dictionary max = 250_000 | Above → server-side retrieval or refuse |
//! | Host message size | `llm_chat` ≤12_000 chars / prompt soft 10_500 | Still apply; Matching adds call/token budgets |

/// Trial run: unique map keys.
pub const TRIAL_UNIQUE_KEYS: usize = 20;

/// One mass run: unique map keys (aligns with Join `KEY_SCAN_CAP`).
pub const MASS_RUN_UNIQUE_KEYS: usize = 200;

/// Retrieval shortlist per map key (same number as Join `MAX_SUGGESTIONS`, per-key unit).
pub const RETRIEVAL_SHORTLIST_PER_KEY: usize = 40;

/// Candidates included in one LLM request per map key.
pub const LLM_CANDIDATES_PER_KEY: usize = 10;

/// Max target rows for a local full scan. Larger → server-side or refuse.
pub const LOCAL_TARGET_UNIVERSE_ROWS: usize = 10_000;

/// Parallel LLM requests within one run.
pub const PARALLEL_LLM_REQUESTS: usize = 2;

/// Automatic retries per LLM request.
pub const LLM_RETRIES_PER_REQUEST: usize = 1;

/// Total LLM calls per run including plan interpretation and retries.
pub const MAX_LLM_CALLS_PER_RUN: usize = 220;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_are_ordered_sensibly() {
        assert!(TRIAL_UNIQUE_KEYS < MASS_RUN_UNIQUE_KEYS);
        assert!(LLM_CANDIDATES_PER_KEY <= RETRIEVAL_SHORTLIST_PER_KEY);
        assert!(LOCAL_TARGET_UNIVERSE_ROWS > MASS_RUN_UNIQUE_KEYS);
        assert!(PARALLEL_LLM_REQUESTS >= 1);
        assert!(MAX_LLM_CALLS_PER_RUN >= MASS_RUN_UNIQUE_KEYS);
    }
}
