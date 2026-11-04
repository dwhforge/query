import {
  applyKeyMapOntoProject,
  applyKeyMapTabMapChange,
  dirtyDeltaHasChanges,
  keyMapEntriesFingerprint,
  mapEditorFillSnapshot,
  mapForProjectAst,
  mergeFromValuesIntoMap,
  mergeKeyMapTabSession,
  normalizeKeyMapForEditor,
  planMapFillFromLens,
  resolveJoinStepFromCtx,
  seedSaveResult,
  settleSeedDraftAfterSave,
  upsertKeyMapIntoProject,
} from "./service";
import type { KeyMapJoinCtx, KeyMapTabSession } from "./types";
import type { Project } from "../../types/pipeline";
import { findApplyKeyMapIdForJoin } from "../../lib/keyMap";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const joinCtx: KeyMapJoinCtx = {
  hostQueryId: "q_host",
  joinStepIndex: 0,
  rightQueryId: "q_right",
  leftOn: ["sku"],
  rightOn: ["id"],
  joinType: "left",
};

const map = {
  id: "map_1",
  name: "M",
  entries: [{ from: "a", to: "1" }],
  storage: { kind: "seed" as const },
};

const project = {
  id: "p",
  name: "t",
  connections: [],
  sources: [],
  workspace: {
    queries: [
      {
        id: "q_host",
        name: "host",
        steps: [
          {
            type: "Join",
            payload: {
              right_query_id: "q_right",
              join_type: "left",
              left_on: ["sku"],
              right_on: ["id"],
            },
          },
        ],
      },
      { id: "q_right", name: "right", steps: [] },
    ],
    focus_query_id: "q_host",
    key_maps: [map],
  },
  dbt_target: "v1",
} as Project;

assert(resolveJoinStepFromCtx(project.workspace, joinCtx) === 0, "join idx");

const applied = applyKeyMapOntoProject(project, {
  map: map as never,
  ctx: joinCtx,
  side: "left",
  leftCols: ["sku"],
  rightCols: ["id"],
  outputColumnLeft: "sku_mapped",
  outputColumnRight: "id",
});
assert(applied.result.status === "ok", "apply ok");

const sourceMap = {
  ...map,
  storage: { kind: "source" as const, connection_id: "c", schema: "s", table: "t" },
  entries: [{ from: "x", to: "y" }],
};
assert(mapForProjectAst(sourceMap as never).entries.length === 0, "strip source");

const norm = normalizeKeyMapForEditor({
  id: "m",
  name: "n",
  entries: [],
} as never);
assert(norm.from_column === "from" && norm.to_column === "to", "defaults");

const merged = mergeFromValuesIntoMap({
  map: map as never,
  fromValues: ["b"],
  toValues: ["2"],
  joinCtx,
});
assert(merged.entries.some((e) => e.from === "b" && e.to === "2"), "merge from");

const renamed = { ...map, name: "Renamed" };
const up = upsertKeyMapIntoProject(project, renamed as never);
assert(
  up.workspace.key_maps?.find((m) => m.id === "map_1")?.name === "Renamed",
  "upsert",
);

assert(!dirtyDeltaHasChanges(null), "empty delta");
assert(
  dirtyDeltaHasChanges({ upserts: [{ from: "a", to: "1" }], deletedFroms: [] }),
  "has upsert",
);

