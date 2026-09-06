/**
 * Grid: a container of VoxelPixelBits keyed by integer cell. SPEC.md §9.1.
 *
 * The Grid mints ids, links neighbors on insert, unlinks on removal, and
 * moves bits by unlinking, repositioning, and relinking. Bits never mint
 * their own ids and never manage their own adjacency.
 */

import {
  type BitEvent,
  type BitEventBody,
  type EventSink,
  NULL_SINK,
  type WranglerContext,
} from "./events.ts";
import { uuidv7 } from "./uuid.ts";
import { type Camera, type Emission, type Vec3, VoxelPixelBit, type VPBOptions } from "./vpb.ts";

export interface GridOptions {
  /** The container's own id. Default: a UUID v7. Replay passes the original. */
  id?: string;
  /** Id generator for bits. Default: UUID v7 (SPEC.md §9.1). Tests may inject a counter. */
  mintId?: () => string;
  /** Where stamped events go. Default discards. */
  sink?: EventSink;
  /** Clock for event timestamps. Default Date.now. */
  now?: () => number;
}

export interface GridAddOptions extends Omit<VPBOptions, "onEvent"> {
  /** Explicit id, used by replay. Must be unique within the grid. */
  id?: string;
  /** Emission applied to all 26 nodes on creation. */
  emission?: Emission;
}

const NEIGHBOR_OFFSETS: readonly Vec3[] = (() => {
  const out: Vec3[] = [];
  for (const dz of [-1, 0, 1])
    for (const dy of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) if (dx || dy || dz) out.push([dx, dy, dz]);
  return out;
})();

export class Grid {
  /** Immutable container identity; the `frame` on every event it stamps. */
  readonly id: string;
  #wrangler: WranglerContext = {};
  #byKey = new Map<string, VoxelPixelBit>();
  #byId = new Map<string, VoxelPixelBit>();
  #mintId: () => string;
  #sink: EventSink;
  #now: () => number;
  #seq = 0;
  /** Bits that can ever render: present and not enclosed. Camera moves visit only these. */
  #awake: VoxelPixelBit[] = [];
  #awakeDirty = true;

  constructor(opts: GridOptions = {}) {
    this.id = opts.id ?? uuidv7();
    this.#mintId = opts.mintId ?? uuidv7;
    this.#sink = opts.sink ?? NULL_SINK;
    this.#now = opts.now ?? Date.now;
  }

  /** Number of events stamped so far. */
  get eventCount(): number {
    return this.#seq;
  }

  /**
   * Replace where events go. Used after replay so a resumed scene sink
   * receives only new events, never the replayed ones (SPEC.md §10.6).
   */
  attachSink(sink: EventSink): void {
    this.#sink = sink;
  }

  /** Continue numbering from a stored scene: the next event gets max(current, seq) + 1. */
  resumeSeq(seq: number): void {
    this.#seq = Math.max(this.#seq, seq);
  }

