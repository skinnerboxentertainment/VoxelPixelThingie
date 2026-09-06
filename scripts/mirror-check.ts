/**
 * The spime test across stores (SPEC.md §10.9): open the same scene from a
 * local folder and from one or more URLs, verify each store's seal, and
 * compare digests. Exit 0 only if every store verifies and every digest is
 * equal.
 *
 *   npm run scene:check -- <folder> <url> [url...]
 */
import { promises as fs } from "node:fs";
import { openScene } from "../src/index.ts";
import { PackedStore } from "../src/pack.ts";
import { FetchStore } from "../src/store-fetch.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sceneDigest, verifyScene } from "../src/verify.ts";

const [dir, ...urls] = process.argv.slice(2);
if (!dir || urls.length === 0) {
  console.error("usage: mirror-check <folder|pack.json> <url|pack-url.json> [more...]");
  process.exit(2);
}

let failed = 0;
const digests: { name: string; digest: string }[] = [];

async function storeFor(target: string): Promise<NodeFsStore | FetchStore | PackedStore> {
  const isUrl = /^https?:\/\//.test(target);
  if (target.endsWith(".json")) {
    return isUrl
      ? PackedStore.fromUrl(target)
      : PackedStore.fromText(await fs.readFile(target, "utf8"));
  }
  return isUrl ? new FetchStore(target) : new NodeFsStore(target);
}

async function check(name: string, store: NodeFsStore | FetchStore | PackedStore): Promise<void> {
  const t0 = performance.now();
  const v = await verifyScene(store);
  const grid = await openScene(store);
  const digest = await sceneDigest(grid);
  const ms = (performance.now() - t0).toFixed(0);
  const okSeal = v.ok ? "sealed ok" : `seal FAILED (${v.reason ?? `${v.mismatches.length} mismatches`})`;
  console.log(`${name.padEnd(12)} bits ${grid.size}  ${okSeal}  digest ${digest.slice(0, 16)}…  ${ms} ms`);
  if (!v.ok) failed++;
  digests.push({ name, digest });
}

await check("local", await storeFor(dir));
for (const [i, url] of urls.entries()) await check(`url${i + 1}`, await storeFor(url));

const distinct = new Set(digests.map((d) => d.digest));
if (distinct.size !== 1) {
  failed++;
  console.log("digests DIFFER");
} else {
  console.log(`same bits on ${digests.length} stores: ${[...distinct][0]}`);
}
process.exit(failed ? 1 : 0);
