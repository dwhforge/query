import type { JoinDiagSample, JoinDiagnostics } from "../lib/bridge";

export type JoinDiagKind =
  | "left"
  | "right"
  | "output"
  | "unmatched_left"
  | "unmatched_right"
  | "fanout"
  | "right_dups";

type Props = {
  loading: boolean;
  error: string | null;
  diag: JoinDiagnostics | null;
  onOpen: (kind: JoinDiagKind, sample: JoinDiagSample | null, label: string) => void;
  /** Explicit full-input run — not fired automatically on Join select. */
  onRun?: () => void;
  onPrepare?: () => void;
  prepareLoading?: boolean;
  prepareLabel?: string | null;
  onCancel?: () => void;
};

function Row({
  label,
  count,
  hint,
  onClick,
  muted,
}: {
  label: string;
  count: number;
  hint?: string;
  onClick?: () => void;
  muted?: boolean;
}) {
  const clickable = Boolean(onClick);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={`flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] ${
        clickable
          ? "hover:bg-teal-500/10 hover:text-teal-100"
          : "cursor-default"
      } ${muted ? "text-slate-500" : "text-slate-300"}`}
    >
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[10px] text-slate-600">{hint}</span>
        )}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-slate-200">
        {count.toLocaleString()}
      </span>
    </button>
  );
}

export function JoinDiagnosticsPanel({
  loading,
  error,
  diag,
  onOpen,
  onRun,
  onPrepare,
  prepareLoading = false,
  prepareLabel = null,
  onCancel,
}: Props) {
  const busy = loading || prepareLoading;
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Join diagnostics
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {busy && (
            <span className="text-[10px] text-slate-600">
              {prepareLoading ? "preparing…" : "computing…"}
            </span>
          )}
          {busy && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-amber-800/70 px-1.5 py-0.5 text-[9px] text-amber-200/90 hover:bg-amber-500/10"
            >
              Cancel
            </button>
          )}
          {onPrepare && (
            <button
              type="button"
              disabled={busy}
              onClick={onPrepare}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-teal-800 hover:text-teal-200 disabled:opacity-40"
            >
              {prepareLabel?.startsWith("Ready") ||
              prepareLabel?.startsWith("Loaded")
                ? "Reload sides"
                : "Load sides"}
            </button>
          )}
          {onRun && (
            <button
              type="button"
              disabled={busy}
              onClick={onRun}
              className="rounded border border-teal-800/70 px-1.5 py-0.5 text-[9px] text-teal-200/90 hover:bg-teal-500/10 disabled:opacity-40"
            >
              {diag ? "Refresh gaps" : "Find gaps"}
            </button>
          )}
        </div>
      </div>
      {prepareLabel && (
        <p className="text-[10px] text-slate-500">{prepareLabel}</p>
      )}
      <p className="text-[10px] leading-relaxed text-slate-600">
        Full-input counts (explicit run). Click a row to open a sample (≤
        {diag?.sample_limit ?? 50}) in Data. A clean sample is not proof for the
        full input.
      </p>
      {!loading && !error && !diag && (
        <p className="text-[10px] text-slate-600">
          Set join keys and Apply, then run diagnostics for full-input counts.
        </p>
      )}
      {error && (
        <p className="text-[11px] text-amber-500/90">{error}</p>
      )}
      {diag && !loading && (
        <div className="divide-y divide-slate-800/80">
          <Row
            label="Left input rows"
            count={diag.left_count}
            hint="This query before Join"
            onClick={() =>
              onOpen("left", null, "Left input (before Join)")
            }
          />
          <Row
            label="Right input rows"
            count={diag.right_count}
            hint="Right query output"
            onClick={() =>
              onOpen("right", null, "Right input (join side)")
            }
          />
          <Row
            label="Output rows"
            count={diag.output_count}
            hint="After this Join"
            onClick={() => onOpen("output", null, "Join output")}
          />
          <Row
            label="Unmatched left"
            count={diag.unmatched_left_count}
            hint="Left rows with no right match"
            muted={diag.unmatched_left_count === 0}
            onClick={
              diag.unmatched_left_count > 0
                ? () =>
                    onOpen(
                      "unmatched_left",
                      diag.unmatched_left,
                      "Unmatched left",
                    )
                : undefined
            }
          />
          <Row
            label="Unmatched right"
            count={diag.unmatched_right_count}
            hint="Right rows with no left match"
            muted={diag.unmatched_right_count === 0}
            onClick={
              diag.unmatched_right_count > 0
                ? () =>
                    onOpen(
                      "unmatched_right",
                      diag.unmatched_right,
                      "Unmatched right",
                    )
                : undefined
            }
          />
          <Row
            label="Fan-out left rows"
            count={diag.fanout_left_count}
            hint="Left rows matching >1 right"
            muted={diag.fanout_left_count === 0}
            onClick={
              diag.fanout_left_count > 0
                ? () =>
                    onOpen("fanout", diag.fanout_pairs, "Fan-out pairs")
                : undefined
            }
          />
          <Row
            label="Duplicate right keys"
            count={diag.right_dup_key_group_count}
            hint="Right key groups with count >1"
            muted={diag.right_dup_key_group_count === 0}
            onClick={
              diag.right_dup_key_group_count > 0
                ? () =>
                    onOpen(
                      "right_dups",
                      diag.right_dup_keys,
                      "Duplicate right keys",
                    )
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
