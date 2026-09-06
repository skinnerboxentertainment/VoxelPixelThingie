/**
 * OpfsWorkerStore: a FileStore whose operations are messages to the worker
 * in opfs-worker.ts, which writes with synchronous access handles. Calls
 * are serialized in order, so a scene sink's ledger-first ordering per bit
 * is preserved end to end (PLAN-2.md Phase 8).
 *
 *   const worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });
 *   const store = new OpfsWorkerStore(worker, "vpb/scenes/autosave");
 */
import type { FileStore } from "./store.ts";

/** The subset of Worker this store needs, typed locally so no DOM lib is required. */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  terminate?(): void;
}

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export class OpfsWorkerStore implements FileStore {
  readonly root: string;
  #worker: WorkerLike;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(worker: WorkerLike, root: string) {
    this.#worker = worker;
    this.root = root.replace(/^\/+|\/+$/g, "");
    worker.addEventListener("message", (ev) => {
      const r = ev.data as Reply;
      const p = this.#pending.get(r.id);
      if (!p) return;
      this.#pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    });
  }

  #call(op: string, path?: string, text?: string): Promise<unknown> {
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        const id = this.#next++;
        this.#pending.set(id, { resolve, reject });
        this.#worker.postMessage({ id, op, root: this.root, path, text });
      });
    // Serialize so ordering matches the caller's, even across awaits.
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  read(path: string): Promise<string | undefined> {
    return this.#call("read", path) as Promise<string | undefined>;
  }

  async write(path: string, text: string): Promise<void> {
    await this.#call("write", path, text);
  }

  async append(path: string, text: string): Promise<void> {
    await this.#call("append", path, text);
  }

  list(dir: string): Promise<string[]> {
    return this.#call("list", dir) as Promise<string[]>;
  }

  /** Delete the scene root entirely. */
  remove(): Promise<boolean> {
    return this.#call("remove") as Promise<boolean>;
  }

  terminate(): void {
    this.#worker.terminate?.();
  }
}
