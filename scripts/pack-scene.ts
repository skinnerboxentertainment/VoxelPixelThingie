/**
 * Pack a scene folder into one JSON file (SPEC.md §10.8, packed variant).
 *
 *   npm run scene:pack -- <folder> <out.json>
 */
import { promises as fs } from "node:fs";
import { packScene, packToText } from "../src/pack.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { verifyScene } from "../src/verify.ts";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: pack-scene <folder> <out.json>");
  process.exit(2);
}
const store = new NodeFsStore(dir);
const v = await verifyScene(store);
if (!v.ok) {
  console.error(`refusing to pack an unverified scene: ${v.reason ?? `${v.mismatches.length} mismatches`}`);
  process.exit(1);
}
const pack = await packScene(store);
const text = packToText(pack);
await fs.writeFile(out, text, "utf8");
console.log(`scene ${pack.manifest.scene}`);
console.log(`${Object.keys(pack.bits).length} bits, ${(text.length / 1048576).toFixed(1)} MB`);
console.log(`written to ${out}`);
