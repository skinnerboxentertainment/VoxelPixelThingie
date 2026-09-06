/**
 * NodeFsStore: a FileStore over a folder on disk. Atomic replace is a write
 * to a sibling temp file followed by rename (SPEC.md §10.6).
 */
import { promises as fs } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { FileStore } from "./store.ts";

export class NodeFsStore implements FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  #abs(path: string): string {
    if (path.includes("..")) throw new Error(`refusing path with ..: ${path}`);
    return join(this.root, ...path.split("/"));
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.#abs(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(path: string, text: string): Promise<void> {
    const abs = this.#abs(path);
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, abs);
  }

  async append(path: string, text: string): Promise<void> {
    const abs = this.#abs(path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.appendFile(abs, text, "utf8");
  }

  async list(dir: string): Promise<string[]> {
    try {
      const names = await fs.readdir(this.#abs(dir));
      return names.filter((n) => !n.endsWith(".tmp")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Absolute path of a scene-relative path, for callers that shell out. */
  resolve(path: string): string {
    return this.#abs(path).split("/").join(sep);
  }
}
