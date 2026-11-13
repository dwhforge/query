# Design: Local preview ownership and cancellation

Bind each transient result to the exact input workspace snapshot, connections,
sources and project-file context already supplied to the preview command. Only
render it if those inputs still match; this is an ephemeral result token, not a
second editable workspace. Derive messages from a small UI-only phase enum.

Replace the unowned debounce closure with a local effect timeout that is cleared
on cleanup/cancel. Bump the existing generation at input change and before both
cache and host paths. Clear cache when authoring inputs change and on explicit
Recompute; no new compiler or hash system. Keep errors in ErrorBanner.

Test-only one-shot preview holds reuse the existing gated Electron bridge pattern,
still issuing real host calls. Reproducers precede runtime changes. Add late-response,
retry, empty-result and sample/full/scope checks; verify the flagship remains offline.
