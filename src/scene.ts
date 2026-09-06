/**
 * Scene persistence: the two-file layout of SPEC.md §10 over any FileStore.
 *
 * SceneSink is an EventSink that appends every event to the bit's ledger,
 * then rewrites the bit's passport file from its own projection of the
 * ledger, then updates the manifest once per batch. openScene reads a
 * scene back into a Grid: from the full ledger when it is complete, or
 * from passports plus the ledger tail when it has been compacted.
 */

import type { Container, ContainerOptions } from "./container.ts";
import { type BitEvent, type EventSink, replay } from "./events.ts";
import { FlatGrid } from "./flat-grid.ts";
import { assertJsonSerializable, type JsonObject } from "./json.ts";
import { EDGE_SLOTS, NODE_COUNT, VERTEX_SLOTS } from "./slots.ts";
import type { FileStore } from "./store.ts";
import type { Emission, Vec3 } from "./vpb.ts";

export const SCENE_FORMAT = "vpb-scene/1";
export const PASSPORT_FORMAT = "vpb-passport/1";
/** The reference sink refuses passports larger than this, serialized (SPEC.md §9.5). */
export const PASSPORT_LIMIT_BYTES = 256 * 1024;

export interface Manifest {
  format: typeof SCENE_FORMAT;
  scene: string;
  created: number;
  updated: number;
  bits: number;
  seq: number;
  compacted?: boolean;
  /** Bit ids, for stores that cannot list a directory (SPEC.md §10.3). */
  ids?: string[];
  hashes?: Record<string, { passport: string; events: string }>;
  /** The seal signed by the container's key (SPEC.md §10.3, PLAN-3 Phase 11). */
  signature?: SceneSignature;
}

export interface SceneSignature {
  /** The container's did:web; its document carries the public key. */
  did: string;
  keyId: string;
  alg: "EdDSA";
  /** base64url Ed25519 signature over sealText(scene, ids, hashes). */
  value: string;
  /** When it was signed, ms since the epoch. Informational. */
  signed: number;
}

/** passport.json: the bit as it is now, at a sequence number (SPEC.md §10.4). */
export interface PassportFile {
  format: typeof PASSPORT_FORMAT;
  id: string;
  frame: string;
  seq: number;
  time: number;
  present: boolean;
  destroyed?: boolean;
  position: Vec3;
  color: number;
  emissions: Emission[];
  passport: JsonObject;
}

export const bitDir = (id: string) => `bits/${id}`;

/** Run `fn` over `items` with at most `limit` in flight. Stores with slow handles (OPFS) need this. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CONCURRENCY = 64;
export const passportPath = (id: string) => `${bitDir(id)}/passport.json`;
export const ledgerPath = (id: string) => `${bitDir(id)}/events.jsonl`;

/** Fold one event into a passport record. Pure; used by the sink and by import. */
export function applyToPassport(p: PassportFile | undefined, e: BitEvent): PassportFile {
  if (e.type === "created") {
    const emissions: Emission[] = Array.from({ length: NODE_COUNT }, () =>
      e.emission ? { ...e.emission } : {},
    );
    return {
      format: PASSPORT_FORMAT,
      id: e.bit,
      frame: e.frame,
      seq: e.seq,
      time: e.time,
      present: true,
      position: [...e.position] as unknown as Vec3,
      color: e.color,
      emissions,
      passport: {},
    };
  }
  if (!p) throw new Error(`event ${e.seq} for ${e.bit} before its created event`);
  const next: PassportFile = { ...p, seq: e.seq, time: e.time, frame: e.frame };
  switch (e.type) {
    case "presence":
      next.present = e.present;
      break;
    case "emitted":
      next.emissions = p.emissions.slice();
      next.emissions[e.slot] = { ...e.emission };
      break;
    case "moved":
      next.position = [...e.to] as unknown as Vec3;
      break;
    case "passport":
      next.passport = e.passport;
      break;
    case "destroyed":
      next.present = false;
      next.destroyed = true;
      break;
    case "annotated":
    case "linked":
    case "unlinked":
      break;
  }
  return next;
}

export interface SceneSinkOptions {
  now?: () => number;
  /** Serialized passport size limit. Default PASSPORT_LIMIT_BYTES. */
  passportLimit?: number;
}

/**
 * Writes SPEC.md §10 through a FileStore. record() is synchronous for the
 * model; writes are queued and applied in order. Await flush() before
 * reading the store.
 */
