import { useCallback, useRef, type PointerEvent } from "react";

type Props = {
  /**
   * vertical (default): between side panels — positive dx = pointer moved right.
   * horizontal: between stacked panes — positive dy = pointer moved down.
   */
  orientation?: "vertical" | "horizontal";
  /** Delta along the resize axis (dx for vertical, dy for horizontal). */
  onDelta: (delta: number) => void;
  /** Fired once when drag ends (for persist). */
  onDragEnd?: () => void;
  "aria-label"?: string;
};

/** Thin drag grip between flex panels. */
export function PanelResizeHandle({
  orientation = "vertical",
  onDelta,
  onDragEnd,
  "aria-label": ariaLabel = "Resize panel",
}: Props) {
  const last = useRef(0);
  const dragging = useRef(false);
  const horizontal = orientation === "horizontal";

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragging.current = true;
      last.current = horizontal ? e.clientY : e.clientX;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
    },
    [horizontal],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const pos = horizontal ? e.clientY : e.clientX;
      const d = pos - last.current;
      if (d === 0) return;
      last.current = pos;
      onDelta(d);
    },
    [horizontal, onDelta],
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={
        horizontal
          ? "group relative z-[2] h-1.5 w-full shrink-0 cursor-row-resize bg-transparent hover:bg-teal-500/25 active:bg-teal-500/40"
          : "group relative z-[2] w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-teal-500/25 active:bg-teal-500/40"
      }
    >
      <div
        className={
          horizontal
            ? "pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--line)] group-hover:bg-teal-500/60 group-active:bg-teal-400/80"
            : "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--line)] group-hover:bg-teal-500/60 group-active:bg-teal-400/80"
        }
      />
    </div>
  );
}
