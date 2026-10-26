import { useCallback, useRef, type PointerEvent } from "react";

type Props = {
  /** Positive dx = pointer moved right. */
  onDelta: (dx: number) => void;
  /** Fired once when drag ends (for persist). */
  onDragEnd?: () => void;
  "aria-label"?: string;
};

/** Thin vertical drag grip between flex panels. */
export function PanelResizeHandle({
  onDelta,
  onDragEnd,
  "aria-label": ariaLabel = "Resize panel",
}: Props) {
  const lastX = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastX.current;
      if (dx === 0) return;
      lastX.current = e.clientX;
      onDelta(dx);
    },
    [onDelta],
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
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="group relative z-[2] w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-teal-500/25 active:bg-teal-500/40"
    >
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--line)] group-hover:bg-teal-500/60 group-active:bg-teal-400/80" />
    </div>
  );
}
