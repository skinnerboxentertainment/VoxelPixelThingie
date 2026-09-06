/**
 * Scene persistence: the two-file layout of SPEC.md §10 over any FileStore.
 *
 * SceneSink is an EventSink that appends every event to the bit's ledger,
 * then rewrites the bit's passport file from its own projection of the
 * ledger, then updates the manifest once per batch. openScene reads a
 * scene back into a Grid: from the full ledger when it is complete, or
 * from passports plus the ledger tail when it has been compacted.
 */
import { type BitEvent, type EventSink, replay } from "./events.ts";
import { Grid, type GridOptions } from "./grid.ts";
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
  hashes?: Record<string, { passport: string; events: string }>;
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
    const touched = new Set<string>();
    for (const e of batch) {
      // 1. Ledger first: the truth.
      await this.store.append(ledgerPath(e.bit), `${JSON.stringify(e)}\n`);
      // 2. Passport: a cache of the ledger, rewritten atomically.
      const next = applyToPassport(this.#passports.get(e.bit), e);
      this.#passports.set(e.bit, next);
      touched.add(e.bit);
      if (!this.#manifest) {
        this.#manifest = {
          format: SCENE_FORMAT,
          scene: e.frame,
          created: this.#now(),
          updated: this.#now(),
          bits: 0,
          seq: 0,
        };
      }
      this.#manifest.seq = Math.max(this.#manifest.seq, e.seq);
    }
    for (const id of touched) {
      await this.store.write(passportPath(id), `${JSON.stringify(this.#passports.get(id))}\n`);
    }
    // 3. Manifest, once per batch.
    const m = this.#manifest!;
    m.updated = this.#now();
    m.bits = [...this.#passports.values()].filter((p) => !p.destroyed).length;
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
export async function openScene(store: FileStore, opts: GridOptions = {}): Promise<Grid> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  const ledgers = new Map<string, BitEvent[]>();
  const passports = new Map<string, PassportFile>();
  for (const id of ids) {
    ledgers.set(id, parseLedger(await store.read(ledgerPath(id))));
    const p = await store.read(passportPath(id));
    if (p) passports.set(id, JSON.parse(p) as PassportFile);
  }
  const gridOpts: GridOptions = { ...opts, id: manifest.scene };

  if (!manifest.compacted) {
    const all: BitEvent[] = [];
    for (const evs of ledgers.values()) all.push(...evs);
    return replay(all, gridOpts);
  }

  // Compacted: passports are the base, then the tail beyond each passport's seq.
  const grid = new Grid(gridOpts);
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
