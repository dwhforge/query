/**
 * Shared SCD bound parsing (ADR-0028).
 * Formats: `YYYY-MM-DD` (UTC midnight) or `YYYY-MM-DD[T ]HH:MM:SS[.fff]`.
 * No timezone offsets — reject `+03:00` / trailing garbage. Trailing `Z` = UTC ok.
 */

export type ScdBoundParse =
  | { ok: true; epochMs: number; kind: "date" | "timestamp" }
  | { ok: false; error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z?$/;

function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

function validCivil(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d))
    return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** Parse SCD bound to UTC epoch ms; null on failure (legacy helper). */
export function parseScdBound(raw: string): number | null {
  const r = parseScdBoundDetailed(raw);
  return r.ok ? r.epochMs : null;
}

export function parseScdBoundDetailed(raw: string): ScdBoundParse {
  const s = raw.trim();
  if (!s) return { ok: false, error: "empty bound" };
  // Reject explicit offsets / named zones early.
  if (/[+-]\d{2}:?\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    return { ok: false, error: "timezone offsets not supported (use UTC / Z)" };
  }

  const dateOnly = DATE_RE.exec(s);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    if (!validCivil(y, m, d)) {
      return { ok: false, error: `invalid calendar date ${s}` };
    }
    const epochMs = Date.UTC(y, m - 1, d);
    // Round-trip guard against Date.UTC overflow (e.g. Feb 31 → Mar)
    const rt = new Date(epochMs);
    if (
      rt.getUTCFullYear() !== y ||
      rt.getUTCMonth() + 1 !== m ||
      rt.getUTCDate() !== d
    ) {
      return { ok: false, error: `invalid calendar date ${s}` };
    }
    return { ok: true, epochMs, kind: "date" };
  }

  const ts = TS_RE.exec(s);
  if (!ts) {
    return {
      ok: false,
      error: "expected YYYY-MM-DD or YYYY-MM-DD[T ]HH:MM:SS[.fff][Z]",
    };
  }
  const y = Number(ts[1]);
  const m = Number(ts[2]);
  const d = Number(ts[3]);
  const hh = Number(ts[4]);
  const mm = Number(ts[5]);
  const ss = Number(ts[6]);
  const frac = ts[7] ?? "";
  if (!validCivil(y, m, d)) {
    return { ok: false, error: `invalid calendar date ${s}` };
  }
  if (hh > 23 || mm > 59 || ss > 60) {
    return { ok: false, error: `time out of range in ${s}` };
  }
  if (frac && !/^\d+$/.test(frac)) {
    return { ok: false, error: `invalid fractional seconds in ${s}` };
  }
  const ms = frac
    ? Number((frac + "000").slice(0, 3)) // truncate to ms
    : 0;
  const epochMs = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  const rt = new Date(epochMs);
  if (
    rt.getUTCFullYear() !== y ||
    rt.getUTCMonth() + 1 !== m ||
    rt.getUTCDate() !== d ||
    rt.getUTCHours() !== hh ||
    rt.getUTCMinutes() !== mm ||
    rt.getUTCSeconds() !== ss
  ) {
    return { ok: false, error: `invalid timestamp ${s}` };
  }
  return { ok: true, epochMs, kind: "timestamp" };
}
