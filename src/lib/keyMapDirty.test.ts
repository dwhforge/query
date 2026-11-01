/**
 * Run: npx tsx src/lib/keyMapDirty.test.ts
 */
import { KeyMapDirtyBuffer, withLocalId } from "./keyMapDirty";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

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
  const filled = dirty.toDelta();
  assert(filled?.upserts.length === 1, "upsert registered after fill");
  assert(filled!.upserts[0]!.from === "A", "from=A");
  assert(filled!.baselines?.[0]?.existed === false, "insert baseline");

  // Clear From leaves invalid current parts; delete must still retract via localId.
  dirty.noteDelete(
    [""],
    { ...row, from: "", from_parts: [""], to: "B" },
    row.__dwhLocalId,
  );
  assert(dirty.toDelta() === null, "delete after cleared From empties delta");
  assert(dirty.isEmpty(), "buffer empty");
}

console.log("keyMapDirty.test.ts: ok");
