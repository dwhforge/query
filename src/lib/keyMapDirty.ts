/**
 * KeyMap editor dirty layer — RowId store (see keyMapEditStore.ts).
 * Re-exports keep existing import paths stable.
 */
export {
  KeyMapEditStore,
  KeyMapEditStore as KeyMapDirtyBuffer,
  KEYMAP_PAGE_SIZE,
  snapshotFromEntry,
  entryFromSnapshot,
  type RowId,
  type RowSnapshot,
  type RowEdit,
  type PageSlot,
  type EditorKeyMapEntry,
  type SaveCapture,
  type AttrMap,
} from "./keyMapEditStore";
