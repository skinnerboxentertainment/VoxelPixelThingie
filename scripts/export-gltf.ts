/**
 * A scene as glTF (PLAN-4.md Phase 23, ADR 0017).
 *
 *   npm run scene:gltf -- <folder|pack.json> <out.glb|out.gltf> [--no-ledgers] [--size 1]
 *
 * A `.glb` packs geometry and JSON in one file; a `.gltf` writes JSON with
 * the buffer beside it as `<name>.bin`. By default the whole packed scene
 * rides in the scene's extras so an import gives the scene back with its
 * history; `--no-ledgers` carries state only.
 */
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { toGlb, toGltf } from "../src/gltf.ts";
import { PackedStore } from "../src/pack.ts";
import { openScene } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const [source, out] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!source || !out) {
  console.error("usage: export-gltf <folder|pack.json> <out.glb|out.gltf> [--no-ledgers] [--size n]");
  process.exit(2);
}
const store = source.endsWith(".json")
  ? PackedStore.fromText(await fs.readFile(source, "utf8"))
  : new NodeFsStore(source);
const grid = await openScene(store);
const t0 = performance.now();
const { json, bin } = await toGltf(grid, {
  store,
  ledgers: !args.includes("--no-ledgers"),
  ...(flag("size") ? { size: Number(flag("size")) } : {}),
});
if (out.endsWith(".glb")) {
  await fs.writeFile(out, toGlb(json, bin));
} else {
  const binName = `${basename(out).replace(/\.gltf$/, "")}.bin`;
  json.buffers[0]!.uri = binName;
  await fs.writeFile(out, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await fs.writeFile(out.replace(/[^/\\]+$/, binName), bin);
}
const size = (await fs.stat(out)).size;
console.log(
  `${json.nodes.length} nodes, ${json.materials.length} material(s), ledgers ${args.includes("--no-ledgers") ? "not carried" : "carried"}; ${(size / 1048576).toFixed(2)} MB in ${(performance.now() - t0).toFixed(0)} ms`,
);
console.log(`written to ${out}`);
