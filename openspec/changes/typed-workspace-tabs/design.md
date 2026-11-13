# Design

Use a small navigation-only WorkspaceTab union and WorkbenchTabs value. Query is
the single existing Pipeline canvas, not one tab per query; activeQueryId retains
query selection. Mapping carries mapId, Matching carries sessionId; Help Lab and
quality are service descriptors. Kind-tagged tuple serialization supplies keys.

Pure openTab/activateTab/closeTab/resetProjectTabs return immutable navigation
values; close returns confirmation_required until explicit discard. Dirty signals
are supplied from existing owner state, not copied into navigation. App applies
transitions and only removes documents after accepted close. App owns confirmation
UI and existing Join/Lens return effects. Avoid side effects inside state updaters.
Reset runs only inside existing successful project application. Help Lab remains
available; existing lab destination policy can subsequently open quality.

No generalized registry/store/framework. Existing render order/styles and hidden
mounted Mapping/Matching panels remain. E2E-only hooks may expose narrow editor
opening/snapshots without adding runtime bypasses. Dirty Matching teardown must
explicitly discard injected state before closing Electron.

Review: proposal, delta requirements, design, then tasks checked against current
App and Accepted ADR-0031/32/44/45/46/47; no new product decision introduced.
