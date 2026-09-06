/**
 * A scene back from glTF (PLAN-4.md Phase 23, ADR 0017).
 *
 *   npm run scene:gltf:import -- <in.glb|in.gltf> <out folder>
 *
 * With the carried pack, the folder is that scene, plus a `moved` event
 * for every node whose translation was changed in the file; without it,
 * a scene rebuilt from the nodes. Prints the digest either way.
 */
import { promises as fs } from "node:fs";
import { fromGltf, type GltfJson, parseGlb } from "../src/gltf.ts";
import { SceneSink } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sceneDigest } from "../src/verify.ts";

const [input, out] = process.argv.slice(2);
if (!input || !out) {
  console.error("usage: import-gltf <in.glb|in.gltf> <out folder>");
  process.exit(2);
}
const bytes = new Uint8Array(await fs.readFile(input));
const json = input.endsWith(".glb")
  ? parseGlb(bytes).json
  : (JSON.parse(new TextDecoder().decode(bytes)) as GltfJson);
const store = new NodeFsStore(out);
await fs.mkdir(out, { recursive: true });
const hasPack = Boolean((json.scenes[json.scene ?? 0]?.extras as { vpb?: { pack?: string } })?.vpb?.pack);
// A carried pack is unpacked, then its sink resumed so the moves land in the same ledgers.
const sink = hasPack ? undefined : new SceneSink(store);
const result = await fromGltf(json, { store, ...(sink ? { sink } : {}) });
if (hasPack && result.moved.length) {
  // Replay the moves through a resumed sink so they are appended to the unpacked ledgers.
  const resumed = await SceneSink.resume(store);
  const { openScene } = await import("../src/scene.ts");
  const grid = await openScene(store, { attach: resumed });
  for (const id of result.moved) {
    const to = result.grid.get(id)!.position;
    grid.wrangle({ actor: "gltf:import", cause: "moved in glTF" }, () => grid.move(grid.get(id)!, to));
  }
  await resumed.flush();
}
if (sink) await sink.flush();
const digest = await sceneDigest(result.grid);
console.log(`scene ${result.grid.id} from ${result.source}: ${result.grid.size} present bits, ${result.moved.length} moved`);
console.log(`digest ${digest}`);
console.log(`written to ${out}`);
