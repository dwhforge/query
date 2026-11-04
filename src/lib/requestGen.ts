/**
 * Generation counter so late IPC replies are ignored (ADR-0031).
 * One instance per UI surface (preview pane, check run, …).
 */
export type RequestGen = { gen: number };

export function createRequestGen(): RequestGen {
  return { gen: 0 };
}

/** Bump and return the generation that must match when the reply arrives. */
export function nextRequestGen(r: RequestGen): number {
  r.gen += 1;
  return r.gen;
}

export function isCurrentRequest(r: RequestGen, gen: number): boolean {
  return r.gen === gen;
}
