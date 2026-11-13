# PR-02H report — bounded inline hints

Baseline: PR-02 commit 7f86c10. Before, Show me navigated without an opt-in
pointer. After, it enables two semantic goals, one visible hint at a time:
original Join selection, then actual No match mode. A selected Join skips the
first goal; actual probe mode completes the run even via an alternative route.

History and Join Lens have optional decorative slots; Lens reports its mode
read-only. Neither imports Help Lab state. Known hidden layouts use text fallback,
non-canvas tabs suspend hints, and inline flow follows resize without coordinate
tracking. Got it/Escape/card Dismiss stop hints until explicit Show me. No idle
escalation, timer, global overlay, event bus, automatic clicks or map edits.

Actual checks: 30/30 unit files, host/UI build and 6/6 journey Electron scenarios
passed. Electron exercised real Join/No match progression, a different selected
step, already-open No match, repeated opt-in, Got it/Escape, another lab and a
narrow Model-view fallback with reduced-motion preference and keyboard dismissal.
Reduced-motion CSS disables the optional outline pulse; no screen-coordinate
placement exists to drift on resize. No cross-platform/human UX study claimed.

Images: [targeted No match hint](../../../docs/stabilization/recon-no-match-hint.png),
[narrow fallback](../../../docs/stabilization/recon-hint-narrow.png).
The existing Lens first-use explanation remains independent. Completion means
the user reached No match, never that mappings or reconciliation are correct.
