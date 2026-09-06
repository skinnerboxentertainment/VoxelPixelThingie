/**
 * FetchStore: a read-only FileStore over a URL prefix (SPEC.md §10.8). A
 * scene mirrored to a static host, a raw git URL, or an IPFS gateway reads
 * through this. Directory listing comes from manifest.ids because a URL
 * cannot list a folder. Writes are refused.
 */
import type { Manifest } from "./scene.ts";
import type { FileStore } from "./store.ts";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class FetchStore implements FileStore {
  readonly base: string;
  #fetch: FetchLike;
  #manifest: Manifest | undefined;

  constructor(base: string, fetchFn?: FetchLike) {
    this.base = base.endsWith("/") ? base : `${base}/`;
    const f = fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("no fetch available");
    this.#fetch = f;
  }

  async read(path: string): Promise<string | undefined> {
    const res = await this.#fetch(this.base + path);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GET ${this.base}${path}: ${res.status}`);
    return res.text();
  }

  async write(_path: string, _text: string): Promise<void> {
    throw new Error("FetchStore is read-only");
  }

  async append(_path: string, _text: string): Promise<void> {
    throw new Error("FetchStore is read-only");
  }

  async list(dir: string): Promise<string[]> {
    if (dir === "" || dir === ".") return ["bits", "manifest.json"];
    if (dir !== "bits") throw new Error(`FetchStore can only list bits, not ${dir}`);
    if (!this.#manifest) {
      const text = await this.read("manifest.json");
      if (!text) return [];
      this.#manifest = JSON.parse(text) as Manifest;
    }
    const ids = this.#manifest.ids;
    if (!ids) throw new Error("manifest.json has no ids; this scene cannot be listed over a URL");
    return [...ids].sort();
  }
}
