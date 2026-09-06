/**
 * Export the reference scene to a folder in the SPEC.md §10 layout, sealed.
 *
 *   npm run scene:export -- <folder> [size]
 *
 * The scene is the demo's carved cube: size^3 with a 3^3 corner removed,
 * seams and beads lit, a few passports set, all under a named wrangler.
 */
import { EDGE_SLOTS, FlatGrid, SceneSink, VERTEX_SLOTS } from "../src/index.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sealScene } from "../src/verify.ts";

const [dir, sizeArg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: export-scene <folder> [size=8]");
  process.exit(2);
}
const size = Number(sizeArg ?? 8);

const store = new NodeFsStore(dir);
const sink = new SceneSink(store);
const grid = new FlatGrid({ sink });

grid.wrangle({ actor: "export-scene", cause: "build the reference cube" }, () => {
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const b = grid.add([x, y, z], { emission: { color: 0x1f6feb, light: 0.6 } });
        b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
        b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
      }
});
grid.wrangle({ actor: "export-scene", cause: "carve the corner" }, () => {
  const from = size - 3;
  for (let z = from; z < size; z++)
    for (let y = from; y < size; y++) for (let x = from; x < size; x++) grid.remove(grid.at(x, y, z)!);
});
grid.wrangle({ actor: "export-scene", cause: "label a few bits" }, () => {
  grid.at(0, 0, 0)!.setPassport({ name: "origin", role: "anchor" });
  grid.at(size - 1, 0, 0)!.setPassport({ name: "x-end", tags: ["edge", "demo"] });
  grid.at(0, size - 1, 0)!.setPassport({ name: "y-end", nested: { depth: { of: { four: true } } } });
});

await sink.flush();
const sealed = await sealScene(store);
console.log(`scene ${grid.id}`);
console.log(`bits ${grid.size} present, ${sealed} folders, ${grid.eventCount} events`);
console.log(`written to ${dir}`);
