/**
 * Ask a scene's memory (PLAN-4.md Phase 20).
 *
 *   npm run scene:search -- <folder> [--bit id] [--type t] [--slot n] [--actor a]
 *        [--key k] [--text "words"] [--from ISO] [--to ISO] [--limit n] [--rebuild]
 *
 * Reads `index.json` beside the manifest when it matches the manifest's
 * seq, builds and writes it otherwise, and prints the hits with the time
 * the search took.
 */
import { buildIndex, INDEX_PATH, indexToText, loadOrBuildIndex, type MemoryQuery } from "../src/memory.ts";
import { NodeFsStore } from "../src/store-node.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const folder = args[0];
if (!folder || folder.startsWith("--")) {
  console.error(
    'usage: scene-search <folder> [--bit id] [--type t] [--slot n] [--actor a] [--key k] [--text "words"] [--from ISO] [--to ISO] [--limit n] [--rebuild]',
  );
  process.exit(2);
}
const store = new NodeFsStore(folder);
const t0 = performance.now();
let index: Awaited<ReturnType<typeof loadOrBuildIndex>>["index"];
let rebuilt: boolean;
if (args.includes("--rebuild")) {
  index = await buildIndex(store);
  await store.write(INDEX_PATH, indexToText(index));
  rebuilt = true;
} else ({ index, rebuilt } = await loadOrBuildIndex(store));
const loaded = performance.now() - t0;
const query: MemoryQuery = {};
if (flag("bit")) query.bit = flag("bit");
if (flag("type")) query.type = flag("type") as MemoryQuery["type"];
if (flag("slot")) query.slot = Number(flag("slot"));
if (flag("actor")) query.actor = flag("actor");
if (flag("key")) query.key = flag("key");
if (flag("text")) query.text = flag("text");
if (flag("from")) query.from = Date.parse(flag("from")!);
if (flag("to")) query.to = Date.parse(flag("to")!);
if (flag("limit")) query.limit = Number(flag("limit"));
const r = index.search(query);
console.log(
  `index ${rebuilt ? "built" : "loaded"} in ${loaded.toFixed(0)} ms: ${index.events} events at seq ${index.seq}; ${r.total} hit(s) in ${r.ms.toFixed(2)} ms`,
);
for (const h of r.hits)
  console.log(
    `${h.bit}  seq ${String(h.seq).padStart(6)}  ${new Date(h.time).toISOString()}  ${h.type.padEnd(9)}${h.slot !== undefined ? ` slot ${h.slot}` : ""}${h.key ? ` ${h.key}` : ""}${h.actor ? `  by ${h.actor}` : ""}${h.cause ? `  (${h.cause})` : ""}`,
  );
