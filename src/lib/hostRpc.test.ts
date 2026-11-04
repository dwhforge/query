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

console.log("hostRpc.test.ts: ok");
