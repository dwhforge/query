#!/usr/bin/env node
/**
 * Bundle + run TS application-service / hostRpc unit tests (no Jest).
 * CI: npm run test:unit
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const tests = [
  "src/lib/hostRpc.test.ts",
  "src/lib/requestGen.test.ts",
  "src/lib/mappingCheck.test.ts",
  "src/app/keyMap/service.test.ts",
  "src/app/mappingChecks/service.test.ts",
];

const dir = mkdtempSync(join(tmpdir(), "dwh-unit-"));
let failed = 0;
try {
  for (const rel of tests) {
    const out = join(dir, rel.replace(/\//g, "_") + ".mjs");
    const build = spawnSync(
      "npx",
      ["esbuild", "--bundle", "--platform=node", "--format=esm", rel, `--outfile=${out}`],
      { cwd: root, encoding: "utf8" },
    );
    if (build.status !== 0) {
      console.error(build.stderr || build.stdout);
      failed += 1;
      continue;
    }
    const run = spawnSync("node", [out], { cwd: root, encoding: "utf8" });
    process.stdout.write(run.stdout || "");
    if (run.status !== 0) {
      console.error(run.stderr || `FAIL ${rel}`);
      failed += 1;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} test file(s) failed`);
  process.exit(1);
}
console.log("test:unit ok");