export class SceneSink implements EventSink {
  readonly store: FileStore;
  #passports = new Map<string, PassportFile>();
  #manifest: Manifest | undefined;
  #queue: BitEvent[] = [];
  #draining: Promise<void> = Promise.resolve();
  #now: () => number;
  #limit: number;
  #error: unknown;

  constructor(store: FileStore, opts: SceneSinkOptions = {}) {
    this.store = store;
    this.#now = opts.now ?? Date.now;
    this.#limit = opts.passportLimit ?? PASSPORT_LIMIT_BYTES;
  }

  /**
   * A sink that continues an existing scene: its projection is loaded from
   * the passports, with any ledger tail past each passport applied, and the
   * manifest is kept. Pair with openScene(store, { attach: sink }).
   */
  static async resume(store: FileStore, opts: SceneSinkOptions = {}): Promise<SceneSink> {
    const manifest = await readManifest(store);
    if (!manifest) throw new Error("no manifest.json: not a scene");
    const sink = new SceneSink(store, opts);
    sink.#manifest = { ...manifest };
    const ids = await store.list("bits");
    await mapLimit(ids, CONCURRENCY, async (id) => {
      const [l, p] = await Promise.all([store.read(ledgerPath(id)), store.read(passportPath(id))]);
      let record = p ? (JSON.parse(p) as PassportFile) : undefined;
      for (const e of parseLedger(l)) {
        if (!record || e.seq > record.seq) record = applyToPassport(record, e);
      }
      if (record) sink.#passports.set(id, record);
    });
    return sink;
  }

  /** The scene id this sink writes, once known. */
  get sceneId(): string | undefined {
    return this.#manifest?.scene;
  }

  record(event: BitEvent): void {
    if (event.type === "passport") {
      const bytes = new TextEncoder().encode(JSON.stringify(event.passport)).length;
      if (bytes > this.#limit) {
        throw new Error(`passport for ${event.bit} is ${bytes} bytes; limit is ${this.#limit}`);
      }
    }
    this.#queue.push(event);
    this.#draining = this.#draining
      .then(() => this.#drain())
      .catch((err) => {
        this.#error = err;
      });
  }

  /** Resolves when every recorded event has reached the store. Rethrows a store failure. */
  async flush(): Promise<void> {
    await this.#draining;
    if (this.#error) throw this.#error;
  }

  async #drain(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue;
    this.#queue = [];
    // 0. Project the whole batch first. A projection that fails (an event for
    //    a bit this sink has never seen) writes nothing at all.
    const next = new Map<string, PassportFile>();
    const lines = new Map<string, string[]>();
    let seq = this.#manifest?.seq ?? 0;
    for (const e of batch) {
      const current = next.get(e.bit) ?? this.#passports.get(e.bit);
      next.set(e.bit, applyToPassport(current, e));
      let arr = lines.get(e.bit);
      if (!arr) {
        arr = [];
        lines.set(e.bit, arr);
      }
      arr.push(JSON.stringify(e));
      seq = Math.max(seq, e.seq);
    }
    // 1. Ledger first: the truth. Lines are grouped per bit so a store with
    //    expensive operations (OPFS) sees one append per bit per batch.
    await mapLimit([...lines], CONCURRENCY, ([id, ls]) =>
      this.store.append(ledgerPath(id), `${ls.join("\n")}\n`),
    );
    // 2. Passports: a cache of the ledger, each rewritten atomically.
    for (const [id, p] of next) this.#passports.set(id, p);
    await mapLimit([...next.keys()], CONCURRENCY, (id) =>
      this.store.write(passportPath(id), `${JSON.stringify(this.#passports.get(id))}\n`),
    );
    // 3. Manifest, once per batch.
    if (!this.#manifest) {
      this.#manifest = {
        format: SCENE_FORMAT,
        scene: batch[0]!.frame,
        created: this.#now(),
        updated: this.#now(),
        bits: 0,
        seq: 0,
      };
    }
    const m = this.#manifest;
    m.seq = seq;
    m.updated = this.#now();
    m.bits = [...this.#passports.values()].filter((p) => !p.destroyed).length;
    m.ids = [...this.#passports.keys()].sort();
    // Any write invalidates a seal; sealScene sets hashes again at publish time.
    delete m.hashes;
    await this.store.write("manifest.json", `${JSON.stringify(m, null, 2)}\n`);
  }
}

/** Parse a ledger, discarding a truncated final line (SPEC.md §10.5). */
export function parseLedger(text: string | undefined): BitEvent[] {
  if (!text) return [];
  const lines = text.split("\n");
  const events: BitEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    try {
      events.push(JSON.parse(line) as BitEvent);
    } catch (err) {
      if (i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "")) {
        break; // a torn last line from a crash mid-write
      }
      throw err;
    }
  }
  return events;
}

