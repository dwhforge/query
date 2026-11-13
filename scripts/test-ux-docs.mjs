#!/usr/bin/env node
/** PR-05 documentation regression: local links/media and optional public URLs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "docs/GETTING_STARTED.md", "docs/DEMOS.md", "docs/RELEASE_NOTES.md",
  "docs/adr/0046-flagship-lab-assistance.md", "docs/stabilization/UX_IMPACT_REPORT.md"];
for (const change of ["recon-lab-task", "recon-lab-hints", "recon-lab-comparison", "execution-confidence"]) {
  const dir = `openspec/changes/${change}`;
  files.push(...["proposal.md", "design.md", "tasks.md", "report.md"].map((name) => `${dir}/${name}`));
  files.push(`${dir}/specs/${change === "execution-confidence" ? "execution-lifecycle" : "help-lab"}/spec.md`);
}
let links = 0;
for (const file of files) {
  const body = fs.readFileSync(path.join(root, file), "utf8");
  const targets = [...body.matchAll(/\]\(([^)]+)\)|\bsrc="([^"]+)"/g)].map((match) => match[1] ?? match[2]);
  for (const target of targets) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const locator = target.split("#")[0].replace(/:\d+$/, "");
    if (locator) assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), locator)), `${file}: missing ${target}`);
    links += 1;
  }
}
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
assert.match(readme, /git clone --branch main /);
assert.doesNotMatch(readme, /git clone --branch feature\/mapping_tools/);
assert.match(readme, /npm ci/);
assert.match(readme, /pre-existing, partial example/);
assert.match(readme, /No PostgreSQL, LLM provider, account/);
assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /Business Source License 1\.1/);
for (const name of ["flagship-join-lens.png", "recon-task-card.png", "recon-no-match-hint.png",
  "execution-pending-before.png", "execution-pending-after.png", "execution-error-before.png", "execution-error-after.png"]) {
  const image = fs.readFileSync(path.join(root, "docs/stabilization", name));
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${name}: not a PNG`);
}
console.log(`UX docs: ${files.length} documents, ${links} local links/media references checked; source/license copy assertions passed.`);

if (process.env.DWH_CHECK_REMOTE_LINKS === "1") {
  for (const url of ["https://github.com/dwhforge/query/releases", "https://github.com/dwhforge/query/tree/main",
    "https://github.com/dwhforge/query/tree/feature/matching"]) {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    console.log(`Remote link: HTTP ${response.status} ${url}`);
  }
} else {
  console.log("Remote HTTP checks not requested; set DWH_CHECK_REMOTE_LINKS=1 to check public pages.");
}
