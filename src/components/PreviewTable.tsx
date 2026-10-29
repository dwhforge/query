import { memo, useEffect, useMemo, useRef } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnMetadata } from "../types/pipeline";
import {
  JOIN_ORIGIN_LABEL,
  type JoinColumnOrigin,
} from "../lib/joinColumnOrigin";

interface PreviewTableProps {
  columns: ColumnMetadata[];
  rows: unknown[][];
  /** Column names to emphasize (e.g. Join keys). */
  highlightKeys?: string[];
  /** Per-column Join Lens origin (same length as columns). */
  columnOrigins?: JoinColumnOrigin[];
  activeRowIndex?: number;
  onActiveRowChange?: (index: number) => void;
  onVisibleRangeChange?: (range: { start: number; end: number }) => void;
  onActiveRowElement?: (el: HTMLElement | null) => void;
  onScrollParentRef?: (el: HTMLDivElement | null) => void;
  /** Result rows matching a side-probe selection (Join Lens). */
  matchedRowIndices?: number[];
}

function foldKey(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function originHeaderClass(o: JoinColumnOrigin | undefined): string {
  switch (o) {
    case "key":
      return "text-teal-200";
    case "left":
      return "text-sky-200";
    case "right":
      return "text-amber-200";
    case "downstream":
      return "text-violet-200";
    default:
      return "text-slate-100";
  }
}

function originCellClass(o: JoinColumnOrigin | undefined): string {
  switch (o) {
    case "key":
      return "text-teal-100";
    case "left":
      return "text-sky-100/90";
    case "right":
      return "text-amber-100/90";
    case "downstream":
      return "text-violet-100/90";
    default:
      return "text-slate-200";
  }
}

function originBarClass(o: JoinColumnOrigin | undefined): string {
  switch (o) {
    case "key":
      return "bg-teal-400/80";
    case "left":
      return "bg-sky-400/70";
    case "right":
      return "bg-amber-400/70";
    case "downstream":
      return "bg-violet-400/70";
    default:
      return "bg-transparent";
  }
}

function PreviewTableImpl({
  columns,
  rows,
  highlightKeys = [],
  columnOrigins,
  activeRowIndex,
  onActiveRowChange,
  onVisibleRangeChange,
  onActiveRowElement,
  onScrollParentRef,
  matchedRowIndices,
}: PreviewTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef<Map<number, HTMLElement>>(new Map());
  const hi = new Set(highlightKeys.map(foldKey));
  const matched = useMemo(
    () => new Set(matchedRowIndices ?? []),
    [matchedRowIndices],
  );

  useEffect(() => {
    onScrollParentRef?.(parentRef.current);
    return () => onScrollParentRef?.(null);
  }, [onScrollParentRef]);

  const columnDefs: ColumnDef<unknown[]>[] = columns.map((col, index) => ({
    id: `${col.name}-${index}`,
    header: () => {
      const origin = columnOrigins?.[index];
      const on = origin === "key" || hi.has(foldKey(col.name));
      const label = origin ? JOIN_ORIGIN_LABEL[origin] : on ? "join" : null;
      const tip = label ? `${col.name} · ${label}` : col.name;
      return (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span
            title={tip}
            className={`relative block truncate pl-1.5 font-medium ${originHeaderClass(origin ?? (on ? "key" : undefined))}`}
          >
            <span
              className={`absolute left-0 top-0.5 h-3 w-0.5 rounded-full ${originBarClass(origin ?? (on ? "key" : undefined))}`}
              aria-hidden
            />
            {col.name}
          </span>
          <span className="truncate text-[10px] uppercase tracking-wide text-slate-500">
            {label ? `${label} · ` : ""}
            {col.type}
          </span>
        </span>
      );
    },
    cell: ({ row }) => {
      const value = row.original[index];
      const origin = columnOrigins?.[index];
      const on = origin === "key" || hi.has(foldKey(col.name));
      return (
        <span
          className={`block truncate ${originCellClass(origin ?? (on ? "key" : undefined))}`}
        >
          {value === null || value === undefined ? "∅" : String(value)}
        </span>
      );
    },
  }));

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  const rowModel = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rowModel.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!onVisibleRangeChange || virtualItems.length === 0) return;
    const start = virtualItems[0].index;
    const end = virtualItems[virtualItems.length - 1].index + 1;
    onVisibleRangeChange({ start, end });
  }, [virtualItems, onVisibleRangeChange]);

  useEffect(() => {
    if (activeRowIndex == null || !onActiveRowElement) return;
    onActiveRowElement(rowEls.current.get(activeRowIndex) ?? null);
  }, [activeRowIndex, virtualItems, onActiveRowElement]);

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        Нет данных для превью
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ width: Math.max(columns.length * 140, 100) }}>
        <div className="sticky top-0 z-10 flex border-b border-slate-700 bg-slate-900">
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
              <div
                key={header.id}
                className="w-[140px] min-w-0 shrink-0 overflow-hidden px-3 py-2 text-left text-xs"
              >
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                )}
              </div>
            )),
          )}
        </div>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {virtualItems.map((virtualRow) => {
            const row = rowModel[virtualRow.index];
            const active = activeRowIndex === virtualRow.index;
            const isMatch = matched.has(virtualRow.index);
            const dimUnmatched =
              matched.size > 0 && !isMatch && !active;
            return (
              <div
                key={row.id}
                ref={(el) => {
                  if (el) rowEls.current.set(virtualRow.index, el);
                  else rowEls.current.delete(virtualRow.index);
                }}
                role="row"
                tabIndex={0}
                onMouseEnter={() => onActiveRowChange?.(virtualRow.index)}
                onFocus={() => onActiveRowChange?.(virtualRow.index)}
                onClick={() => onActiveRowChange?.(virtualRow.index)}
                className={`absolute left-0 flex border-b border-slate-800/80 ${
                  active
                    ? "bg-teal-500/15 ring-1 ring-inset ring-teal-500/40"
                    : isMatch
                      ? "bg-teal-500/10 ring-1 ring-inset ring-teal-600/30"
                      : dimUnmatched
                        ? "opacity-35 hover:opacity-70 hover:bg-slate-800/40"
                        : "hover:bg-slate-800/40"
                }`}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  width: "100%",
                }}
              >
                {row.getVisibleCells().map((cell, cellIndex) => {
                  const origin = columnOrigins?.[cellIndex];
                  return (
                    <div
                      key={cell.id}
                      data-join-origin={origin ?? undefined}
                      className="w-[140px] min-w-0 shrink-0 overflow-hidden px-3 py-2 text-xs"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const PreviewTable = memo(PreviewTableImpl);
