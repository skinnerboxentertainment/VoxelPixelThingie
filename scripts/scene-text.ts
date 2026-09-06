/**
 * A scene as words in a terminal (PLAN-4.md Phase 24): the same lines the
 * demos' text view reads aloud.
 *
 *   npm run scene:text -- <folder|pack.json> [--limit n]
 */
import { promises as fs } from "node:fs";
import { sceneTextLines } from "../demo/shared/text.ts";
import { PackedStore } from "../src/pack.ts";
import { openScene } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";

const args = process.argv.slice(2);
const source = args[0];
if (!source || source.startsWith("--")) {
  console.error("usage: scene-text <folder|pack.json> [--limit n]");
  process.exit(2);
}
const i = args.indexOf("--limit");
const limit = i >= 0 ? Number(args[i + 1]) : Number.POSITIVE_INFINITY;
const store = source.endsWith(".json")
  ? PackedStore.fromText(await fs.readFile(source, "utf8"))
  : new NodeFsStore(source);
const grid = await openScene(store);
const lines = sceneTextLines(grid);
for (const line of lines.slice(0, limit + 1)) console.log(line);
if (lines.length > limit + 1) console.log(`… ${lines.length - 1 - limit} more`);