  #stamp(bit: string, body: BitEventBody): void {
    const w = this.#wrangler;
    const event: BitEvent = {
      ...body,
      bit,
      seq: ++this.#seq,
      time: this.#now(),
      frame: this.id,
      ...(w.actor !== undefined ? { actor: w.actor } : {}),
      ...(w.cause !== undefined ? { cause: w.cause } : {}),
    };
    this.#sink.record(event);
  }

  /** The wrangler context in force, empty outside wrangle(). */
  get wrangler(): WranglerContext {
    return { ...this.#wrangler };
  }

  /**
   * Run `fn` with a wrangler context stamped onto every event it causes,
   * then restore the previous context, even if `fn` throws (SPEC.md §9.6).
   * Synchronous by design: an async `fn` would escape the context.
   */
  wrangle<T>(context: WranglerContext, fn: () => T): T {
    const previous = this.#wrangler;
    this.#wrangler = { ...context };
    try {
      return fn();
    } finally {
      this.#wrangler = previous;
    }
  }

  get size(): number {
    return this.#byKey.size;
  }

  at(x: number, y: number, z: number): VoxelPixelBit | undefined {
    return this.#byKey.get(VoxelPixelBit.keyOf([x, y, z]));
  }

  get(id: string): VoxelPixelBit | undefined {
    return this.#byId.get(id);
  }

  has(position: Vec3): boolean {
    return this.#byKey.has(VoxelPixelBit.keyOf(position));
  }

  bits(): IterableIterator<VoxelPixelBit> {
    return this.#byKey.values();
  }

  /** Create a bit at a free cell, mint its id, and link it to every present neighbor. */
  add(position: Vec3, opts: GridAddOptions = {}): VoxelPixelBit {
    const key = VoxelPixelBit.keyOf(position);
    if (this.#byKey.has(key)) throw new Error(`cell ${key} is occupied`);
    const id = opts.id ?? this.#mintId();
    if (this.#byId.has(id)) throw new Error(`id ${id} is already in this grid`);
    const bit = new VoxelPixelBit(id, position, {
      present: opts.present,
      color: opts.color,
      onEvent: (body) => this.#stamp(id, body),
    });
    if (opts.emission) {
      for (const n of bit.nodes) n.emission = { ...opts.emission };
      bit.onStateChanged();
    }
    this.#stamp(id, {
      type: "created",
      position: [position[0], position[1], position[2]],
      color: bit.color,
      ...(opts.emission ? { emission: { ...opts.emission } } : {}),
    });
    this.#byKey.set(key, bit);
    this.#byId.set(id, bit);
    this.#linkNeighbors(bit);
    this.#awakeDirty = true;
    return bit;
  }

  /** Toggle presence through the container so an absent bit relinks when it returns. */
  setPresent(bit: VoxelPixelBit, present: boolean): void {
    if (this.#byId.get(bit.id) !== bit) throw new Error(`bit ${bit.id} is not in this grid`);
    if (bit.present === present) return;
    bit.setPresent(present);
    if (present) this.#linkNeighbors(bit);
    this.#awakeDirty = true;
  }

  /** Unlink and drop a bit. Returns false if it was not in this grid. */
  remove(target: VoxelPixelBit | Vec3): boolean {
    const bit =
      target instanceof VoxelPixelBit ? target : this.#byKey.get(VoxelPixelBit.keyOf(target));
    if (!bit || this.#byId.get(bit.id) !== bit) return false;
    bit.unlinkAll();
    this.#byKey.delete(bit.key);
    this.#byId.delete(bit.id);
    this.#stamp(bit.id, { type: "destroyed" });
    this.#awakeDirty = true;
    return true;
  }

  /** Move a bit to a free cell, keeping its id, and relink it there. */
  move(bit: VoxelPixelBit, to: Vec3): void {
    if (this.#byId.get(bit.id) !== bit) throw new Error(`bit ${bit.id} is not in this grid`);
    const toKey = VoxelPixelBit.keyOf(to);
    if (toKey === bit.key) return;
    if (this.#byKey.has(toKey)) throw new Error(`cell ${toKey} is occupied`);
    bit.unlinkAll();
    this.#byKey.delete(bit.key);
    bit.setPosition(to);
    this.#byKey.set(toKey, bit);
    this.#linkNeighbors(bit);
    this.#awakeDirty = true;
  }

  #linkNeighbors(bit: VoxelPixelBit): void {
    const [x, y, z] = bit.position;
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      const nb = this.at(x + dx, y + dy, z + dz);
      if (nb) bit.link(nb);
    }
  }

  /** Run every bit's self-test, and refresh the awake set. */
  evaluate(camera?: Camera): void {
    this.#awake.length = 0;
    for (const b of this.#byKey.values()) {
      b.evaluate(camera);
      if (b.present && !b.enclosed) this.#awake.push(b);
    }
    this.#awakeDirty = false;
  }

  /** Bits that are present and not enclosed, as of the last evaluate(). */
  get awake(): readonly VoxelPixelBit[] {
    return this.#awake;
  }

  onCameraMoved(): void {
    for (const b of this.#byKey.values()) b.onCameraMoved();
  }

  /**
   * The camera moved and nothing else did: re-test only the awake bits.
   * Falls back to a full evaluate() if the structure changed since the
   * last one, because the awake set would be stale (SPEC.md §8.3).
   */
  cameraMoved(camera: Camera): void {
    if (this.#awakeDirty) {
      this.onCameraMoved();
      this.evaluate(camera);
      return;
    }
    for (const b of this.#awake) {
      b.onCameraMoved();
      b.evaluate(camera);
    }
  }

  /** Dense w×h×d block from the origin, every node emitting `emission` if given. */
  static fill(w: number, h: number, d: number, opts: GridAddOptions & GridOptions = {}): Grid {
    const g = new Grid(opts);
    for (let z = 0; z < d; z++)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.add([x, y, z], opts);
    return g;
  }
}
