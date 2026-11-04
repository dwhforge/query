# Website feature shots

Registry: [`website/capture.config.mjs`](../../capture.config.mjs)  
Runner: `npm run capture:website`

```bash
npm run capture:website
npm run capture:website -- --only join-lens
# reuse last dist/:
DWH_CAPTURE_SKIP_UI_BUILD=1 npm run capture:website -- --only create-mapping
```

`DWH_CAPTURE=1` builds the renderer with fixture hooks (same gate as e2e).  
Production / `electron:pack` builds do **not** set it.

Enable/disable shots and ready-gates in the config — do not commit loading or 0% coverage frames.
