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
