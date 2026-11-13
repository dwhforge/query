/**
 * Test-only bridge helpers. Compiled into the renderer only when
 * `import.meta.env.DWH_E2E === "1"` (see vite.config + `npm run test:e2e:electron`).
 */

export function isE2eBuild(): boolean {
  try {
    return String(import.meta.env.DWH_E2E ?? "") === "1";
  } catch {
    return false;
  }
}

type DescribeHold = {
  pending: Promise<void>;
  resolve: () => void;
  started: boolean;
  startedWaiters: Array<() => void>;
  /** Resolves after the held describe invoke finishes (success or error). */
  settled: Promise<void>;
  settle: () => void;
  settledDone: boolean;
  settleWaiters: Array<() => void>;
};

let describeHold: DescribeHold | null = null;

/** Next `describe_workspace` invoke waits until `e2eReleaseDescribeHold()`. */
export function e2eArmDescribeHold(): void {
  if (!isE2eBuild()) {
    throw new Error("e2eArmDescribeHold: not an E2E build");
  }
  let resolve!: () => void;
  const pending = new Promise<void>((r) => {
    resolve = r;
  });
  let settle!: () => void;
  const settled = new Promise<void>((r) => {
    settle = r;
  });
  describeHold = {
    pending,
    resolve,
    started: false,
    startedWaiters: [],
    settled,
    settle,
    settledDone: false,
    settleWaiters: [],
  };
}

export function e2eReleaseDescribeHold(): void {
  const hold = describeHold;
  if (!hold) return;
  hold.resolve();
}

export function e2eWaitDescribeStarted(): Promise<void> {
  const hold = describeHold;
  if (!hold) return Promise.reject(new Error("no describe hold armed"));
  if (hold.started) return Promise.resolve();
  return new Promise((r) => {
    hold.startedWaiters.push(r);
  });
}

/** Wait until the held describe IPC has finished (after release). */
export function e2eWaitDescribeSettled(): Promise<void> {
  const hold = describeHold;
  if (!hold || hold.settledDone) return Promise.resolve();
  return new Promise((r) => {
    hold.settleWaiters.push(r);
  });
}

/** @deprecated use e2eWaitDescribeSettled */
export function e2eWaitDescribeReleased(): Promise<void> {
  return e2eWaitDescribeSettled();
}

/** Called from `invoke` before the real host call when a hold is armed. */
export async function e2eMaybeHoldDescribe(cmd: string): Promise<void> {
  if (cmd !== "describe_workspace" || !describeHold) return;
  const hold = describeHold;
  if (!hold.started) {
    hold.started = true;
    for (const w of hold.startedWaiters) w();
    hold.startedWaiters = [];
  }
  await hold.pending;
}

/** Called from `invoke` after describe_workspace returns/throws when a hold was used. */
export function e2eNotifyDescribeSettled(cmd: string): void {
  if (cmd !== "describe_workspace" || !describeHold) return;
  const hold = describeHold;
  if (hold.settledDone) return;
  hold.settledDone = true;
  hold.settle();
  for (const w of hold.settleWaiters) w();
  hold.settleWaiters = [];
  describeHold = null;
}

// Test-only one-shot hold for structural preview; later previews are not blocked.
type PreviewHold = {
  pending: Promise<void>; release: () => void; claimed: boolean;
  started: Promise<void>; start: () => void;
  settled: Promise<void>; settle: () => void;
};
let previewHold: PreviewHold | null = null;
export function e2eArmPreviewHold() {
  if (!isE2eBuild()) throw new Error("not an E2E build");
  let release!: () => void, start!: () => void, settle!: () => void;
  const pending = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { start = r; });
  const settled = new Promise<void>((r) => { settle = r; });
  previewHold = { pending, release, claimed: false, started, start, settled, settle };
}
export function e2eClaimPreviewHold(cmd: string) {
  if (cmd !== "preview_workspace" || !previewHold || previewHold.claimed) return null;
  previewHold.claimed = true;
  previewHold.start();
  return previewHold;
}
export function e2eReleasePreviewHold() { previewHold?.release(); }
export function e2eWaitPreviewStarted() { return previewHold?.started ?? Promise.reject(new Error("no preview hold")); }
export function e2eWaitPreviewSettled() { return previewHold?.settled ?? Promise.resolve(); }
