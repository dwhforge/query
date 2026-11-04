# Design — execution-lifecycle

## Host (already largely present)

```
enqueue_heavy(cmd)
  → lane slot (preview|analysis|mutation)
  → worker dispatch_heavy_job
  → reply on SyncSender / IPC id
```

Cancel: `preview_cancel.interrupt()` + Err cancelled to superseded waiters.

## Renderer

```ts
type RequestGen = { gen: number };
function nextGen(r: RequestGen): number;
function isCurrent(r: RequestGen, gen: number): boolean;
```

Wrap `hostInvoke` call sites for preview_workspace / check-related RPCs so late replies no-op.

## Tests

- Host: superseded pending receives cancelled kind (unit if reachable).
- TS: helper unit test for generation gating.