export async function readManifest(store: FileStore): Promise<Manifest | undefined> {
  const text = await store.read("manifest.json");
  return text ? (JSON.parse(text) as Manifest) : undefined;
}

/**
 * Read a scene back into a Grid (SPEC.md §10.6, §10.9). A complete ledger
 * is replayed. A compacted scene is rebuilt from passports, then the ledger
 * tail past each passport's seq is applied.
 */
export interface OpenSceneOptions<C extends Container = FlatGrid> extends ContainerOptions {
  /**
   * A sink attached after the scene is rebuilt, so it sees only new events.
   * Use SceneSink.resume(store) to continue writing the same scene. The
   * grid's sequence continues from the manifest either way.
   */
  attach?: EventSink;
  /** Which container to rebuild into. Default: FlatGrid (ADR 0007). */
  factory?: (opts?: ContainerOptions) => C;
}

export async function openScene<C extends Container = FlatGrid>(
  store: FileStore,
  opts: OpenSceneOptions<C> = {},
): Promise<C> {
  const { attach, factory, ...gridOnly } = opts;
  const make = factory ?? ((o?: ContainerOptions) => new FlatGrid(o) as unknown as C);
  const grid = await rebuild(store, gridOnly, make);
  const manifest = (await readManifest(store))!;
  grid.resumeSeq(manifest.seq);
  if (attach) grid.attachSink(attach);
  return grid;
}

async function rebuild<C extends Container>(
  store: FileStore,
  opts: ContainerOptions,
  make: (opts?: ContainerOptions) => C,
): Promise<C> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  const ledgers = new Map<string, BitEvent[]>();
  const passports = new Map<string, PassportFile>();
  await mapLimit(ids, CONCURRENCY, async (id) => {
    const [l, p] = await Promise.all([store.read(ledgerPath(id)), store.read(passportPath(id))]);
    ledgers.set(id, parseLedger(l));
    if (p) passports.set(id, JSON.parse(p) as PassportFile);
  });
  const gridOpts: ContainerOptions = { ...opts, id: manifest.scene };

  if (!manifest.compacted) {
    const all: BitEvent[] = [];
    for (const evs of ledgers.values()) all.push(...evs);
    return replay(all, { ...gridOpts, factory: make });
  }

  // Compacted: passports are the base, then the tail beyond each passport's seq.
  const grid = make(gridOpts);
  const ordered = [...passports.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  grid.wrangle({ actor: "replay", cause: "open compacted scene" }, () => {
    for (const p of ordered) {
      if (p.destroyed) continue;
      const bit = grid.add(p.position, { id: p.id, color: p.color, present: true });
      p.emissions.forEach((em, slot) => {
        if (Object.keys(em).length) bit.emit(slot, em);
      });
      assertJsonSerializable(p.passport, "passport");
      if (Object.keys(p.passport).length) bit.setPassport(p.passport);
      if (!p.present) grid.setPresent(bit, false);
    }
  });
  const tail: BitEvent[] = [];
  for (const [id, evs] of ledgers) {
    const base = passports.get(id)?.seq ?? -1;
    for (const e of evs) if (e.seq > base) tail.push(e);
  }
  tail.sort((a, b) => a.seq - b.seq);
  for (const e of tail) {
    grid.wrangle({ actor: "replay", ...(e.cause !== undefined ? { cause: e.cause } : {}) }, () => {
      const bit = grid.get(e.bit);
      switch (e.type) {
        case "created":
          grid.add(e.position, { id: e.bit, color: e.color, emission: e.emission });
          break;
        case "presence":
          if (bit) grid.setPresent(bit, e.present);
          break;
        case "emitted":
          bit?.emit(e.slot, e.emission);
          break;
        case "moved":
          if (bit) grid.move(bit, e.to);
          break;
        case "annotated":
          bit?.annotate(e.key, e.value);
          break;
        case "passport":
          bit?.setPassport(e.passport);
          break;
        case "destroyed":
          if (bit) grid.remove(bit);
          break;
        case "linked":
        case "unlinked":
          break;
      }
    });
  }
  return grid;
}

// Kept exported for callers that build scenes by hand in tests.
export { EDGE_SLOTS, VERTEX_SLOTS };