assert(seedSaveResult({ exportPath: null }).external === "skipped", "no export");
assert(seedSaveResult({ exportPath: "/x" }).external === "synced", "synced");

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      from_columns: ["sys", "code"],
      entries: [
        { from: "ERP", from_parts: ["ERP", "100"], to: "A" },
        { from: "ERP", from_parts: ["ERP", "200"], to: "B" },
      ],
    },
    contentHash: "hash-1",
    dirtyDelta: { upserts: [], deletedFroms: [] },
    saveInFlight: true,
    dirtyResetSeq: 3,
    totalCount: 9,
    saveApi: {
      captureSave: () => null,
      confirmSave: () => {},
      abortSave: () => {},
      isSaving: () => false,
    },
  };
  const incoming = {
    id: "m",
    name: "M",
    from_columns: ["sys", "code"],
    entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "A2" }],
  };
  const merged = mergeKeyMapTabSession(prev, incoming as never);
  assert(merged.map.entries.length === 2, "composite rows not collapsed");
  assert(
    merged.map.entries.some(
      (e) => e.from_parts?.[1] === "100" && e.to === "A2",
    ),
    "updated tuple",
  );
  assert(
    merged.map.entries.some((e) => e.from_parts?.[1] === "200" && e.to === "B"),
    "sibling tuple kept",
  );
  assert(merged.contentHash === "hash-1", "lifecycle contentHash");
  assert(merged.saveInFlight === true, "lifecycle saveInFlight");
  assert(merged.dirtyResetSeq === 3, "lifecycle dirtyResetSeq");
  assert(merged.totalCount === 9, "lifecycle totalCount");
  assert(merged.saveApi != null, "lifecycle saveApi");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "A", to: "1", attrs: { reason: "old" } }],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "A", to: "1", attrs: { reason: "new" } }],
  } as never);
  assert(
    merged.map.entries[0]?.attrs?.reason === "new",
    "attrs-only update when not dirty",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "A", to: "1", attrs: { reason: "local" } }],
    },
    dirtyDelta: {
      upserts: [{ from: "A", to: "1", attrs: { reason: "local" } }],
      deletedFroms: [],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "A", to: "1", attrs: { reason: "remote" } }],
  } as never);
  assert(
    merged.map.entries[0]?.attrs?.reason === "local",
    "dirty draft attrs win",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      time_mode: "range_scd",
      entries: [
        {
          from: "A",
          to: "1",
          attrs: { valid_from: "2026-01-01", valid_to: "" },
        },
      ],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    time_mode: "range_scd",
    entries: [
      {
        from: "A",
        to: "1",
        attrs: { valid_from: "2026-01-01", valid_to: "2026-06-01" },
      },
    ],
  } as never);
  assert(merged.map.entries.length === 1, "SCD bound update is one row");
  assert(
    merged.map.entries[0]?.attrs?.valid_to === "2026-06-01",
    "SCD valid_to updated",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: {
        kind: "source",
        source: "public",
        table: "a",
        connection_id: "c1",
      },
      entries: [
        { from: "A_ONLY", to: "1" },
        { from: "SHARED", to: "old" },
      ],
    },
    contentHash: "hash-A",
    dirtyDelta: { upserts: [{ from: "A_ONLY", to: "1" }], deletedFroms: [] },
    saveApi: {
      captureSave: () => null,
      confirmSave: () => {},
      abortSave: () => {},
      isSaving: () => false,
    },
  };
  const rebound = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: {
      kind: "source",
      source: "public",
      table: "b",
      connection_id: "c1",
    },
    entries: [
      { from: "B_ONLY", to: "9" },
      { from: "SHARED", to: "new" },
    ],
  } as never);
  assert(rebound.contentHash === undefined, "rebind clears hash");
  assert(rebound.dirtyDelta === null, "rebind clears dirty");
  assert(rebound.saveApi === undefined, "rebind invalidates saveApi");
  assert(
    !rebound.map.entries.some((e) => e.from === "A_ONLY"),
    "source A rows must not follow binding B",
  );
  assert(
    rebound.map.entries.some((e) => e.from === "B_ONLY" && e.to === "9"),
    "source B rows present",
  );
  assert(rebound.map.entries.length === 2, "only B relation rows");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "1" }],
    },
    saveInFlight: true,
  };
  const refused = applyKeyMapTabMapChange(prev, {
    id: "m",
    name: "M",
    storage: {
      kind: "source",
      source: "public",
      table: "t",
      connection_id: "c1",
    },
    entries: [],
  } as never);
  assert(!refused.ok, "refuse rebind while save in flight");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      entries: [{ from: "gone", to: "1" }],
    },
    dirtyDelta: {
      upserts: [],
      deletedFroms: ["gone"],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    entries: [{ from: "gone", to: "1" }],
  } as never);
  assert(
    !merged.map.entries.some((e) => e.from === "gone"),
    "deletedFroms not resurrected",
  );
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      from_columns: ["sys", "code"],
      entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "1" }],
    },
    dirtyDelta: {
      upserts: [],
      deletedFroms: [],
      deletedFromParts: [["ERP", "100"]],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    from_columns: ["sys", "code"],
    entries: [{ from: "ERP", from_parts: ["ERP", "100"], to: "1" }],
  } as never);
  assert(merged.map.entries.length === 0, "deletedFromParts not resurrected");
}

