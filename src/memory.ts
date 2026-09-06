/**
 * Searchable memory (PLAN-4.md Phase 20): an index over a scene's ledgers
 * that answers "when did anyone touch slot 1" in one call. Built from the
 * ledgers alone, rebuilt to the same bytes, written beside the manifest
 * as `index.json` with the manifest `seq` it was built at, so a stale
 * index is detected and rebuilt. No dependency.
 *
 * Structured fields (bit, type, slot, actor, key, time) filter by scan;
 * text (cause, annotation values, passport strings) goes through an
 * inverted index of tokens. A query composes both. Vectors are a
 * declared slot with no reference shipped: they need a model, which is a
 * dependency this phase does not take.
 */
import type { BitEvent } from "./events.ts";
import { ledgerPath, parseLedger, readManifest } from "./scene.ts";
import type { FileStore } from "./store.ts";

export const INDEX_FORMAT = "vpb-memory-index/1";
export const INDEX_PATH = "index.json";

/** One indexed event, the fields a hit reports. */
export interface Entry {
  bit: string;
  seq: number;
  time: number;
  type: BitEvent["type"];
  actor?: string;
  slot?: number;
  key?: string;
  cause?: string;
}

export interface MemoryQuery {
  bit?: string;
  type?: BitEvent["type"];
  slot?: number;
  actor?: string;
  /** Annotation key, exact. */
  key?: string;
  /** Every token must appear in the event's cause, annotation value, or passport text. */
  text?: string;
  /** Inclusive bounds on the event time, ms since the epoch. */
  from?: number;
  to?: number;
  /** Default 100. */
  limit?: number;
}

export interface SearchResult {
  total: number;
  hits: Entry[];
  ms: number;
}

/** The slot a future embedding backend fills. None is shipped. */
export interface Vectors {
  embed(text: string): Promise<number[]>;
}

export interface IndexFile {
  format: typeof INDEX_FORMAT;
  scene: string;
  /** The manifest seq the index was built at. */
  seq: number;
  events: number;
  entries: Entry[];
  /** token → indices into entries, ascending. */
  postings: Record<string, number[]>;
}

/** Lowercase words and numbers of two or more characters. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function textOf(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) textOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      textOf(v, out);
    }
}

/** The tokens an event contributes: its cause, its annotation value, its passport. */
export function tokensOf(event: BitEvent): string[] {
  const texts: string[] = [];
  if (event.cause !== undefined) texts.push(event.cause);
  if (event.type === "annotated") {
    texts.push(event.key);
    textOf(event.value, texts);
  }
  if (event.type === "passport") textOf(event.passport, texts);
  const seen = new Set<string>();
  for (const t of texts) for (const tok of tokenize(t)) seen.add(tok);
  return [...seen].sort();
}

export function entryOf(event: BitEvent): Entry {
  return {
    bit: event.bit,
    seq: event.seq,
    time: event.time,
    type: event.type,
    ...(event.actor !== undefined ? { actor: event.actor } : {}),
    ...("slot" in event ? { slot: event.slot } : {}),
    ...(event.type === "annotated" ? { key: event.key } : {}),
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
  };
}

export class MemoryIndex {
  readonly scene: string;
  seq: number;
  readonly entries: Entry[] = [];
  readonly #postings = new Map<string, number[]>();
  readonly #seen = new Set<string>();

  constructor(scene: string, seq = 0) {
    this.scene = scene;
    this.seq = seq;
  }

  get events(): number {
    return this.entries.length;
  }

  /** Index one event. Events arrive in any order; search sorts. A (bit, seq) seen before is ignored. */
  add(event: BitEvent): void {
    const id = `${event.bit}:${event.seq}`;
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    const at = this.entries.length;
    this.entries.push(entryOf(event));
    for (const tok of tokensOf(event)) {
      let list = this.#postings.get(tok);
      if (!list) {
        list = [];
        this.#postings.set(tok, list);
      }
      list.push(at);
    }
    if (event.seq > this.seq) this.seq = event.seq;
  }

