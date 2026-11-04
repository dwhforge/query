#!/usr/bin/env node
/**
 * Bundle + run all discovered TS unit tests (no Jest).
 * CI: npm run test:unit
 *
 * Uses the repo-pinned esbuild binary (optionalDependency / npm ci) —
 * never `npx` download of an arbitrary version.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

/** Walk src/ for *.test.ts (no .tsx / browser harness in this gate). */
function discoverTests(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      discoverTests(p, out);
    } else if (name.endsWith(".test.ts")) {
      out.push(relative(root, p).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

const tests = discoverTests(join(root, "src"));
if (tests.length === 0) {
  console.error("No src/**/*.test.ts found");
  process.exit(1);
}

/** Prefer platform binary; `esbuild/bin/esbuild` is a native ELF/EXE, not JS. */
const esbuildCandidates = [
  join(root, "node_modules/@esbuild/linux-x64/bin/esbuild"),
  join(root, "node_modules/@esbuild/win32-x64/esbuild.exe"),
  join(root, "node_modules/esbuild/bin/esbuild"),
];
const esbuildCmd = esbuildCandidates.find((p) => existsSync(p));
if (!esbuildCmd) {
  console.error(
    "esbuild binary missing after npm ci — install optionalDependencies (@esbuild/*)",
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "dwh-unit-"));
let failed = 0;
console.log(`test:unit — ${tests.length} file(s)`);
try {
  for (const rel of tests) {
    const out = join(dir, rel.replace(/\//g, "_") + ".mjs");
    const build = spawnSync(
      esbuildCmd,
      [
        "--bundle",
        "--platform=node",
        "--format=esm",
        rel,
        `--outfile=${out}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (build.status !== 0) {
      console.error(`BUILD FAIL ${rel}`);
      console.error(build.stderr || build.stdout);
      failed += 1;
      continue;
    }
    const run = spawnSync(process.execPath, [out], {
      cwd: root,
      encoding: "utf8",
    });
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
