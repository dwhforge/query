import type { KeyMapDirtyDelta } from "../../lib/bridge";
import type { ApplySide } from "../../lib/keyMap";
import type { JoinType, KeyMapDef, Workspace } from "../../types/pipeline";

export type KeyMapJoinCtx = {
  hostQueryId: string;
  joinStepIndex: number;
  rightQueryId: string;
  leftOn: string[];
  rightOn: string[];
  /** Join type at open time — LEFT→INNER during Save must abort Apply. */
  joinType: JoinType;
  /** Side whose unmatched key opened Add to map… */
  probeSide?: "left" | "right";
  /** Fact columns for ApplyKeyMap (selected Join keys, ADR-0024). */
  applyLeftOn?: string[];
  applyRightOn?: string[];
  /** Output column on the left (host) ApplyKeyMap. */
  outputColumnLeft?: string;
  /** Output column on the right ApplyKeyMap (may differ, e.g. sku vs item_code). */
  outputColumnRight?: string;
};

export type KeyMapTabSession = {
  map: KeyMapDef;
  /** Optimistic concurrency token from last warehouse read (source storage). */
  contentHash?: string;
  /** ADR-0022 dirty delta for source Save. */
  dirtyDelta?: KeyMapDirtyDelta | null;
  /**
   * Unsaved editor edits (seed/ref included). Set when the editor changes rows
   * or reports a non-empty dirtyDelta; cleared on rebind / successful settle.
   * Merge must not overwrite divergent rows while this is true — even if
   * `dirtyDelta` is null (seed/ref have no warehouse dirty wire).
   */
  localDraft?: boolean;
  /** Editor store Save API — one in-flight capture; confirm/abort take its token. */
  saveApi?: {
    captureSave: () => {
      token: number;
      delta: KeyMapDirtyDelta | null;
    } | null;
    confirmSave: (token: number) => void;
    abortSave: (token: number) => void;
    isSaving: () => boolean;
  };
  /** True while a warehouse write for this tab is awaiting a response. */
  saveInFlight?: boolean;
  /** Bumped after successful WH Save when editor saveApi is absent. */
  dirtyResetSeq?: number;
  totalCount?: number | null;
  pickTo?: string[];
  suggestedFrom?: string[];
  suggestedFromParts?: string[][];
  joinCtx?: KeyMapJoinCtx;
};

/** Intent to insert ApplyKeyMap after a successful KeyMap Save. */
export type KeyMapApplyIntent = {
  map: KeyMapDef;
  ctx: KeyMapJoinCtx;
  side: ApplySide;
  leftCols: string[];
  rightCols: string[];
  outputColumnLeft: string;
  outputColumnRight: string;
};

export type KeyMapApplyResult =
  | { status: "ok"; mapId: string; workspace: Workspace }
  | { status: "join_gone"; mapId: string };
