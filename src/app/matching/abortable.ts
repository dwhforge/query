/**
 * Client-side cancel for Matching LLM calls.
 * Host `llm_chat` has no abort yet — we stop waiting and ignore late replies.
 */
export function abortedError(): Error {
  const e = new Error("LLM cancelled");
  e.name = "AbortError";
  return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/** Resolves when `signal` aborts (or immediately if already aborted). */
export function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortedError()), {
      once: true,
    });
  });
}

/** Race a promise against AbortSignal — Cancel unblocks UI immediately. */
export async function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return Promise.race([work, whenAborted(signal)]);
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === "AbortError") ||
    (typeof e === "object" &&
      e !== null &&
      "name" in e &&
      (e as { name: string }).name === "AbortError")
  );
}
