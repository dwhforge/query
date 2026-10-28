import { useRef } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnMetadata } from "../types/pipeline";

interface PreviewTableProps {
  columns: ColumnMetadata[];
  rows: unknown[][];
  /** Column names to emphasize (e.g. Join keys). */
  highlightKeys?: string[];
}

function foldKey(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function PreviewTable({
  columns,
  rows,
  highlightKeys = [],
}: PreviewTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const hi = new Set(highlightKeys.map(foldKey));

  const columnDefs: ColumnDef<unknown[]>[] = columns.map((col, index) => ({
    id: `${col.name}-${index}`,
    header: () => {
      const on = hi.has(foldKey(col.name));
      return (
        <span className="flex flex-col gap-0.5">
          <span
            className={`font-medium ${on ? "text-teal-200" : "text-slate-100"}`}
          >
            {col.name}
            {on ? " · key" : ""}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-slate-500">
            {col.type}
          </span>
        </span>
      );
    },
    cell: ({ row }) => {
      const value = row.original[index];
      const on = hi.has(foldKey(col.name));
      return (
        <span
          className={`block truncate ${on ? "text-teal-100" : "text-slate-200"}`}
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
    overscan: 12,
  });

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
                className="w-[140px] shrink-0 px-3 py-2 text-left text-xs"
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
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rowModel[virtualRow.index];
            return (
              <div
                key={row.id}
                className="absolute left-0 flex border-b border-slate-800/80 hover:bg-slate-800/40"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                  width: "100%",
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    className="w-[140px] shrink-0 px-3 py-2 text-xs"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
