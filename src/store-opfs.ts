/**
 * OpfsStore: a FileStore over the browser's origin private file system
 * (SPEC.md §10.8). Same layout as a folder on disk, private to the origin,
 * no server. Typed locally so the model's typecheck needs no DOM lib; the
 * handles are the standard File System Access ones.
 */
import type { FileStore } from "./store.ts";

interface WritableLike {
  write(data: string | { type: "write"; position: number; data: string }): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  getFile(): Promise<{ text(): Promise<string>; size: number }>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<WritableLike>;
}
interface DirHandleLike {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

function isNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "NotFoundError";
}

export class OpfsStore implements FileStore {
  readonly root: DirHandleLike;
  /** Directory handles by path, so a scene's 2N files cost N directory lookups, not 2N. */
  #dirs = new Map<string, Promise<DirHandleLike>>();

  private constructor(root: DirHandleLike) {
    this.root = root;
  }

  #dirHandle(parts: string[], create: boolean): Promise<DirHandleLike> {
    const key = parts.join("/");
    if (key === "") return Promise.resolve(this.root);
    const cached = this.#dirs.get(key);
    if (cached) return cached;
    const parent = this.#dirHandle(parts.slice(0, -1), create);
    const p = parent.then((d) => d.getDirectoryHandle(parts[parts.length - 1]!, { create }));
    if (create) {
      this.#dirs.set(key, p);
      p.catch(() => this.#dirs.delete(key));
    }
    return p;
  }

  /** True when this browser exposes an origin private file system. */
  static available(): boolean {
    const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator;
    return typeof nav?.storage?.getDirectory === "function";
  }

  /** Open (creating if needed) a scene root at `path` under the origin's private root. */
  static async open(path: string, opts: { create?: boolean } = {}): Promise<OpfsStore> {
    const nav = (
      globalThis as unknown as {
        navigator: { storage: { getDirectory(): Promise<DirHandleLike> } };
      }
    ).navigator;
    let dir = await nav.storage.getDirectory();
    for (const part of path.split("/").filter(Boolean)) {
      dir = await dir.getDirectoryHandle(part, { create: opts.create ?? true });
    }
    return new OpfsStore(dir);
  }

  /** Remove a scene root entirely. Returns false when it did not exist. */
  static async remove(path: string): Promise<boolean> {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) return false;
    try {
      const parent = await OpfsStore.open(parts.join("/"), { create: false });
      await parent.root.removeEntry(name, { recursive: true });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async #dir(
    path: string,
    create: boolean,
  ): Promise<{ dir: DirHandleLike; name: string } | undefined> {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`bad path: ${path}`);
    try {
      return { dir: await this.#dirHandle(parts, create), name };
    } catch (err) {
      if (!create && isNotFound(err)) return undefined;
      throw err;
    }
  }

  async read(path: string): Promise<string | undefined> {
    const at = await this.#dir(path, false);
    if (!at) return undefined;
    try {
      const fh = await at.dir.getFileHandle(at.name);
      return await (await fh.getFile()).text();
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** createWritable stages the new content and swaps it in on close, so readers see old or new. */
  async write(path: string, text: string): Promise<void> {
    const at = (await this.#dir(path, true))!;
    const fh = await at.dir.getFileHandle(at.name, { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(text);
    await w.close();
  }

  async append(path: string, text: string): Promise<void> {
    const at = (await this.#dir(path, true))!;
    let fh: FileHandleLike;
    try {
      fh = await at.dir.getFileHandle(at.name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // New file: a plain write, no size read and no copy of existing data.
      fh = await at.dir.getFileHandle(at.name, { create: true });
      const w = await fh.createWritable({ keepExistingData: false });
      await w.write(text);
      await w.close();
      return;
    }
    const size = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData: true });
    await w.write({ type: "write", position: size, data: text });
    await w.close();
  }

  async list(dir: string): Promise<string[]> {
    let handle = this.root;
    try {
      for (const part of dir.split("/").filter(Boolean)) {
        handle = await handle.getDirectoryHandle(part, { create: false });
      }
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const names: string[] = [];
    for await (const k of handle.keys()) names.push(k);
    return names.sort();
  }
}
