/**
 * OverlayStore: a read-mostly base under a writable top (PLAN-2.md Phase 8).
 * Reads fall through to the base when the top has no such file; writes go
 * to the top; the first append to a path copies the base text up so the
 * top holds the whole file. Listing is the union.
 *
 * The use: an autosaved scene is a packed base written once (one file
 * operation) plus a folder of only the bits changed since. openScene and
 * SceneSink see one ordinary scene.
 */
import type { FileStore } from "./store.ts";

export class OverlayStore implements FileStore {
  readonly base: FileStore;
  readonly top: FileStore;
  /** Paths known to exist in the top, so a read need not ask a slow top store. */
  #inTop: Set<string>;

  private constructor(base: FileStore, top: FileStore, inTop: Set<string>) {
    this.base = base;
    this.top = top;
    this.#inTop = inTop;
  }

  /** An overlay whose top is known to be empty; writes are tracked from here on. */
  static fresh(base: FileStore, top: FileStore): OverlayStore {
    return new OverlayStore(base, top, new Set());
  }

  /** Index what the top already holds (its manifest and its bit folders), then overlay. */
  static async open(base: FileStore, top: FileStore): Promise<OverlayStore> {
    const inTop = new Set<string>();
    if ((await top.read("manifest.json")) !== undefined) inTop.add("manifest.json");
    for (const id of await top.list("bits")) {
      for (const f of await top.list(`bits/${id}`)) inTop.add(`bits/${id}/${f}`);
    }
    return new OverlayStore(base, top, inTop);
  }

  async read(path: string): Promise<string | undefined> {
    if (this.#inTop.has(path)) return this.top.read(path);
    return this.base.read(path);
  }

  async write(path: string, text: string): Promise<void> {
    await this.top.write(path, text);
    this.#inTop.add(path);
  }

  async append(path: string, text: string): Promise<void> {
    if (this.#inTop.has(path)) {
      await this.top.append(path, text);
      return;
    }
    const below = (await this.base.read(path)) ?? "";
    await this.top.write(path, below + text);
    this.#inTop.add(path);
  }

  async list(dir: string): Promise<string[]> {
    const names = new Set<string>(await this.base.list(dir));
    const prefix = dir === "" || dir === "." ? "" : `${dir.replace(/\/$/, "")}/`;
    for (const p of this.#inTop) {
      if (!p.startsWith(prefix)) continue;
      const head = p.slice(prefix.length).split("/")[0];
      if (head) names.add(head);
    }
    return [...names].sort();
  }

  /** Paths written or copied up so far. */
  get topPaths(): readonly string[] {
    return [...this.#inTop].sort();
  }
}
