import {
  QUERY_TAB, HELP_TAB, QUALITY_WORKSPACE_TAB, mappingTab, matchingTab,
  tabKey, sameTab, initialTabs, openTab, activateTab, closeTab, resetProjectTabs,
} from "./tabs";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const trickyIds = ["", "canvas", "help_lab", "quality", "matching:x", "x", 'x\"],\"y', "a:b", "a/b", "α"];
const identities = [QUERY_TAB, HELP_TAB, QUALITY_WORKSPACE_TAB,
  ...trickyIds.flatMap((id) => [mappingTab(id), matchingTab(id)])];
assert(new Set(identities.map(tabKey)).size === identities.length, "all kind/identity keys must be distinct");

const initial = initialTabs();
const one = openTab(initial, mappingTab("canvas"));
assert(sameTab(one.active, mappingTab("canvas")), "open activates reserved-looking map");
const duplicate = openTab(one, mappingTab("canvas"));
assert(duplicate === one, "reopening active identity is idempotent");
const help = activateTab(one, HELP_TAB);
assert(help.tabs === one.tabs && sameTab(help.active, HELP_TAB), "activation preserves membership");
const reopened = openTab(help, mappingTab("canvas"));
assert(reopened.tabs.length === one.tabs.length, "reopen inactive identity does not duplicate");
assert(activateTab(help, matchingTab("unknown")) === help, "unknown activation is a no-op");

const two = openTab(one, mappingTab("second"));
const all = openTab(two, matchingTab("x"));
for (const tab of [mappingTab("canvas"), matchingTab("x")]) {
  const result = closeTab(all, tab, { dirty: true });
  assert(result.status === "confirmation_required" && result.state === all, "dirty close must not mutate");
  assert(closeTab(all, tab, { dirty: true, discard: false }).state === all, "cancel retains exact state");
  const discarded = closeTab(all, tab, { dirty: true, discard: true });
  assert(discarded.status === "closed" && discarded.state.tabs.length === all.tabs.length - 1,
    "explicit discard closes exactly one identity");
}
const inactiveClose = closeTab(all, mappingTab("canvas")).state;
assert(inactiveClose.active === all.active, "inactive close retains active tab");
const matchingClose = closeTab(all, matchingTab("x")).state;
assert(sameTab(matchingClose.active, QUERY_TAB), "active Matching returns to canvas");
const firstClose = closeTab(activateTab(all, mappingTab("canvas")), mappingTab("canvas")).state;
assert(sameTab(firstClose.active, mappingTab("second")), "active Mapping prefers next Mapping");
const lastClose = closeTab(two, mappingTab("second")).state;
assert(sameTab(lastClose.active, mappingTab("canvas")), "last Mapping prefers previous Mapping");
const onlyClose = closeTab(one, mappingTab("canvas")).state;
assert(sameTab(onlyClose.active, QUERY_TAB), "only Mapping returns to canvas");
assert(closeTab(all, QUERY_TAB).state === all && closeTab(all, HELP_TAB).state === all,
  "persistent services cannot close");
assert(closeTab(all, mappingTab("missing")).state === all, "unknown close is a no-op");

const withQuality = openTab(all, QUALITY_WORKSPACE_TAB);
assert(resetProjectTabs(withQuality, false) === withQuality, "replacement cancel/failure changes nothing");
const reset = resetProjectTabs(withQuality, true);
assert(reset.tabs.length === 2 && reset.tabs.some((t) => sameTab(t, HELP_TAB)) &&
  sameTab(reset.active, QUERY_TAB), "successful replacement retains Help Lab and canvas only");
assert(withQuality.tabs.length === 6, "transitions do not mutate the input");
console.log("workbench tabs tests passed");
