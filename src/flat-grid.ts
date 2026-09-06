/**
 * FlatGrid: the container contract over typed arrays (PLAN-2.md Phase 7).
 *
 * Where Grid keeps 26 node objects per bit, FlatGrid keeps one row per bit
 * across a few typed arrays and packs every per-node boolean into a 26-bit
 * mask. Links are not stored at all: SPEC.md §7 says they are derivable
 * from positions on a grid, so a bit's "linked" mask is computed from
 * which of its 26 neighbor cells are occupied. No link events are emitted.
 * Handles are created on demand and cached; nothing per node is an object.
 */
import type { AddOptions, BitHandle, BitRecord, Container, ContainerOptions } from "./container.ts";
import {
  type BitEvent,
  type BitEventBody,
  type EventSink,
  NULL_SINK,
  type WranglerContext,
} from "./events.ts";
import { assertJsonSerializable, type JsonObject, jsonClone } from "./json.ts";
import {
  ALL_SLOTS,
  FACE_SLOTS,
  localCenterOf,
  NODE_COUNT,
  type Offset,
  outwardOf,
  partnerSlot,
  type Slot,
} from "./slots.ts";
import { uuidv7 } from "./uuid.ts";
import { type Camera, type Emission, FACING_EPSILON, type Vec3 } from "./vpb.ts";

const ALL = 0x3ffffff; // 26 ones
const FACE_MASK = FACE_SLOTS.reduce((m, s) => m | (1 << s), 0);

// Flags per bit.
const PRESENT = 1;
const DESTROYED = 2;
const STATIC_DIRTY = 4;
const CAMERA_DIRTY = 8;
const SETTLED = 16;
const ENCLOSED = 32;
const RENDER = 64;

// Emission flags per node.
const HAS_COLOR = 1;
const HAS_LIGHT = 2;
const HAS_DATA = 4;

/** The 26 neighbor offsets, and for each the slots that touch a neighbor there. */
const OFFSETS: Offset[] = [];
const OFFSET_MASK: number[] = [];
const PARTNER: Int8Array[] = [];
for (const dz of [-1, 0, 1])
  for (const dy of [-1, 0, 1])
    for (const dx of [-1, 0, 1]) {
      if (!dx && !dy && !dz) continue;
      const o: Offset = [dx, dy, dz];
      let mask = 0;
      const partner = new Int8Array(NODE_COUNT).fill(-1);
      for (const s of ALL_SLOTS) {
        const p = partnerSlot(s, o);
        if (p !== null) {
          mask |= 1 << s;
          partner[s] = p;
        }
      }
      OFFSETS.push(o);
      OFFSET_MASK.push(mask);
      PARTNER.push(partner);
    }

