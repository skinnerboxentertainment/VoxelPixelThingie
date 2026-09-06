/**
 * Packed scene: the whole §10 layout in one JSON file, for stores that count
 * or charge per file (IPFS pinning free tiers, object stores) or that serve
 * only single objects. Every file's text is kept byte for byte, so a sealed
 * manifest verifies against a pack exactly as it does against a folder.
 * PackedStore serves a pack through the FileStore interface, read-only.
 */
import { ledgerPath, type Manifest, mapLimit, passportPath, readManifest } from "./scene.ts";
import type { FileStore } from "./store.ts";

export const PACK_FORMAT = "vpb-scene-pack/1";

export interface ScenePack {
  format: typeof PACK_FORMAT;
  manifest: Manifest;
  /** Raw file texts by bit id. */
  bits: Record<string, { passport?: string; events?: string }>;
}

/** Read a scene from any store into a pack. */
export async function packScene(store: FileStore): Promise<ScenePack> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  const bits: ScenePack["bits"] = {};
  await mapLimit(ids, 64, async (id) => {
    const [passport, events] = await Promise.all([
      store.read(passportPath(id)),
      store.read(ledgerPath(id)),
    ]);
    bits[id] = {
      ...(passport !== undefined ? { passport } : {}),
      ...(events !== undefined ? { events } : {}),
    };
  });
  const ordered = Object.fromEntries(Object.entries(bits).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { format: PACK_FORMAT, manifest, bits: ordered };
}

export function packToText(pack: ScenePack): string {
  return `${JSON.stringify(pack)}\n`;
}

export function packFromText(text: string): ScenePack {
  const pack = JSON.parse(text) as ScenePack;
  if (pack?.format !== PACK_FORMAT) throw new Error(`not a scene pack: ${String(pack?.format)}`);
  if (!pack.manifest || typeof pack.bits !== "object") throw new Error("malformed scene pack");
  return pack;
}

/** Unpack into a writable store, reproducing the folder layout. */
export async function unpackScene(pack: ScenePack, store: FileStore): Promise<number> {
  const ids = Object.keys(pack.bits);
  await mapLimit(ids, 64, async (id) => {
    const b = pack.bits[id]!;
    if (b.events !== undefined) await store.write(ledgerPath(id), b.events);
    if (b.passport !== undefined) await store.write(passportPath(id), b.passport);
  });
  await store.write("manifest.json", `${JSON.stringify(pack.manifest, null, 2)}\n`);
  return ids.length;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A read-only FileStore over a pack held in memory. */
export class PackedStore implements FileStore {
  readonly pack: ScenePack;

  constructor(pack: ScenePack) {
    this.pack = pack;
  }

  static fromText(text: string): PackedStore {
    return new PackedStore(packFromText(text));
  }

  /** Fetch a pack from a URL, for example an IPFS gateway path to the packed file. */
  static async fromUrl(url: string, fetchFn?: FetchLike): Promise<PackedStore> {
    const f = fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("no fetch available");
    const res = await f(url);
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    return PackedStore.fromText(await res.text());
  }

  async read(path: string): Promise<string | undefined> {
    if (path === "manifest.json") return `${JSON.stringify(this.pack.manifest, null, 2)}\n`;
    const m = /^bits\/([^/]+)\/(passport\.json|events\.jsonl)$/.exec(path);
    if (!m) return undefined;
    const bit = this.pack.bits[m[1]!];
    if (!bit) return undefined;
    return m[2] === "passport.json" ? bit.passport : bit.events;
  }

  async write(_path: string, _text: string): Promise<void> {
    throw new Error("PackedStore is read-only");
  }

  async append(_path: string, _text: string): Promise<void> {
    throw new Error("PackedStore is read-only");
  }

  async list(dir: string): Promise<string[]> {
    if (dir === "" || dir === ".") return ["bits", "manifest.json"];
    if (dir === "bits") return Object.keys(this.pack.bits).sort();
    return [];
  }
}
