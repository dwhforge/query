/** Navigation only. Documents, dirty flags and sessions stay with their owners. */
export type WorkspaceTab =
  | { kind: "query" }
  | { kind: "help_lab" }
  | { kind: "mapping"; mapId: string }
  | { kind: "matching"; sessionId: string }
  | { kind: "quality" };

export const QUERY_TAB = { kind: "query" } as const;
export const HELP_TAB = { kind: "help_lab" } as const;
export const QUALITY_WORKSPACE_TAB = { kind: "quality" } as const;
export const mappingTab = (mapId: string): WorkspaceTab => ({ kind: "mapping", mapId });
export const matchingTab = (sessionId: string): WorkspaceTab => ({ kind: "matching", sessionId });

/** Tuple encoding prevents both cross-kind and delimiter/escaping collisions. */
export function tabKey(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case "mapping": return JSON.stringify([tab.kind, tab.mapId]);
    case "matching": return JSON.stringify([tab.kind, tab.sessionId]);
    default: return JSON.stringify([tab.kind]);
  }
}

export const sameTab = (a: WorkspaceTab, b: WorkspaceTab): boolean => tabKey(a) === tabKey(b);

export type WorkbenchTabs = { tabs: readonly WorkspaceTab[]; active: WorkspaceTab };

export function initialTabs(): WorkbenchTabs {
  return { tabs: [QUERY_TAB, HELP_TAB], active: QUERY_TAB };
}

export function openTab(state: WorkbenchTabs, tab: WorkspaceTab): WorkbenchTabs {
  if (state.tabs.some((t) => sameTab(t, tab))) return activateTab(state, tab);
  return { tabs: [...state.tabs, tab], active: tab };
}

export function activateTab(state: WorkbenchTabs, tab: WorkspaceTab): WorkbenchTabs {
  if (sameTab(state.active, tab) || !state.tabs.some((t) => sameTab(t, tab))) return state;
  return { ...state, active: tab };
}

export type CloseTabResult = {
  status: "closed" | "confirmation_required" | "unchanged";
  state: WorkbenchTabs;
};

export function closeTab(
  state: WorkbenchTabs,
  tab: WorkspaceTab,
  options: { dirty?: boolean; discard?: boolean } = {},
): CloseTabResult {
  if (tab.kind === "query" || tab.kind === "help_lab" ||
    !state.tabs.some((t) => sameTab(t, tab))) return { status: "unchanged", state };
  if (options.dirty && !options.discard) return { status: "confirmation_required", state };
  const tabs = state.tabs.filter((t) => !sameTab(t, tab));
  let active = state.active;
  if (sameTab(active, tab)) {
    const maps = state.tabs.filter((t) => t.kind === "mapping");
    const index = maps.findIndex((t) => sameTab(t, tab));
    active = tab.kind === "mapping" ? maps[index + 1] ?? maps[index - 1] ?? QUERY_TAB : QUERY_TAB;
  }
  return { status: "closed", state: { tabs, active } };
}

/** Called only after the existing replacement path has committed successfully. */
export function resetProjectTabs(state: WorkbenchTabs, replaced: boolean): WorkbenchTabs {
  return replaced ? initialTabs() : state;
}