  search(q: MemoryQuery = {}): SearchResult {
    const t0 = performance.now();
    let candidates: Iterable<number>;
    if (q.text) {
      const toks = tokenize(q.text);
      if (toks.length === 0) candidates = this.entries.keys();
      else {
        let set: Set<number> | undefined;
        for (const tok of toks) {
          const list = this.#postings.get(tok) ?? [];
          set = set ? new Set(list.filter((i) => set!.has(i))) : new Set(list);
          if (set.size === 0) break;
        }
        candidates = set ?? new Set();
      }
    } else candidates = this.entries.keys();
    const out: Entry[] = [];
    for (const i of candidates) {
      const e = this.entries[i]!;
      if (q.bit !== undefined && e.bit !== q.bit) continue;
      if (q.type !== undefined && e.type !== q.type) continue;
      if (q.slot !== undefined && e.slot !== q.slot) continue;
      if (q.actor !== undefined && e.actor !== q.actor) continue;
      if (q.key !== undefined && e.key !== q.key) continue;
      if (q.from !== undefined && e.time < q.from) continue;
      if (q.to !== undefined && e.time > q.to) continue;
      out.push(e);
    }
    out.sort((a, b) => (a.bit < b.bit ? -1 : a.bit > b.bit ? 1 : a.seq - b.seq));
    const limit = q.limit ?? 100;
    return { total: out.length, hits: out.slice(0, limit), ms: performance.now() - t0 };
  }

  /** A stable file: entries by bit then seq, postings by token. */
  toFile(): IndexFile {
    const order = this.entries
      .map((e, i) => i)
      .sort((a, b) => {
        const x = this.entries[a]!;
        const y = this.entries[b]!;
        return x.bit < y.bit ? -1 : x.bit > y.bit ? 1 : x.seq - y.seq;
      });
    const remap = new Map(order.map((old, fresh) => [old, fresh]));
    const postings: Record<string, number[]> = {};
    for (const tok of [...this.#postings.keys()].sort())
      postings[tok] = this.#postings
        .get(tok)!
        .map((i) => remap.get(i)!)
        .sort((a, b) => a - b);
    return {
      format: INDEX_FORMAT,
      scene: this.scene,
      seq: this.seq,
      events: this.entries.length,
      entries: order.map((i) => this.entries[i]!),
      postings,
    };
  }

  static fromFile(file: IndexFile): MemoryIndex {
    if (file.format !== INDEX_FORMAT) throw new Error(`not a memory index: ${String(file.format)}`);
    const index = new MemoryIndex(file.scene, file.seq);
    index.entries.push(...file.entries);
    for (const e of file.entries) index.#seen.add(`${e.bit}:${e.seq}`);
    for (const [tok, list] of Object.entries(file.postings)) index.#postings.set(tok, [...list]);
    return index;
  }
}

export const indexToText = (index: MemoryIndex): string => `${JSON.stringify(index.toFile())}\n`;
export const indexFromText = (text: string): MemoryIndex =>
  MemoryIndex.fromFile(JSON.parse(text) as IndexFile);

/** Build from every ledger in the store. Same store, same bytes. */
export async function buildIndex(store: FileStore): Promise<MemoryIndex> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const index = new MemoryIndex(manifest.scene, manifest.seq);
  const ids = manifest.ids ?? (await store.list("bits"));
  for (const id of [...ids].sort())
    for (const e of parseLedger(await store.read(ledgerPath(id)))) index.add(e);
  // A ledger can be one step ahead of the manifest (ledger first, §10.6); the index is at the later of the two.
  index.seq = Math.max(index.seq, manifest.seq);
  return index;
}

export interface LoadOptions {
  /** Write a rebuilt index back to the store. Default true. */
  write?: boolean;
}

/**
 * The store's index.json when it matches the manifest's scene and seq;
 * otherwise a fresh build, written back unless told not to.
 */
export async function loadOrBuildIndex(
  store: FileStore,
  opts: LoadOptions = {},
): Promise<{ index: MemoryIndex; rebuilt: boolean }> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const text = await store.read(INDEX_PATH);
  if (text) {
    try {
      const index = indexFromText(text);
      if (index.scene === manifest.scene && index.seq >= manifest.seq)
        return { index, rebuilt: false };
    } catch {
      // unreadable: rebuild
    }
  }
  const index = await buildIndex(store);
  if (opts.write ?? true) await store.write(INDEX_PATH, indexToText(index));
  return { index, rebuilt: true };
}
