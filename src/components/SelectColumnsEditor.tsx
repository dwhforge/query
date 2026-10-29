import { memo, useRef, useState } from "react";

type Props = {
  initialColumns: string[];
  choices: string[];
  onApply: (columns: string[]) => void;
};

function SelectColumnsEditorImpl({
  initialColumns,
  choices,
  onApply,
}: Props) {
  const [selected, setSelected] = useState<string[]>(() => [...initialColumns]);
  const textRef = useRef<HTMLInputElement>(null);

  function toggle(name: string) {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name],
    );
  }

  return (
    <>
      {choices.length > 0 && (
        <>
          <div className="flex gap-1">
            <button
              type="button"
              className="flex-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-teal-800 hover:text-teal-200"
              onClick={() => setSelected([...choices])}
            >
              Select all
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-slate-600 hover:text-slate-200"
              onClick={() => setSelected([])}
            >
              Clear
            </button>
          </div>
          <ul className="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1.5">
            {choices.map((name) => {
              const checked = selected.includes(name);
              return (
                <li key={name}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-200 hover:bg-slate-900">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(name)}
                      className="rounded border-slate-600"
                    />
                    <span className="font-mono">{name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <input
        key={selected.join(",")}
        ref={textRef}
        type="text"
        defaultValue={selected.join(", ")}
        placeholder="date, region, amount"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 outline-none focus:ring-2 focus:ring-teal-700"
      />
      <button
        type="button"
        className="w-full rounded-lg bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/25"
        onClick={() => {
          const typed = textRef.current?.value;
          const columns =
            typed !== undefined && typed !== selected.join(", ")
              ? typed
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [...selected];
          setSelected(columns);
          onApply(columns);
        }}
      >
        Apply
      </button>
    </>
  );
}

export const SelectColumnsEditor = memo(SelectColumnsEditorImpl);