{
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "local", attrs: { reason: "draft" } }],
    },
    dirtyDelta: {
      upserts: [{ from: "A", to: "local", attrs: { reason: "draft" } }],
      deletedFroms: [],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: { kind: "seed" },
    entries: [{ from: "A", to: "remote", attrs: { reason: "file" } }],
  } as never);
  assert(
    merged.map.entries[0]?.to === "local" &&
      merged.map.entries[0]?.attrs?.reason === "draft",
    "seed dirty draft survives refresh",
  );
}

{
  // Seed/ref may have no warehouse dirtyDelta — localDraft still protects.
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "local" }],
    },
    localDraft: true,
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: { kind: "seed" },
    entries: [{ from: "A", to: "from-file" }],
  } as never);
  assert(merged.map.entries[0]?.to === "local", "seed localDraft without delta");
}

{
  // Clean seed tab (no localDraft): SoT/suggest refresh may update To.
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "ref", model: "map_x" },
      entries: [{ from: "A", to: "1" }],
    },
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: { kind: "ref", model: "map_x" },
    entries: [{ from: "A", to: "2" }],
  } as never);
  assert(merged.map.entries[0]?.to === "2", "clean ref accepts refresh To");
}

{
  // Local delete without dirtyDelta: refresh must not resurrect B.
  const prev: KeyMapTabSession = {
    map: {
      id: "m",
      name: "M",
      storage: { kind: "seed" },
      entries: [{ from: "A", to: "1" }],
    },
    localDraft: true,
    dirtyDelta: null,
  };
  const merged = mergeKeyMapTabSession(prev, {
    id: "m",
    name: "M",
    storage: { kind: "seed" },
    entries: [
      { from: "A", to: "1" },
      { from: "B", to: "2" },
    ],
  } as never);
  assert(
    !merged.map.entries.some((e) => e.from === "B"),
    "seed local delete not resurrected",
  );
  assert(merged.map.entries.length === 1, "only A remains");
}

{
  // Save R1 while user edits to R2 — draft must stay dirty.
  const r1 = {
    id: "m",
    name: "M",
    storage: { kind: "seed" as const },
    entries: [{ from: "A", to: "1" }],
  };
  const savedFp = keyMapEntriesFingerprint(r1 as never);
  const duringSave: KeyMapTabSession = {
    map: {
      ...r1,
      entries: [{ from: "A", to: "2" }],
    },
    localDraft: true,
  };
  const settled = settleSeedDraftAfterSave(duringSave, savedFp);
  assert(settled.localDraft === true, "R2 stays dirty after R1 save");
  assert(settled.map.entries[0]?.to === "2", "R2 entries kept");

  const sameAsR1: KeyMapTabSession = {
    map: r1 as never,
    localDraft: true,
    dirtyDelta: { upserts: [{ from: "A", to: "1" }], deletedFroms: [] },
  };
  const cleared = settleSeedDraftAfterSave(sameAsR1, savedFp);
  assert(cleared.localDraft === false, "R1 save clears draft");
  assert(cleared.dirtyDelta === null, "R1 save clears delta");
}

