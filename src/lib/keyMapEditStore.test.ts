/**
 * Transition matrix for KeyMapEditStore.
 * Run: npx tsx src/lib/keyMapEditStore.test.ts
 */
import { KeyMapEditStore, type PageSlot } from "./keyMapEditStore";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function loadA(store: KeyMapEditStore): PageSlot {
  store.setSchema({ arity: 1, editable: ["note"] });
  const page = store.adoptPage(
    [{ from: "A", from_parts: ["A"], to: "X", attrs: { note: "n1" } }],
    [],
  );
  assert(page.length === 1, "page has A");
  return page[0]!;
}

function summarize(store: KeyMapEditStore) {
  const d = store.toDelta();
  if (!d) return { upserts: [], deletes: [] as string[], baselines: [] as string[] };
  return {
    upserts: d.upserts.map((e) => `${e.from}→${e.to}`).sort(),
    deletes: (d.deletedFromParts ?? []).map((p) => p.join("|")).sort(),
    baselines: (d.baselines ?? []).map(
      (b) =>
        `${b.existed ? "WH" : "NEW"}:${b.fromParts.join("|")}:to=${b.to}:note=${String(b.attrs?.note)}`,
    ),
  };
}

// --- insert fill → clear From → delete ---
{
  const store = new KeyMapEditStore();
  store.setSchema({ arity: 1, editable: [] });
  const id = store.addRow({ fromParts: [""], to: "" });
  store.updateDraft(id, { fromParts: ["A"], to: "B" });
  assert(summarize(store).upserts[0] === "A→B", "insert upsert");
  store.updateDraft(id, { fromParts: [""], to: "B" }); // clear From
  assert(store.toDelta() === null, "invalid draft omitted from delta");
  store.deleteRow(id);
  assert(store.isEmpty(), "delete new row removes store entry");
}

// --- loaded: edit To → clear From → delete ⇒ DELETE A, no upsert ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { to: "Y" }, slot.loaded);
  store.updateDraft(slot.id, { fromParts: [""], to: "Y" }, slot.loaded);
  store.deleteRow(slot.id, slot.loaded);
  const s = summarize(store);
  assert(s.upserts.length === 0, "no upsert");
  assert(s.deletes[0] === "A", "deletes A");
  assert(
    s.baselines.some((b) => b.startsWith("WH:A:to=X:note=n1")),
    "baseline from original",
  );
}

// --- A→B→C rename chain ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { fromParts: ["B"], to: "X" }, slot.loaded);
  store.updateDraft(slot.id, { fromParts: ["C"], to: "X" }, slot.loaded);
  const s = summarize(store);
  assert(s.deletes.join() === "A", "one delete of origin A");
  assert(s.upserts.join() === "C→X", "final insert C");
}

// --- A→B→A revert key ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { fromParts: ["B"], to: "X" }, slot.loaded);
  store.updateDraft(slot.id, { fromParts: ["A"], to: "X" }, slot.loaded);
  assert(store.isEmpty() || summarize(store).upserts.length === 0, "back to A pristine");
  // to still X and attrs same → pruned
  assert(store.isEmpty(), "fully pristine after A→B→A");
}

// --- edit then revert to original ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { to: "Y" }, slot.loaded);
  assert(summarize(store).upserts[0] === "A→Y", "dirty Y");
  store.updateDraft(slot.id, { to: "X" }, slot.loaded);
  assert(store.isEmpty(), "reverted → no ops");
}

// --- rename via empty key then fill B ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { to: "Y" }, slot.loaded);
  store.updateDraft(slot.id, { fromParts: [""], to: "Y" }, slot.loaded);
  store.updateDraft(slot.id, { fromParts: ["B"], to: "Y" }, slot.loaded);
  const s = summarize(store);
  assert(s.deletes.join() === "A", "delete A");
  assert(s.upserts.join() === "B→Y", "insert B");
}

