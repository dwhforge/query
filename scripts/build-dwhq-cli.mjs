/** Build standalone Node CLI from existing TypeScript application services. */
import { build } from "esbuild";
await build({
  entryPoints: ["tools/dwhq/main.ts"],
  outfile: "dist/dwhq.mjs",
  platform: "node",
  format: "esm",
  bundle: true,
  target: ["node20"],
  packages: "external",
  banner: {js: "#!/usr/bin/env node"},
});
console.log("Built dist/dwhq.mjs");
