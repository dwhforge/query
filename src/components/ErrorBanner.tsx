import { useState } from "react";

/** Strip ANSI color codes from dbt / terminal logs. */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** First actionable line from a dbt / host error blob. */
export function summarizeError(raw: string): string {
  const plain = stripAnsi(raw).replace(/\r/g, "");
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (/DuckDB hit its memory_limit/i.test(plain)) {
    return plain.split("Detail:")[0].trim().slice(0, 320);
  }
  const prefer = lines.find((l) =>
    /IO Error:|Runtime Error:|Compilation Error:|Database Error:|Parsing Error:|Catalog Error:|Binder Error:|Encountered an error|memory_limit|Out of Memory/i.test(
      l,
    ),
  );
  if (prefer) {
    return prefer
      .replace(/^\[?\s*ERROR\s*\]?:?\s*/i, "")
      .replace(/^Encountered an error:\s*/i, "")
      .slice(0, 280);
  }
  const noTrace = lines.find(
    (l) => !/^File "|^Traceback|^During handling|^ {2}/.test(l),
  );
  return (noTrace ?? lines[0] ?? "Operation failed").slice(0, 280);
}

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const plain = stripAnsi(message);
  const summary = summarizeError(message);
  const long = plain.length > summary.length + 40 || plain.includes("\n");

  return (
    <div className="rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 leading-snug">{summary}</p>
        <div className="flex shrink-0 items-center gap-1">
          {long && (
            <button
              type="button"
              className="rounded border border-rose-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-300/90 hover:bg-rose-500/10"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide log" : "Details"}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-rose-400/80 hover:bg-rose-500/10"
              onClick={onDismiss}
              title="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {open && long && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-rose-900/40 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-rose-100/80">
          {plain}
        </pre>
      )}
    </div>
  );
}
