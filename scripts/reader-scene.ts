/**
 * A scene that carries its own reader (PLAN-4.md Phase 17, ADR 0012): one
 * HTML file holding the reader page, the packed scene, the SPEC text, and
 * the container's DID document.
 *
 *   npm run scene:reader -- <folder|pack.json|builtin> <out.html>
 *        [--spec SPEC.md] [--did-doc did.json] [--template <built page>]
 *        [--tamper]
 *
 * `builtin` builds the reference scene, signs it with a fresh key under a
 * throwaway DID, and embeds that key's document: the oracle's input, with
 * no network. `--tamper` changes one byte of one ledger after packing, so
 * the reader must name the bit and fail. The built page comes from
 * `vite.reader.config.ts`; it is built here when missing.
 */
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { referenceScene } from "../demo/shared/scene.ts";
import { buildDidDocument, type DidDocument, frameDid } from "../src/did.ts";
import { generateKeyPair, publicOf } from "../src/keys.ts";
import { PACK_FORMAT, packScene, PackedStore, type ScenePack } from "../src/pack.ts";
import { openScene, readManifest, SceneSink } from "../src/scene.ts";
import { MemoryStore } from "../src/store.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sceneDigest, sealScene } from "../src/verify.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = join(root, "dist-reader", "reader", "index.html");

/** JSON that is safe inside a <script> element: no `<` survives. */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

export interface EmbedInput {
  pack: ScenePack;
  spec?: string;
  didDoc?: DidDocument;
  /** Embed the pack as plain JSON instead of gzip + base64. Default false: ledgers compress about tenfold. */
  plain?: boolean;
}

/**
 * The built page with the scene, the SPEC, and the DID document injected
 * before the reader runs. The pack goes in gzipped and base64-encoded
 * (`vpb-pack-gz`), which the page inflates with the browser's own
 * DecompressionStream; `plain` embeds it as JSON (`vpb-pack`) instead.
 */
export function embedReader(template: string, input: EmbedInput): string {
  const packText = `${JSON.stringify(input.pack)}
`;
  const blocks = [
    input.plain
      ? `<script type="application/json" id="vpb-pack">${scriptJson(input.pack)}</script>`
      : `<script type="text/plain" id="vpb-pack-gz">${gzipSync(packText, { level: 9 }).toString("base64")}</script>`,
  ];
  if (input.spec !== undefined)
    blocks.push(
      `<script type="application/json" id="vpb-spec">${scriptJson({ text: input.spec })}</script>`,
    );
  if (input.didDoc)
    blocks.push(`<script type="application/json" id="vpb-did">${scriptJson(input.didDoc)}</script>`);
  const injected = blocks.join("\n");
  if (template.includes("<!--vpb:embed-->")) return template.replace("<!--vpb:embed-->", injected);
  const head = template.indexOf("</head>");
  if (head < 0) throw new Error("template has no </head>");
  return `${template.slice(0, head)}${injected}\n${template.slice(head)}`;
}

/** Change one digit of one ledger so the seal no longer matches; returns the bit. */
export function tamper(pack: ScenePack): string {
  const id = Object.keys(pack.bits).sort()[0];
  if (!id) throw new Error("no bits to tamper with");
  const events = pack.bits[id]!.events ?? "";
  const m = /"time":(\d)/.exec(events);
  if (!m) throw new Error("no time field to change");
  const digit = String((Number(m[1]) + 1) % 10);
  pack.bits[id]!.events = `${events.slice(0, m.index + 7)}${digit}${events.slice(m.index + 8)}`;
  return id;
}

export async function builtinSigned(): Promise<{ pack: ScenePack; didDoc: DidDocument }> {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  referenceScene(8, sink);
  await sink.flush();
  const manifest = (await readManifest(mem))!;
  const { privateKey } = await generateKeyPair();
  const did = frameDid("reader.example.invalid", "", manifest.scene);
  await sealScene(mem, { did, privateKey });
  const didDoc = await buildDidDocument(did, publicOf(privateKey));
  return { pack: await packScene(mem), didDoc };
}

async function ensureTemplate(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    if (path !== TEMPLATE) throw new Error(`no template at ${path}`);
    const { build } = await import("vite");
    await build({ configFile: join(root, "vite.reader.config.ts") });
    return fs.readFile(path, "utf8");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const has = (n: string) => args.includes(`--${n}`);
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const [source, out] = positional;
  if (!source || !out) {
    console.error(
      "usage: reader-scene <folder|pack.json|builtin> <out.html> [--spec SPEC.md] [--did-doc did.json] [--template page.html] [--tamper]",
    );
    process.exit(2);
  }
  const template = await ensureTemplate(flag("template") ?? TEMPLATE);
  let pack: ScenePack;
  let didDoc: DidDocument | undefined;
  if (source === "builtin") {
    ({ pack, didDoc } = await builtinSigned());
  } else if (source.endsWith(".json")) {
    pack = PackedStore.fromText(await fs.readFile(source, "utf8")).pack;
  } else {
    pack = await packScene(new NodeFsStore(source));
    try {
      didDoc = JSON.parse(await fs.readFile(join(source, "did.json"), "utf8")) as DidDocument;
    } catch {
      didDoc = undefined;
    }
  }
  if (pack.format !== PACK_FORMAT) throw new Error(`not a scene pack: ${pack.format}`);
  const didDocArg = flag("did-doc");
  if (didDocArg) didDoc = JSON.parse(await fs.readFile(didDocArg, "utf8")) as DidDocument;
  const spec = await fs.readFile(flag("spec") ?? join(root, "SPEC.md"), "utf8");
  const digest = await sceneDigest(await openScene(new PackedStore(pack)));
  let tampered: string | undefined;
  if (has("tamper")) tampered = tamper(pack);
  const html = embedReader(template, { pack, spec, ...(didDoc ? { didDoc } : {}) });
  await fs.writeFile(out, html, "utf8");
  console.log(`scene ${pack.manifest.scene}`);
  console.log(`digest ${digest}`);
  console.log(
    `${Object.keys(pack.bits).length} bits, ${(html.length / 1048576).toFixed(2)} MB, did document ${didDoc ? "embedded" : "absent"}${tampered ? `, tampered bit ${tampered}` : ""}`,
  );
  console.log(`written to ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