// --- page change keeps dirty for off-page row ---
{
  const store = new KeyMapEditStore();
  store.setSchema({ arity: 1, editable: [] });
  const page1 = store.adoptPage(
    [{ from: "A", from_parts: ["A"], to: "X" }],
    [],
  );
  store.updateDraft(page1[0]!.id, { to: "Y" }, page1[0]!.loaded);
  const page2 = store.adoptPage(
    [{ from: "Z", from_parts: ["Z"], to: "W" }],
    page1,
  );
  const view = store.viewEntries(page2, []);
  assert(view.length === 1 && view[0]!.from === "Z", "page2 shows Z");
  assert(summarize(store).upserts.join() === "A→Y", "A dirty survives page change");
}

// --- save capture keeps mid-save edits ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { to: "Y" }, slot.loaded);
  const cap = store.captureSave();
  assert(cap.delta?.upserts[0]?.to === "Y", "captured Y");
  store.updateDraft(slot.id, { to: "Z" }, slot.loaded); // during save
  store.confirmSave(cap.token);
  const s = summarize(store);
  assert(s.upserts.join() === "A→Z", "kept mid-save Z against new original Y");
  const b = store.get(slot.id);
  assert(b?.original?.to === "Y", "original rebased to saved Y");
}

// --- unsent empty draft survives confirm of a sibling insert ---
{
  const store = new KeyMapEditStore();
  store.setSchema({ arity: 1, editable: [] });
  const filled = store.addRow({ fromParts: ["A"], to: "B" });
  const empty = store.addRow({ fromParts: [""], to: "" });
  const cap = store.captureSave();
  assert(cap.sent.has(filled), "filled is sent");
  assert(!cap.sent.has(empty), "empty draft not sent");
  assert(cap.delta?.upserts.length === 1, "only filled in delta");
  store.confirmSave(cap.token);
  assert(!store.get(filled), "filled confirmed away");
  assert(!!store.get(empty), "empty draft still dirty");
  assert(store.toDelta() === null, "empty still not sendable");
}

// --- delete sent INSERT mid-save → pending DELETE of new WH row ---
{
  const store = new KeyMapEditStore();
  store.setSchema({ arity: 1, editable: [] });
  const id = store.addRow({ fromParts: ["N"], to: "Y" });
  const cap = store.captureSave();
  assert(cap.delta?.upserts[0]?.from === "N", "insert N sent");
  store.deleteRow(id); // removes from store (was insert)
  store.confirmSave(cap.token);
  const s = summarize(store);
  assert(s.deletes.join() === "N", "pending DELETE N after insert confirmed");
  assert(s.baselines.some((b) => b.startsWith("WH:N:")), "baseline existed for N");
}

// --- conflict path: no confirm → dirty intact ---
{
  const store = new KeyMapEditStore();
  const slot = loadA(store);
  store.updateDraft(slot.id, { to: "Y" }, slot.loaded);
  store.captureSave();
  // pretend conflict — skip confirm
  assert(summarize(store).upserts.join() === "A→Y", "still dirty");
}

// --- fuzzy batch 100K: timing ---
{
  const store = new KeyMapEditStore();
  store.setSchema({ arity: 1, editable: [] });
  const page = store.adoptPage(
    Array.from({ length: 200 }, (_, i) => ({
      from: `p${i}`,
      from_parts: [`p${i}`],
      to: "",
    })),
    [],
  );
  const proposals = Array.from({ length: 100_000 }, (_, i) => ({
    fromParts: [`k${i}`],
    to: `t${i}`,
  }));
  const t0 = performance.now();
  const { newIds } = store.applyProposals(proposals, page);
  const tApply = performance.now() - t0;
  const t1 = performance.now();
  const delta = store.toDelta();
  const tDelta = performance.now() - t1;
  assert(newIds.length === 100_000, "100K inserts");
  assert(delta?.upserts.length === 100_000, "delta 100K upserts");
  console.log(
    `fuzzy 100K: apply=${tApply.toFixed(1)}ms delta=${tDelta.toFixed(1)}ms dirty=${store.dirtyCount()}`,
  );
}

console.log("keyMapEditStore.test.ts: ok");
