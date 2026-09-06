/**
 * The spime test across stores (SPEC.md §10.9): open the same scene from a
 * local folder and from one or more URLs, verify each store's seal, and
 * compare digests. Exit 0 only if every store verifies and every digest is
 * equal.
 *
 *   npm run scene:check -- <folder> <url> [url...] [--did-doc <file|url>]
 *
 * A signed scene's signature is checked by resolving its did:web over the
 * network, or from --did-doc when the document is not yet served. The
 * exit code covers hashes, digests, and a forged signature; an unresolved
 * signature is reported, not failed (PLAN-3.md Phase 11).
 */
import { promises as fs } from "node:fs";
import { openScene } from "../src/index.ts";
import { PackedStore } from "../src/pack.ts";
import { FetchStore } from "../src/store-fetch.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { resolveDidWeb } from "../src/did.ts";
import { sceneDigest, verifyScene } from "../src/verify.ts";

const argv = process.argv.slice(2);
const didDocIndex = argv.indexOf("--did-doc");
const didDocArg = didDocIndex >= 0 ? argv[didDocIndex + 1] : undefined;
const positional =
  didDocIndex < 0 ? argv : argv.filter((_a, i) => i !== didDocIndex && i !== didDocIndex + 1);
const [dir, ...urls] = positional;
if (!dir || urls.length === 0) {
  console.error("usage: mirror-check <folder|pack.json> <url|pack-url.json> [more...]");
  process.exit(2);
}

let failed = 0;
const digests: { name: string; digest: string }[] = [];
const resolve = async (did: string) => {
  if (!didDocArg) return resolveDidWeb(did);
  const text = /^https?:\/\//.test(didDocArg)
    ? await (await fetch(didDocArg)).text()
    : await fs.readFile(didDocArg, "utf8");
  return JSON.parse(text);
};

async function storeFor(raw: string): Promise<NodeFsStore | FetchStore | PackedStore> {
  // "pack:<target>" forces packed reading for URLs without a .json suffix (an IPFS CID).
  const forcedPack = raw.startsWith("pack:");
  const target = forcedPack ? raw.slice(5) : raw;
  const isUrl = /^https?:\/\//.test(target);
  if (forcedPack || target.endsWith(".json")) {
    return isUrl
      ? PackedStore.fromUrl(target)
      : PackedStore.fromText(await fs.readFile(target, "utf8"));
  }
  return isUrl ? new FetchStore(target) : new NodeFsStore(target);
}

async function check(name: string, store: NodeFsStore | FetchStore | PackedStore): Promise<void> {
  const t0 = performance.now();
  const v = await verifyScene(store, { resolve });
  let grid: Awaited<ReturnType<typeof openScene>>;
  try {
    grid = await openScene(store);
  } catch (err) {
    // A store whose files no longer parse still gets its seal report, then counts as failed.
    const okSeal = v.ok ? "sealed ok" : `seal FAILED (${v.reason ?? `${v.mismatches.length} mismatches`}${v.mismatches[0] ? `, first ${v.mismatches[0].id} ${v.mismatches[0].file}` : ""})`;
    console.log(`${name.padEnd(12)} ${okSeal}  signature ${v.signature}  cannot open: ${(err as Error).message.slice(0, 80)}`);
    failed++;
    return;
  }
  const digest = await sceneDigest(grid);
  const ms = (performance.now() - t0).toFixed(0);
  const okSeal = v.ok
    ? "sealed ok"
    : `seal FAILED (${v.reason ?? `${v.mismatches.length} mismatches${v.mismatches[0] ? `, first ${v.mismatches[0].id} ${v.mismatches[0].file}` : ""}`})`;
  console.log(
    `${name.padEnd(12)} bits ${grid.size}  ${okSeal}  signature ${v.signature}  digest ${digest.slice(0, 16)}…  ${ms} ms`,
  );
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
