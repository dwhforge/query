/**
 * Run: npx tsx src/lib/keyMapDirty.test.ts
 */
import {
  KeyMapDirtyBuffer,
  adoptWarehousePage,
  withLocalId,
} from "./keyMapDirty";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// Insert: fill → clear From → delete must empty the delta.
{
  const dirty = new KeyMapDirtyBuffer();
  const row = withLocalId({ from: "", from_parts: [""], to: "" });
  dirty.markInsert(row.__dwhLocalId!);
  dirty.noteUpsert(row, null, row.__dwhLocalId);
  dirty.noteUpsert(
    { ...row, from: "A", from_parts: ["A"], to: "B" },
    null,
    row.__dwhLocalId,
  );
  assert(dirty.toDelta()?.upserts.length === 1, "upsert registered after fill");
  dirty.noteDelete(
    [""],
    { ...row, from: "", from_parts: [""], to: "B" },
    row.__dwhLocalId,
  );
  assert(dirty.toDelta() === null, "insert delete after cleared From");
}

// Loaded WH row: edit To → clear From → delete must emit delete, not upsert.
{
  const dirty = new KeyMapDirtyBuffer();
  const page = adoptWarehousePage(
    [{ from: "A", from_parts: ["A"], to: "X" }],
    [],
    dirty,
  );
  const row = page[0]!;
  assert(!!row.__dwhLocalId, "loaded row has local id");
  dirty.noteUpsert(
    { ...row, to: "Y" },
    { from: "A", from_parts: ["A"], to: "X" },
    row.__dwhLocalId,
  );
  assert(dirty.toDelta()?.upserts[0]?.to === "Y", "edited to Y");
  // Clear From in the editor (invalid) then delete — parts empty.
  dirty.noteDelete(
    [""],
    { ...row, from: "", from_parts: [""], to: "Y" },
    row.__dwhLocalId,
  );
  const delta = dirty.toDelta();
  assert(delta, "delta present");
  assert(delta!.upserts.length === 0, "no upsert after delete");
  assert(
    delta!.deletedFromParts?.length === 1 &&
      delta!.deletedFromParts[0]![0] === "A",
    "deletes warehouse key A",
  );
  assert(delta!.baselines?.[0]?.existed === true, "baseline existed");
  assert(delta!.baselines?.[0]?.to === "X", "baseline to=X from origin");
}

// Loaded WH row: edit → clear From → rename to B must delete A + upsert B.
{
  const dirty = new KeyMapDirtyBuffer();
  const page = adoptWarehousePage(
    [{ from: "A", from_parts: ["A"], to: "X" }],
    [],
    dirty,
  );
  const row = page[0]!;
  dirty.noteUpsert(
    { ...row, to: "Y" },
    { from: "A", from_parts: ["A"], to: "X" },
    row.__dwhLocalId,
  );
  // Through empty From: noteRename with empty old parts + new B.
  dirty.noteRename(
    [""],
    { ...row, from: "B", from_parts: ["B"], to: "Y" },
    { ...row, from: "", from_parts: [""], to: "Y" },
    row.__dwhLocalId,
  );
  const delta = dirty.toDelta()!;
  assert(
    delta.deletedFromParts?.some((p) => p[0] === "A"),
    "rename-via-empty deletes A",
  );
  assert(
    delta.upserts.some((e) => e.from === "B" && e.to === "Y"),
    "rename-via-empty upserts B",
  );
  const bBase = delta.baselines?.find((b) => b.fromParts[0] === "B");
  assert(bBase?.existed === false, "B is insert baseline");
}

console.log("keyMapDirty.test.ts: ok");
