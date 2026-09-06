/**
 * Content storage on a folder: one file per content id (PLAN-3.md Phase 12).
 * Node only, like store-node.ts.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { contentId, isContentId, type Storage } from "./storage.ts";

export class FolderStorage implements Storage {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const cid = await contentId(bytes);
    await fs.mkdir(this.root, { recursive: true });
    const path = join(this.root, cid);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, bytes);
    }
    return cid;
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    if (!isContentId(cid)) return undefined;
    try {
      return new Uint8Array(await fs.readFile(join(this.root, cid)));
    } catch {
      return undefined;
    }
  }
}
