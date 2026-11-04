import {
  HostRpcError,
  isHostCancelled,
  isHostConflict,
  normalizeHostReject,
  unpackInvokeReply,
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

const ok = unpackInvokeReply({ ok: true as const, result: { n: 1 } });
assert(ok.n === 1, "ok envelope");

let threw: unknown;
try {
  unpackInvokeReply({
    ok: false as const,
    message: "superseded",
    errorDetail: { kind: "cancelled", message: "superseded" },
  });
} catch (e) {
  threw = e;
}
assert(threw instanceof HostRpcError, "err envelope → HostRpcError");
assert(isHostCancelled(threw), "unpack preserves cancelled");

console.log("hostRpc.test.ts: ok");
