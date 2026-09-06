/**
 * The file store a scene sink writes through (SPEC.md §10.8). Paths are
 * POSIX-style relative to the scene root. Implementations: MemoryStore
 * (tests), NodeFsStore (a folder), OpfsStore (the browser's origin private
 * file system), and read-only FetchStore (a URL prefix).
 */

export interface FileStore {
  /** File text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Replace the file atomically: readers see the old text or the new, never a mix. */
  write(path: string, text: string): Promise<void>;
  /** Append to the file, creating it if needed. */
  append(path: string, text: string): Promise<void>;
  /** Names of the immediate children of a directory, or [] when it does not exist. */
  list(dir: string): Promise<string[]>;
}

export class MemoryStore implements FileStore {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async append(path: string, text: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + text);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const head = rest.split("/")[0];
      if (head) names.add(head);
    }
    return [...names].sort();
  }
}
