/**
 * Structured host IPC errors (ADR-0029).
 * Electron rejects with a plain object so `errorDetail` survives the bridge.
 */
import type { HostError } from "../types/hostError";

export class HostRpcError extends Error {
  readonly errorDetail: HostError | null;

  constructor(message: string, errorDetail: HostError | null = null) {
    super(message);
    this.name = "HostRpcError";
    this.errorDetail = errorDetail;
  }

  get kind(): HostError["kind"] | null {
    return this.errorDetail?.kind ?? null;
  }
}

export function isHostRpcError(e: unknown): e is HostRpcError {
  return e instanceof HostRpcError;
}

export function isHostCancelled(e: unknown): boolean {
  if (e instanceof HostRpcError && e.kind === "cancelled") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /preview cancelled|superseded|cancelled/i.test(msg);
}

export function isHostConflict(e: unknown): boolean {
  if (e instanceof HostRpcError && e.kind === "conflict") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /refused|hash mismatch|conflict|concurrently/i.test(msg);
}

/** Normalize Electron / host reject payloads into HostRpcError. */
export function normalizeHostReject(e: unknown): HostRpcError {
  if (e instanceof HostRpcError) return e;
  if (e && typeof e === "object" && "message" in e) {
    const rec = e as {
      message?: unknown;
      errorDetail?: HostError | null;
      error_detail?: HostError | null;
    };
    const message =
      typeof rec.message === "string" ? rec.message : String(rec.message ?? e);
    const detail = rec.errorDetail ?? rec.error_detail ?? null;
    return new HostRpcError(message, detail);
  }
  if (e instanceof Error) return new HostRpcError(e.message, null);
  return new HostRpcError(String(e), null);
}
