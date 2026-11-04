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

// Nested domain {ok:false, log} inside an outer successful IPC envelope is a
// domain result — unpack must return it, not throw as HostRpcError.
const nestedDomain = unpackInvokeReply({
  ok: true as const,
  result: { ok: false as const, log: "dbt failed", code: 1 },
});
assert(nestedDomain.ok === false, "nested domain ok:false preserved");
assert(nestedDomain.log === "dbt failed", "nested domain payload");

assert(unpackInvokeReply(null) === null, "null passthrough");
assert(unpackInvokeReply(42) === 42, "primitive passthrough");
assert(unpackInvokeReply("x") === "x", "string passthrough");

try {
  unpackInvokeReply({
    ok: false as const,
    message: "socket closed",
    error_detail: {
      kind: "internal",
      message: "socket closed",
      correlation_id: "c1",
    },
  });
  assert(false, "snake_case error_detail must throw");
} catch (e) {
  assert(e instanceof HostRpcError, "snake_case → HostRpcError");
  assert(
    (e as HostRpcError).errorDetail?.kind === "internal",
    "snake_case detail kind",
  );
}

const transport = normalizeHostReject(new Error("ECONNREFUSED"));
assert(transport instanceof HostRpcError, "transport reject");
assert(transport.errorDetail === null, "transport has no HostError");
assert(!isHostCancelled(transport), "transport ≠ cancelled");

console.log("hostRpc.test.ts: ok");
