import {
  HostRpcError,
  isHostCancelled,
  isHostConflict,
  normalizeHostReject,
} from "./hostRpc";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const cancelled = normalizeHostReject({
  message: "Preview superseded.",
  errorDetail: { kind: "cancelled", message: "Preview superseded." },
});
assert(cancelled instanceof HostRpcError, "HostRpcError");
assert(isHostCancelled(cancelled), "cancelled");
assert(!isHostConflict(cancelled), "not conflict");

const conflict = normalizeHostReject({
  message: "refused: hash",
  errorDetail: { kind: "conflict", message: "refused: hash" },
});
assert(isHostConflict(conflict), "conflict");

assert(
  isHostCancelled(new Error("Preview superseded.")),
  "legacy cancelled string",
);

// Envelope shape that Electron main must resolve (not reject) so errorDetail survives.
function decodeInvokeReply(reply: unknown): HostRpcError | { ok: true; result: unknown } {
  if (reply && typeof reply === "object" && "ok" in reply) {
    const env = reply as {
      ok: boolean;
      result?: unknown;
      message?: string;
      errorDetail?: { kind: string; message: string } | null;
    };
    if (env.ok) return { ok: true, result: env.result };
    return normalizeHostReject({
      message: env.message ?? "host error",
      errorDetail: env.errorDetail ?? null,
    });
  }
  throw new Error("expected envelope");
}

const okEnv = decodeInvokeReply({ ok: true, result: { n: 1 } });
assert("ok" in okEnv && okEnv.ok && (okEnv.result as { n: number }).n === 1, "ok envelope");

const errEnv = decodeInvokeReply({
  ok: false,
  message: "superseded",
  errorDetail: { kind: "cancelled", message: "superseded" },
});
assert(errEnv instanceof HostRpcError, "err envelope → HostRpcError");
assert(isHostCancelled(errEnv), "envelope preserves cancelled");

console.log("hostRpc.test.ts: ok");
