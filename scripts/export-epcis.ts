/**
 * Write the EPCIS 2.0 document for a scene, from a folder or a pack.
 *
 *   npm run scene:epcis -- <folder|pack.json> <out.json>
 *
 * The document is validated against the vendored schema before it is
 * written; a scene whose export does not validate is refused.
 */
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { toEpcisDocument } from "../src/epcis.ts";
import type { BitEvent } from "../src/events.ts";
import { PackedStore } from "../src/pack.ts";
import { ledgerPath, parseLedger, readManifest } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: export-epcis <folder|pack.json> <out.json>");
  process.exit(2);
}

const store = src.endsWith(".json")
  ? PackedStore.fromText(await fs.readFile(src, "utf8"))
  : new NodeFsStore(src);
const manifest = await readManifest(store);
if (!manifest) {
  console.error("not a scene");
  process.exit(1);
}
const events: BitEvent[] = [];
for (const id of await store.list("bits")) events.push(...parseLedger(await store.read(ledgerPath(id))));

const doc = toEpcisDocument(events);
const require = createRequire(import.meta.url);
const AjvCtor = (require("ajv").default ?? require("ajv")) as new (opts: object) => {
  compile(schema: object): ((doc: unknown) => boolean) & {
    errors?: { instancePath: string; message?: string }[] | null;
  };
};
const addFormats = (require("ajv-formats").default ?? require("ajv-formats")) as (ajv: object) => void;
const schema = JSON.parse(readFileSync("vendor/epcis/epcis-json-schema.json", "utf8"));
const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(doc)) {
  console.error("document does not validate:");
  for (const err of validate.errors?.slice(0, 10) ?? []) console.error(` ${err.instancePath} ${err.message}`);
  process.exit(1);
}
const text = `${JSON.stringify(doc, null, 2)}\n`;
await fs.writeFile(out, text, "utf8");
const kinds = new Map<string, number>();
for (const e of doc.epcisBody.eventList) kinds.set(`${e.type}:${e.action}`, (kinds.get(`${e.type}:${e.action}`) ?? 0) + 1);
console.log(`scene ${manifest.scene}: ${doc.epcisBody.eventList.length} EPCIS events, validates`);
for (const [k, n] of [...kinds.entries()].sort()) console.log(`  ${k.padEnd(24)} ${n}`);
console.log(`written to ${out} (${(text.length / 1048576).toFixed(1)} MB)`);
