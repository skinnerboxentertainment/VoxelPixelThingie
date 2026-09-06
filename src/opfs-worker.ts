/**
 * Dedicated worker that owns a scene folder in the origin private file
 * system and writes it with FileSystemSyncAccessHandle: synchronous,
 * exclusive per file, and free of the per-call checks that make
 * main-thread handles slow (PLAN-2.md Phase 8). One request at a time per
 * store keeps ledger-first ordering per bit; the store on the main thread
 * serializes calls.
 *
 * Message in:  { id, op, root, path?, text? }
 * Message out: { id, ok: true, result } | { id, ok: false, error }
 */

interface SyncHandle {
  getSize(): number;
  read(buffer: Uint8Array, opts?: { at?: number }): number;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface FileHandleLike {
  createSyncAccessHandle(): Promise<SyncHandle>;
}
interface DirHandleLike {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

type Request = {
  id: number;
  op: "read" | "write" | "append" | "list" | "remove";
  root: string;
  path?: string;
  text?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dirs = new Map<string, Promise<DirHandleLike>>();

const isNotFound = (err: unknown) => (err as { name?: string })?.name === "NotFoundError";

async function opfsRoot(): Promise<DirHandleLike> {
  const nav = (
    globalThis as unknown as { navigator: { storage: { getDirectory(): Promise<DirHandleLike> } } }
  ).navigator;
  return nav.storage.getDirectory();
}

function dirAt(parts: string[], create: boolean): Promise<DirHandleLike> {
  const key = `${create ? "c:" : "r:"}${parts.join("/")}`;
  if (parts.length === 0) return opfsRoot();
  const cached = dirs.get(key);
  if (cached) return cached;
  const p = dirAt(parts.slice(0, -1), create).then((d) =>
    d.getDirectoryHandle(parts[parts.length - 1]!, { create }),
  );
  if (create) {
    dirs.set(key, p);
    p.catch(() => dirs.delete(key));
  }
  return p;
}

function split(root: string, path: string): { parts: string[]; name: string } {
  const all = [...root.split("/"), ...path.split("/")].filter(Boolean);
  const name = all.pop();
  if (!name) throw new Error(`bad path: ${path}`);
  return { parts: all, name };
}

async function withHandle<T>(
  root: string,
  path: string,
  create: boolean,
  fn: (h: SyncHandle) => T,
): Promise<T | undefined> {
  const { parts, name } = split(root, path);
  let dir: DirHandleLike;
  try {
    dir = await dirAt(parts, create);
  } catch (err) {
    if (!create && isNotFound(err)) return undefined;
    throw err;
  }
  let fh: FileHandleLike;
  try {
    fh = await dir.getFileHandle(name, { create });
  } catch (err) {
    if (!create && isNotFound(err)) return undefined;
    throw err;
  }
  const h = await fh.createSyncAccessHandle();
  try {
    return fn(h);
  } finally {
    h.close();
  }
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case "read":
      return withHandle(req.root, req.path!, false, (h) => {
        const size = h.getSize();
        const buf = new Uint8Array(size);
        h.read(buf, { at: 0 });
        return decoder.decode(buf);
      });
    case "write":
      await withHandle(req.root, req.path!, true, (h) => {
        const bytes = encoder.encode(req.text ?? "");
        h.truncate(0);
        h.write(bytes, { at: 0 });
        h.flush();
      });
      return undefined;
    case "append":
      await withHandle(req.root, req.path!, true, (h) => {
        const bytes = encoder.encode(req.text ?? "");
        h.write(bytes, { at: h.getSize() });
        h.flush();
      });
      return undefined;
    case "list": {
      const parts = [...req.root.split("/"), ...(req.path ?? "").split("/")].filter(Boolean);
      let dir: DirHandleLike;
      try {
        dir = await dirAt(parts, false);
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
      const names: string[] = [];
      for await (const k of dir.keys()) names.push(k);
      return names.sort();
    }
    case "remove": {
      const parts = req.root.split("/").filter(Boolean);
      const name = parts.pop();
      if (!name) return false;
      try {
        const parent = await dirAt(parts, false);
        await parent.removeEntry(name, { recursive: true });
        dirs.clear();
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    }
  }
}

const scope = globalThis as unknown as {
  onmessage: (ev: { data: Request }) => void;
  postMessage(msg: unknown): void;
};
// postMessage must be called on the scope: a detached reference throws "Illegal invocation".
scope.onmessage = async (ev) => {
  const req = ev.data;
  try {
    scope.postMessage({ id: req.id, ok: true, result: await handle(req) });
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
