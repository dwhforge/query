import { createRequestGen, isCurrentRequest, nextRequestGen } from "./requestGen";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const r = createRequestGen();
assert(r.gen === 0, "starts at 0");
const a = nextRequestGen(r);
const b = nextRequestGen(r);
assert(a === 1 && b === 2, "monotonic");
assert(!isCurrentRequest(r, a), "A stale after B");
assert(isCurrentRequest(r, b), "B current");
console.log("requestGen.test.ts: ok");
