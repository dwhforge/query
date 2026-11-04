# Website feature shots

Registry: [`website/capture.config.mjs`](../../capture.config.mjs)  
Runner: `npm run capture:website`

```bash
npm run capture:website
npm run capture:website -- --only join-lens
```

## Naming (used by `site.js`)

| File | Role |
|------|------|
| `<id>.png` | List thumb (tight crop) |
| `<id>-full.png` | Lightbox expand — **must be larger / different** than thumb |

If `-full` is missing, Expand falls back to the thumb (OK for legacy).  
Never commit a `-full` that is a byte-identical copy of the thumb.  
`site.js` auto-discovers `-full`; HTML only sets `data-shot="<id>"`.

## Current inventory

| id | thumb | distinct `-full`? |
|----|-------|-------------------|
| add-to-map | yes | yes |
| cleanup | yes | yes |
| suggest-all | yes | yes |
| create-mapping | yes (wizard crop) | yes (viewport) |
| join-lens | yes (dock chrome) | yes (Focus Join Lens viewport) |
| mapping-quality | yes (overview panel) | yes (viewport) |
| preview, edit-join, publish, export, steps, suggest, apply-keymap, no-match, seed | yes | no (lightbox = thumb) |
| references | — | no asset yet |

**Notes**
- `join-lens`: thumb is taken **before** Focus Join Lens; `-full` after. Do not use a viewport-sized locator for the thumb.
- `mapping-quality`: requires Catalog coverage > 0% (seed ApplyKeyMap). Host must materialize seed KeyMap rows for preview when step entries are empty.
- `seed.png` currently matches `export.png` (same hash) — replace when a real seed-storage shot exists.
