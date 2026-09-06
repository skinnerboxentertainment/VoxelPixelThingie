/**
 * Build a release the way anyone can rebuild it (PLAN-4.md Phase 22).
 *
 *   npm run release:build [-- --out release] [--no-sbom]
 *
 * Runs the demo and reader builds with SOURCE_DATE_EPOCH pinned to the
 * commit's time, hashes both trees, and writes `release.json` (the
 * manifest with one digest) and `sbom.spdx.json` (from `npm sbom`, the
 * whole dependency tree; its own timestamp and namespace make it
 * non-reproducible, so it sits beside the manifest, outside the digest).
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { manifestFor } from "./release.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const out = flag("out") ?? "release";
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const epoch = Number(git("show", "-s", "--format=%ct", "HEAD"));
const dirty = git("status", "--porcelain").length > 0;
const version = (JSON.parse(await fs.readFile("package.json", "utf8")) as { version: string }).version;

const env = { ...process.env, SOURCE_DATE_EPOCH: String(epoch), TZ: "UTC" };
const run = (script: string) => {
  const t0 = performance.now();
  execFileSync("npm", ["run", script], { env, stdio: "ignore", shell: true });
  return performance.now() - t0;
};
console.log(`building ${version} at ${commit.slice(0, 12)}${dirty ? " (working tree dirty: the manifest names the commit, not the tree)" : ""}, SOURCE_DATE_EPOCH ${epoch}`);
const tDemo = run("build");
const tReader = run("build:reader");
const manifest = await manifestFor({ version, commit, epoch }, { dist: "dist", "dist-reader": "dist-reader" });
await fs.mkdir(out, { recursive: true });
await fs.writeFile(join(out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
let sbomNote = "skipped";
if (!args.includes("--no-sbom")) {
  // The whole tree, dev included: that is the set npm states exactly. Its --omit dev
  // projection also drops production packages shared with dev dependencies (probed 2026-09-06).
  const sbom = execFileSync("npm", ["sbom", "--sbom-format", "spdx"], { encoding: "utf8", shell: true });
  await fs.writeFile(join(out, "sbom.spdx.json"), sbom, "utf8");
  sbomNote = `${(JSON.parse(sbom) as { packages: unknown[] }).packages.length} packages`;
}
const files = Object.values(manifest.trees).reduce((n, t) => n + t.length, 0);
console.log(`demo build ${(tDemo / 1000).toFixed(1)} s, reader build ${(tReader / 1000).toFixed(1)} s; ${files} files in ${Object.keys(manifest.trees).length} trees`);
console.log(`digest ${manifest.digest}`);
console.log(`written ${join(out, "release.json")}; sbom ${sbomNote}`);
