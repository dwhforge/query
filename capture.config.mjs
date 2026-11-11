/**
 * Website feature-shot capture registry.
 *
 * Run:
 *   npm run capture:website
 *   npm run capture:website -- --only create-mapping
 *
 * Shots land in `website/assets/features/<id>.png` (+ optional `-full.png`).
 * Handlers live in `scripts/capture-website-shots.mjs`.
 * Never publish a loading / waiting / 0%-coverage frame.
 */

/** @typedef {'create-mapping' | 'join-lens' | 'mapping-quality'} ShotId */

/** @type {{
 *   window: { width: number, height: number },
 *   outDir: string,
 *   shots: Array<{
 *     id: ShotId,
 *     enabled: boolean,
 *     dataShot: string,
 *     note?: string,
 *     ready: string,
 *   }>
 * }} */
export default {
  window: { width: 1440, height: 900 },
  outDir: "website/assets/features",
  shots: [
    {
      id: "create-mapping",
      enabled: true,
      dataShot: "create-mapping",
      ready: "Fields step with “excluded by last Fields” visible",
    },
    {
      id: "join-lens",
      enabled: true,
      dataShot: "join-lens",
      ready: "This row / No match + Suggest all… action (not a third tab)",
    },
    {
      id: "mapping-quality",
      enabled: true,
      dataShot: "mapping-quality",
      ready: ".quality-loading gone AND Catalog coverage > 0%",
    },
  ],
};