// --- Join Lens → KeyMap UI fill (left/right unmatched, pair, composite) ---
{
  const lensBase = {
    lensLeftOn: ["sku"],
    lensRightOn: ["id"],
    hostQueryId: "q_host",
    joinStepIndex: 0,
    rightQueryId: "q_right",
    joinType: "left" as const,
  };

  // Left unmatched only: From filled, To empty, Apply prefers left.
  {
    const planned = planMapFillFromLens({
      ...lensBase,
      probeSide: "left",
      fromValues: ["DIRTY_A", "DIRTY_B"],
    });
    assert(planned.primaryApplySide === "left", "left unmatched → Apply left");
    assert(planned.joinCtx.probeSide === "left", "probe left");
    assert(
      planned.joinCtx.applyLeftOn?.[0] === "sku" &&
        planned.joinCtx.applyRightOn?.[0] === "id",
      "left unmatched maps ON cols",
    );
    const snap = mapEditorFillSnapshot({
      map: { ...map, entries: [] } as never,
      joinCtx: planned.joinCtx,
      fromValues: planned.fromValues,
    });
    assert(snap.entries.length === 2, "left unmatched adds From rows");
    assert(
      snap.entries.every((e) => e.to === "") && snap.emptyToCount === 2,
      "left unmatched leaves To empty",
    );
    assert(
      snap.suggestedFrom.join(",") === "DIRTY_A,DIRTY_B",
      "left unmatched suggestedFrom",
    );
  }

  // Right unmatched only: From = right keys, probe/Apply right (not To column).
  {
    const planned = planMapFillFromLens({
      ...lensBase,
      probeSide: "right",
      fromValues: ["CANON_X"],
    });
    assert(planned.primaryApplySide === "right", "right unmatched → Apply right");
    assert(planned.joinCtx.probeSide === "right", "probe right");
    const snap = mapEditorFillSnapshot({
      map: { ...map, entries: [] } as never,
      joinCtx: planned.joinCtx,
      fromValues: planned.fromValues,
    });
    assert(
      snap.entries.length === 1 &&
        snap.entries[0]!.from === "CANON_X" &&
        snap.entries[0]!.to === "",
      "right unmatched fills From (Apply on right), not To",
    );
    assert(snap.probeSide === "right", "editor sees right probe");
  }

  // Pair L+R: From=left, To=right, probe left (dirty → canon).
  {
    const planned = planMapFillFromLens({
      ...lensBase,
      probeSide: "left",
      fromValues: ["DIRTY_A"],
      toValues: ["CANON_1"],
    });
    assert(planned.primaryApplySide === "left", "pair Apply left");
    const snap = mapEditorFillSnapshot({
      map: { ...map, entries: [] } as never,
      joinCtx: planned.joinCtx,
      fromValues: planned.fromValues,
      toValues: planned.toValues,
    });
    assert(
      snap.entries.some((e) => e.from === "DIRTY_A" && e.to === "CANON_1"),
      "pair fills From→To",
    );
    assert(snap.filledToCount === 1 && snap.emptyToCount === 0, "pair To filled");
  }

  // Composite From parts: arity + from_columns from leftOn; empty slot rejected.
  {
    const planned = planMapFillFromLens({
      ...lensBase,
      lensLeftOn: ["sys", "code"],
      lensRightOn: ["src", "sku"],
      probeSide: "left",
      fromValues: ["ERP|100"],
      toValues: ["A"],
      fromParts: [["ERP", "100"]],
    });
    assert(
      planned.joinCtx.applyLeftOn?.join(",") === "sys,code",
      "composite applyLeftOn",
    );
    assert(
      planned.joinCtx.applyRightOn?.join(",") === "src,sku",
      "composite applyRightOn aligned",
    );
    const snap = mapEditorFillSnapshot({
      map: { id: "m", name: "M", entries: [] } as never,
      joinCtx: planned.joinCtx,
      fromValues: planned.fromValues,
      toValues: planned.toValues,
      fromParts: planned.fromParts,
    });
    assert(
      snap.fromColumns.join(",") === "sys,code",
      "composite editor from_columns",
    );
    assert(
      snap.entries[0]?.from_parts?.join("|") === "ERP|100" &&
        snap.entries[0]?.to === "A",
      "composite entry parts + To",
    );
    // Incomplete composite (empty part) must not create a row.
    const incomplete = mergeFromValuesIntoMap({
      map: { id: "m", name: "M", entries: [] } as never,
      joinCtx: planned.joinCtx,
      fromValues: ["ERP|"],
      fromParts: [["ERP", ""]],
    });
    assert(incomplete.entries.length === 0, "reject incomplete composite From");
  }

  // Existing empty-To row gets To filled; attrs/from preserved on duplicate From.
  {
    const withAttrs = {
      ...map,
      entries: [
        {
          from: "DIRTY_A",
          to: "",
          attrs: { note: "keep-me" },
        },
      ],
    };
    const planned = planMapFillFromLens({
      ...lensBase,
      probeSide: "left",
      fromValues: ["DIRTY_A"],
      toValues: ["CANON_1"],
    });
    const merged = mergeFromValuesIntoMap({
      map: withAttrs as never,
      joinCtx: planned.joinCtx,
      fromValues: planned.fromValues,
      toValues: planned.toValues,
    });
    assert(merged.entries.length === 1, "no duplicate From");
    assert(
      merged.entries[0]!.to === "CANON_1" &&
        merged.entries[0]!.attrs?.note === "keep-me",
      "fill To preserves attrs",
    );
  }

  // Preferred ApplyKeyMap for left unmatched (not an unrelated map).
  {
    const ws = {
      queries: [
        {
          id: "q_host",
          name: "host",
          steps: [
            {
              type: "ApplyKeyMap" as const,
              payload: {
                map_id: "map_sku",
                column: "sku",
                entries: [],
              },
            },
            {
              type: "ApplyKeyMap" as const,
              payload: {
                map_id: "map_channel",
                column: "channel",
                entries: [],
              },
            },
            {
              type: "Join" as const,
              payload: {
                right_query_id: "q_right",
                join_type: "left" as const,
                left_on: ["sku"],
                right_on: ["id"],
              },
            },
          ],
        },
        { id: "q_right", name: "right", steps: [] },
      ],
      focus_query_id: "q_host",
      key_maps: [],
    };
    const planned = planMapFillFromLens({
      ...lensBase,
      joinStepIndex: 2,
      probeSide: "left",
      fromValues: ["x"],
    });
    const preferred = findApplyKeyMapIdForJoin(ws as never, planned.joinCtx);
    assert(preferred === "map_sku", "left unmatched prefers key-linked Apply");
    const rightPlanned = planMapFillFromLens({
      ...lensBase,
      joinStepIndex: 2,
      probeSide: "right",
      fromValues: ["y"],
    });
    // No Apply on right query → may fall back to host left Apply.
    const rightPref = findApplyKeyMapIdForJoin(
      ws as never,
      rightPlanned.joinCtx,
    );
    assert(
      rightPref === "map_sku",
      "right probe falls back to host left Apply when right has none",
    );
  }

  // outputColumn override keeps left/right output alignment.
  {
    const planned = planMapFillFromLens({
      ...lensBase,
      lensLeftOn: ["sku", "plant"],
      lensRightOn: ["item", "site"],
      probeSide: "left",
      fromValues: ["a"],
      applyColumns: ["sku", "plant"],
      outputColumn: "plant",
    });
    assert(
      planned.joinCtx.outputColumnLeft === "plant" &&
        planned.joinCtx.outputColumnRight === "site",
      "outputColumn aligns right partner",
    );
  }
}

console.log("keyMap/service.test.ts: ok");