const OUT = new Float32Array(NODE_COUNT * 3);
const CENTER = new Float32Array(NODE_COUNT * 3);
for (const s of ALL_SLOTS) {
  const o = outwardOf(s);
  const c = localCenterOf(s);
  OUT[s * 3] = o[0];
  OUT[s * 3 + 1] = o[1];
  OUT[s * 3 + 2] = o[2];
  CENTER[s * 3] = c[0];
  CENTER[s * 3 + 1] = c[1];
  CENTER[s * 3 + 2] = c[2];
}

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class FlatGrid implements Container {
  readonly id: string;

  // ---- per bit
  #ids: string[] = [];
  #pos = new Int32Array(0);
  #flags = new Uint8Array(0);
  #color = new Uint32Array(0);
  #linked = new Uint32Array(0);
  #open = new Uint32Array(0);
  #facing = new Uint32Array(0);
  #enabled = new Uint32Array(0);
  // ---- per node
  #emColor = new Uint32Array(0);
  #emLight = new Float64Array(0); // 64-bit so a light of 0.6 reads back as 0.6
  #emFlags = new Uint8Array(0);
  #emData = new Map<number, unknown>();
  #passports = new Map<number, JsonObject>();
  // ---- indexes
  #cells = new Map<string, number>();
  #byId = new Map<string, number>();
  #handles: (FlatBit | undefined)[] = [];
  #openCache: (Slot[] | undefined)[] = [];
  #n = 0;
  #count = 0;
  #awake: number[] = [];
  #awakeHandles: BitHandle[] = [];
  #awakeDirty = true;
  // ---- events
  #mintId: () => string;
  #sink: EventSink;
  #now: () => number;
  #seq = 0;
  #wrangler: WranglerContext = {};

  constructor(opts: ContainerOptions = {}) {
    this.id = opts.id ?? uuidv7();
    this.#mintId = opts.mintId ?? uuidv7;
    this.#sink = opts.sink ?? NULL_SINK;
    this.#now = opts.now ?? Date.now;
    this.#grow(64);
  }

  // ---------------------------------------------------------------- storage

  #grow(min: number): void {
    const cap = this.#pos.length / 3;
    if (min <= cap) return;
    const next = Math.max(min, cap * 2);
    const g = <T extends { length: number }>(
      old: T,
      make: (n: number) => T,
      per: number,
      set: (dst: T, src: T) => void,
    ) => {
      const arr = make(next * per);
      set(arr, old);
      return arr;
    };
    const setTyped = <T extends Int32Array | Uint8Array | Uint32Array | Float64Array>(d: T, s: T) =>
      d.set(s as never);
    this.#pos = g(this.#pos, (n) => new Int32Array(n), 3, setTyped);
    this.#flags = g(this.#flags, (n) => new Uint8Array(n), 1, setTyped);
    this.#color = g(this.#color, (n) => new Uint32Array(n), 1, setTyped);
    this.#linked = g(this.#linked, (n) => new Uint32Array(n), 1, setTyped);
    this.#open = g(this.#open, (n) => new Uint32Array(n), 1, setTyped);
    this.#facing = g(this.#facing, (n) => new Uint32Array(n), 1, setTyped);
    this.#enabled = g(this.#enabled, (n) => new Uint32Array(n), 1, setTyped);
    this.#emColor = g(this.#emColor, (n) => new Uint32Array(n), NODE_COUNT, setTyped);
    this.#emLight = g(this.#emLight, (n) => new Float64Array(n), NODE_COUNT, setTyped);
    this.#emFlags = g(this.#emFlags, (n) => new Uint8Array(n), NODE_COUNT, setTyped);
  }

  get size(): number {
    return this.#count;
  }

  get eventCount(): number {
    return this.#seq;
  }

  /** Bytes of typed-array storage per allocated row, for the memory bench. */
  get bytesPerRow(): number {
    return 3 * 4 + 1 + 4 * 5 + NODE_COUNT * (4 + 8 + 1);
  }

  // ---------------------------------------------------------------- events

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

  get wrangler(): WranglerContext {
    return { ...this.#wrangler };
  }

  wrangle<T>(context: WranglerContext, fn: () => T): T {
    const previous = this.#wrangler;
    this.#wrangler = { ...context };
    try {
      return fn();
    } finally {
      this.#wrangler = previous;
    }
  }

  attachSink(sink: EventSink): void {
    this.#sink = sink;
  }

  resumeSeq(seq: number): void {
    this.#seq = Math.max(this.#seq, seq);
  }

  // ---------------------------------------------------------------- lookup

  #handle(i: number): FlatBit {
    let h = this.#handles[i];
    if (!h) {
      h = new FlatBit(this, i);
      this.#handles[i] = h;
    }
    return h;
  }

  #index(handle: BitHandle): number {
    const i = this.#byId.get(handle.id);
    if (i === undefined || this.#flags[i]! & DESTROYED) {
      throw new Error(`bit ${handle.id} is not in this grid`);
    }
    return i;
  }

  at(x: number, y: number, z: number): BitHandle | undefined {
    const i = this.#cells.get(keyOf(x, y, z));
    return i === undefined ? undefined : this.#handle(i);
  }

  get(id: string): BitHandle | undefined {
    const i = this.#byId.get(id);
    return i === undefined || this.#flags[i]! & DESTROYED ? undefined : this.#handle(i);
  }

  has(position: Vec3): boolean {
    return this.#cells.has(keyOf(position[0], position[1], position[2]));
  }

  *bits(): IterableIterator<BitHandle> {
    for (let i = 0; i < this.#n; i++) {
      if (!(this.#flags[i]! & DESTROYED)) yield this.#handle(i);
    }
  }

  get awake(): readonly BitHandle[] {
    return this.#awakeHandles;
  }

  // ---------------------------------------------------------------- structure

  #touchNeighbors(i: number): void {
    const x = this.#pos[i * 3]!;
    const y = this.#pos[i * 3 + 1]!;
    const z = this.#pos[i * 3 + 2]!;
    for (const [dx, dy, dz] of OFFSETS) {
      const j = this.#cells.get(keyOf(x + dx, y + dy, z + dz));
      if (j !== undefined) this.#flags[j]! |= STATIC_DIRTY;
    }
    this.#flags[i]! |= STATIC_DIRTY;
    this.#awakeDirty = true;
  }

  add(position: Vec3, opts: AddOptions = {}): BitHandle {
    const key = keyOf(position[0], position[1], position[2]);
    if (this.#cells.has(key)) throw new Error(`cell ${key} is occupied`);
    const id = opts.id ?? this.#mintId();
    if (this.#byId.has(id)) throw new Error(`id ${id} is already in this grid`);
    const i = this.#n++;
    this.#grow(this.#n);
    this.#ids[i] = id;
    this.#pos[i * 3] = position[0];
    this.#pos[i * 3 + 1] = position[1];
    this.#pos[i * 3 + 2] = position[2];
    this.#flags[i] = (opts.present === false ? 0 : PRESENT) | STATIC_DIRTY | CAMERA_DIRTY;
    this.#color[i] = opts.color ?? 0xffffff;
    this.#linked[i] = 0;
    this.#open[i] = 0;
    this.#facing[i] = ALL;
    this.#enabled[i] = 0;
    if (opts.emission) {
      for (const s of ALL_SLOTS) this.#setEmission(i, s, opts.emission);
    }
    this.#cells.set(key, i);
    this.#byId.set(id, i);
    this.#count++;
    this.#stamp(id, {
      type: "created",
      position: [position[0], position[1], position[2]],
      color: this.#color[i]!,
      ...(opts.emission ? { emission: { ...opts.emission } } : {}),
    });
    this.#touchNeighbors(i);
    return this.#handle(i);
  }

  remove(target: BitHandle | Vec3): boolean {
    let i: number | undefined;
    if ("id" in target) {
      i = this.#byId.get(target.id);
    } else {
      i = this.#cells.get(keyOf(target[0], target[1], target[2]));
    }
    if (i === undefined || this.#flags[i]! & DESTROYED) return false;
    this.#touchNeighbors(i);
    this.#cells.delete(keyOf(this.#pos[i * 3]!, this.#pos[i * 3 + 1]!, this.#pos[i * 3 + 2]!));
    this.#flags[i] = (this.#flags[i]! & ~PRESENT & ~RENDER) | DESTROYED;
    this.#enabled[i] = 0;
    this.#count--;
    this.#stamp(this.#ids[i]!, { type: "destroyed" });
    return true;
  }

  setPresent(handle: BitHandle, present: boolean): void {
    const i = this.#index(handle);
    const was = (this.#flags[i]! & PRESENT) !== 0;
    if (was === present) return;
    this.#stamp(this.#ids[i]!, { type: "presence", present });
    if (present) this.#flags[i]! |= PRESENT;
    else this.#flags[i]! &= ~PRESENT;
    this.#touchNeighbors(i);
  }

  move(handle: BitHandle, to: Vec3): void {
    const i = this.#index(handle);
    const toKey = keyOf(to[0], to[1], to[2]);
    const fromKey = keyOf(this.#pos[i * 3]!, this.#pos[i * 3 + 1]!, this.#pos[i * 3 + 2]!);
    if (toKey === fromKey) return;
    if (this.#cells.has(toKey)) throw new Error(`cell ${toKey} is occupied`);
    const from: [number, number, number] = [
      this.#pos[i * 3]!,
      this.#pos[i * 3 + 1]!,
      this.#pos[i * 3 + 2]!,
    ];
    this.#stamp(this.#ids[i]!, { type: "moved", from, to: [to[0], to[1], to[2]] });
    this.#touchNeighbors(i);
    this.#cells.delete(fromKey);
    this.#pos[i * 3] = to[0];
    this.#pos[i * 3 + 1] = to[1];
    this.#pos[i * 3 + 2] = to[2];
    this.#cells.set(toKey, i);
    this.#touchNeighbors(i);
    this.#flags[i]! |= CAMERA_DIRTY;
  }

  // ---------------------------------------------------------------- per-bit accessors (used by FlatBit)

  /** @internal */
  _id(i: number): string {
    return this.#ids[i]!;
  }
  /** @internal */
  _pos(i: number): [number, number, number] {
    return [this.#pos[i * 3]!, this.#pos[i * 3 + 1]!, this.#pos[i * 3 + 2]!];
  }
  /** @internal */
  _present(i: number): boolean {
    return (this.#flags[i]! & PRESENT) !== 0;
  }
  /** @internal */
  _color(i: number): number {
    return this.#color[i]!;
  }
  /** @internal */
  _renderCycle(i: number): boolean {
    return (this.#flags[i]! & RENDER) !== 0;
  }
  /** @internal */
  _open(i: number): Slot[] {
    let list = this.#openCache[i];
    if (!list) {
      list = [];
      const m = this.#open[i]!;
      for (let s = 0; s < NODE_COUNT; s++) if (m & (1 << s)) list.push(s);
      this.#openCache[i] = list;
    }
    return list;
  }
  /** @internal */
  _enabled(i: number, s: Slot): boolean {
    return (this.#enabled[i]! & (1 << s)) !== 0;
  }
  /** @internal */
  _emission(i: number, s: Slot): Emission {
    const k = i * NODE_COUNT + s;
    const f = this.#emFlags[k]!;
    const e: Emission = {};
    if (f & HAS_COLOR) e.color = this.#emColor[k]!;
    if (f & HAS_LIGHT) e.light = this.#emLight[k]!;
    if (f & HAS_DATA) e.data = this.#emData.get(k);
    return e;
  }
  #setEmission(i: number, s: Slot, e: Emission): void {
    const k = i * NODE_COUNT + s;
    let f = 0;
    if (e.color !== undefined) {
      f |= HAS_COLOR;
      this.#emColor[k] = e.color;
    }
    if (e.light !== undefined) {
      f |= HAS_LIGHT;
      this.#emLight[k] = e.light;
    }
    if (e.data !== undefined) {
      f |= HAS_DATA;
      this.#emData.set(k, e.data);
    } else {
      this.#emData.delete(k);
    }
    this.#emFlags[k] = f;
  }
  /** @internal */
  _emit(i: number, s: Slot, e: Emission, event = true): void {
    if (s < 0 || s >= NODE_COUNT) throw new RangeError(`slot out of range: ${s}`);
    // Report, then apply: a sink that refuses the event leaves the bit unchanged (§9.8).
    if (event) this.#stamp(this.#ids[i]!, { type: "emitted", slot: s, emission: { ...e } });
    this.#setEmission(i, s, e);
    this.#flags[i]! |= STATIC_DIRTY;
    this.#awakeDirty = true;
  }
  /** @internal */
  _annotate(i: number, key: string, value: unknown): void {
    this.#stamp(this.#ids[i]!, { type: "annotated", key, value });
  }
  /** @internal */
  _passport(i: number): JsonObject {
    return jsonClone(this.#passports.get(i) ?? {});
  }
  /** @internal */
  _setPassport(i: number, passport: JsonObject): void {
    if (passport === null || typeof passport !== "object" || Array.isArray(passport)) {
      throw new TypeError("a passport is a plain JSON object");
    }
    assertJsonSerializable(passport, "passport");
    const copy = jsonClone(passport);
    this.#stamp(this.#ids[i]!, { type: "passport", passport: copy });
    this.#passports.set(i, copy);
  }
  /** @internal */
  _linkCount(i: number, s: Slot): number {
    if (!(this.#flags[i]! & PRESENT)) return 0;
    let n = 0;
    const x = this.#pos[i * 3]!;
    const y = this.#pos[i * 3 + 1]!;
    const z = this.#pos[i * 3 + 2]!;
    for (let o = 0; o < OFFSETS.length; o++) {
      if (!(OFFSET_MASK[o]! & (1 << s))) continue;
      const [dx, dy, dz] = OFFSETS[o]!;
      const j = this.#cells.get(keyOf(x + dx, y + dy, z + dz));
      if (j !== undefined && this.#flags[j]! & PRESENT) n++;
    }
    return n;
  }
  /** @internal */
  _record(i: number): BitRecord {
    const links: string[][] = ALL_SLOTS.map(() => []);
    if (this.#flags[i]! & PRESENT) {
      const x = this.#pos[i * 3]!;
      const y = this.#pos[i * 3 + 1]!;
      const z = this.#pos[i * 3 + 2]!;
      for (let o = 0; o < OFFSETS.length; o++) {
        const [dx, dy, dz] = OFFSETS[o]!;
        const j = this.#cells.get(keyOf(x + dx, y + dy, z + dz));
        if (j === undefined || !(this.#flags[j]! & PRESENT)) continue;
        const m = OFFSET_MASK[o]!;
        const partner = PARTNER[o]!;
        for (let s = 0; s < NODE_COUNT; s++) {
          if (m & (1 << s)) links[s]!.push(`${this.#ids[j]}:${partner[s]}`);
        }
      }
      for (const l of links) l.sort();
    }
    return {
      id: this.#ids[i]!,
      position: this._pos(i),
      present: this._present(i),
      color: this.#color[i]!,
      passport: this._passport(i),
      emissions: ALL_SLOTS.map((s) => this._emission(i, s)),
      links,
      renderCycle: this._renderCycle(i),
      renderEnabled: ALL_SLOTS.map((s) => this._enabled(i, s)),
    };
  }

  snapshot(): BitRecord[] {
    const out: BitRecord[] = [];
    for (let i = 0; i < this.#n; i++) {
      if (!(this.#flags[i]! & DESTROYED)) out.push(this._record(i));
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Dense w×h×d block from the origin, every node emitting `emission` if given. */
  static fill(w: number, h: number, d: number, opts: AddOptions & ContainerOptions = {}): FlatGrid {
    const g = new FlatGrid(opts);
    for (let z = 0; z < d; z++)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.add([x, y, z], opts);
    return g;
  }

  // ---------------------------------------------------------------- self-test (SPEC.md §8)

  #staticPass(i: number): void {
    const present = (this.#flags[i]! & PRESENT) !== 0;
    let linked = 0;
    let emitting = 0;
    if (present) {
      const x = this.#pos[i * 3]!;
      const y = this.#pos[i * 3 + 1]!;
      const z = this.#pos[i * 3 + 2]!;
      for (let o = 0; o < OFFSETS.length; o++) {
        const [dx, dy, dz] = OFFSETS[o]!;
        const j = this.#cells.get(keyOf(x + dx, y + dy, z + dz));
        if (j !== undefined && this.#flags[j]! & PRESENT) linked |= OFFSET_MASK[o]!;
      }
      const base = i * NODE_COUNT;
      for (let s = 0; s < NODE_COUNT; s++) if (this.#emFlags[base + s]) emitting |= 1 << s;
    }
    this.#linked[i] = linked;
    const enclosed = present && (linked & FACE_MASK) === FACE_MASK;
    this.#open[i] = present ? ~linked & emitting & ALL : 0;
    this.#openCache[i] = undefined;
    this.#facing[i] = ALL;
    this.#enabled[i] = 0;
    let f = this.#flags[i]! & ~STATIC_DIRTY & ~SETTLED & ~ENCLOSED;
    if (enclosed) f |= ENCLOSED;
    f |= CAMERA_DIRTY;
    this.#flags[i] = f;
  }

  #cameraPass(i: number, camera: Camera): void {
    const open = this.#open[i]!;
    let facing = 0;
    const ortho = camera.towardCamera;
    const px = this.#pos[i * 3]!;
    const py = this.#pos[i * 3 + 1]!;
    const pz = this.#pos[i * 3 + 2]!;
    for (let s = 0; s < NODE_COUNT; s++) {
      if (!(open & (1 << s))) continue;
      const ox = OUT[s * 3]!;
      const oy = OUT[s * 3 + 1]!;
      const oz = OUT[s * 3 + 2]!;
      let tx: number;
      let ty: number;
      let tz: number;
      if (ortho) {
        tx = ortho[0];
        ty = ortho[1];
        tz = ortho[2];
      } else {
        tx = camera.position[0] - (px + CENTER[s * 3]!);
        ty = camera.position[1] - (py + CENTER[s * 3 + 1]!);
        tz = camera.position[2] - (pz + CENTER[s * 3 + 2]!);
      }
      const dot = ox * tx + oy * ty + oz * tz;
      const len = Math.hypot(ox, oy, oz) * Math.hypot(tx, ty, tz);
      const cos = len === 0 ? 1 : dot / len;
      if (ortho ? cos > FACING_EPSILON : cos > -FACING_EPSILON) facing |= 1 << s;
    }
    this.#facing[i] = facing;
  }

  #evaluateOne(i: number, camera?: Camera): void {
    let f = this.#flags[i]!;
    if (f & STATIC_DIRTY) {
      this.#staticPass(i);
      f = this.#flags[i]!;
    }
    if (!(f & PRESENT) || f & ENCLOSED) {
      if (f & SETTLED) return;
      this.#enabled[i] = 0;
      this.#flags[i] = (f & ~RENDER) | SETTLED;
      return;
    }
    if (camera && f & CAMERA_DIRTY) {
      this.#cameraPass(i, camera);
      f &= ~CAMERA_DIRTY;
    }
    let inView = true;
    if (camera) {
      const h = this.#handle(i);
      inView = (camera.containsBit?.(h) ?? true) && (camera.coversPixel?.(h) ?? true);
    }
    this.#enabled[i] = inView ? this.#open[i]! & this.#facing[i]! : 0;
    this.#flags[i] = inView ? f | RENDER : f & ~RENDER;
  }

  evaluate(camera?: Camera): void {
    this.#awake.length = 0;
    for (let i = 0; i < this.#n; i++) {
      if (this.#flags[i]! & DESTROYED) continue;
      this.#evaluateOne(i, camera);
      const f = this.#flags[i]!;
      if (f & PRESENT && !(f & ENCLOSED)) this.#awake.push(i);
    }
    this.#awakeHandles = this.#awake.map((i) => this.#handle(i));
    this.#awakeDirty = false;
  }

  onCameraMoved(): void {
    for (let i = 0; i < this.#n; i++) this.#flags[i]! |= CAMERA_DIRTY;
  }

  cameraMoved(camera: Camera): void {
    if (this.#awakeDirty) {
      this.onCameraMoved();
      this.evaluate(camera);
      return;
    }
    for (const i of this.#awake) {
      this.#flags[i]! |= CAMERA_DIRTY;
      this.#evaluateOne(i, camera);
    }
  }
}

/** A view of one row of a FlatGrid. Created on demand, cached by index. */
class FlatBit implements BitHandle {
  #g: FlatGrid;
  #i: number;

  constructor(g: FlatGrid, i: number) {
    this.#g = g;
    this.#i = i;
  }

  get id(): string {
    return this.#g._id(this.#i);
  }
  get key(): string {
    const p = this.#g._pos(this.#i);
    return keyOf(p[0], p[1], p[2]);
  }
  get position(): Vec3 {
    return this.#g._pos(this.#i);
  }
  get present(): boolean {
    return this.#g._present(this.#i);
  }
  get color(): number {
    return this.#g._color(this.#i);
  }
  get passport(): JsonObject {
    return this.#g._passport(this.#i);
  }
  setPassport(passport: JsonObject): void {
    this.#g._setPassport(this.#i, passport);
  }
  emit(slot: Slot, emission: Emission): void {
    this.#g._emit(this.#i, slot, emission);
  }
  emitAll(slots: Iterable<Slot>, emission: Emission): void {
    for (const s of slots) this.#g._emit(this.#i, s, emission);
  }
  annotate(key: string, value: unknown): void {
    this.#g._annotate(this.#i, key, value);
  }
  get renderCycle(): boolean {
    return this.#g._renderCycle(this.#i);
  }
  get open(): readonly Slot[] {
    return this.#g._open(this.#i);
  }
  emissionOf(slot: Slot): Emission {
    return this.#g._emission(this.#i, slot);
  }
  renderEnabledOf(slot: Slot): boolean {
    return this.#g._enabled(this.#i, slot);
  }
  linkCountOf(slot: Slot): number {
    return this.#g._linkCount(this.#i, slot);
  }
  nodeCenter(slot: Slot): Vec3 {
    const p = this.#g._pos(this.#i);
    return [p[0] + CENTER[slot * 3]!, p[1] + CENTER[slot * 3 + 1]!, p[2] + CENTER[slot * 3 + 2]!];
  }
  record(): BitRecord {
    return this.#g._record(this.#i);
  }
}
