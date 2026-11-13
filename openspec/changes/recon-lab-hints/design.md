# Design: Inline semantic hints

Extend only the existing session with opt-in and completed flags. A pure function
derives the current goal from the real selected query/step. Join Lens exposes an
optional read-only mode callback and a decorative No match accessory slot; it
does not import Help Lab logic. Its actual probe mode is the completion signal.
History exposes a small optional indexed accessory for the actual step row.

One inline coachmark with text, arrow, and Got it is rendered adjacent to the
active target. Inline flow naturally follows resize and cannot drift away from
its control. Known hidden layouts use task-area fallback. No position tracking,
portal, observer service, timer, navigation automation or focus manipulation.

Unit tests cover opt-in, first-goal satisfaction and completion/dismissal.
Electron covers actual No match progression, alternative route, dismissal,
switch cleanup and narrow layouts. Capture actual working UI.
