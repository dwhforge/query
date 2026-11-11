import assert from "node:assert/strict";
import {
  abortable,
  abortedError,
  isAbortError,
  throwIfAborted,
} from "./abortable";

{
  assert.equal(abortedError().name, "AbortError");
  assert.ok(isAbortError(abortedError()));
}

{
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => throwIfAborted(ac.signal), /cancelled/i);
}

await (async () => {
  const ac = new AbortController();
  const slow = new Promise<string>((resolve) => {
    setTimeout(() => resolve("late"), 500);
  });
  setTimeout(() => ac.abort(), 10);
  let aborted = false;
  try {
    await abortable(slow, ac.signal);
  } catch (e) {
    aborted = isAbortError(e);
  }
  assert.equal(aborted, true);
})();

console.log("abortable.test.ts: ok");
