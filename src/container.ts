/**
 * The container contract (PLAN-2.md Phase 7). Anything that claims to hold
 * VoxelPixelBits implements this, and the conformance suite in
 * tests/conformance holds it to the same behavior as the reference Grid.
 * Renderers and sinks depend on these interfaces, not on a class.
 */
import type { EventSink, WranglerContext } from "./events.ts";
import type { JsonObject } from "./json.ts";
import type { Slot } from "./slots.ts";
import type { Camera, Emission, Vec3 } from "./vpb.ts";

/** Everything a round trip must reproduce for one bit (SPEC.md §10.9), in a stable shape. */
export interface BitRecord {
  id: string;
  position: [number, number, number];
  present: boolean;
  color: number;
  passport: JsonObject;
  emissions: Emission[];
  /** Per slot, the touching nodes as "neighborId:slot", sorted. */
  links: string[][];
  renderCycle: boolean;
  renderEnabled: boolean[];
}

/** A bit as seen by renderers, sinks, and wranglers. */
export interface BitHandle {
  readonly id: string;
  readonly key: string;
  readonly position: Vec3;
  readonly present: boolean;
  readonly color: number;
  readonly passport: JsonObject;
  setPassport(passport: JsonObject): void;
  emit(slot: Slot, emission: Emission): void;
  emitAll(slots: Iterable<Slot>, emission: Emission): void;
  annotate(key: string, value: unknown): void;
  readonly renderCycle: boolean;
  /** Slots that passed the static tests; only these can render. */
  readonly open: readonly Slot[];
  emissionOf(slot: Slot): Emission;
  renderEnabledOf(slot: Slot): boolean;
  linkCountOf(slot: Slot): number;
  nodeCenter(slot: Slot): Vec3;
  record(): BitRecord;
}

export interface ContainerOptions {
  id?: string;
  mintId?: () => string;
  sink?: EventSink;
  now?: () => number;
}

export interface AddOptions {
  id?: string;
  present?: boolean;
  color?: number;
  emission?: Emission;
}

export interface Container {
  readonly id: string;
  readonly size: number;
  readonly eventCount: number;
  readonly awake: readonly BitHandle[];
  readonly wrangler: WranglerContext;
  add(position: Vec3, opts?: AddOptions): BitHandle;
  remove(target: BitHandle | Vec3): boolean;
  move(bit: BitHandle, to: Vec3): void;
  setPresent(bit: BitHandle, present: boolean): void;
  at(x: number, y: number, z: number): BitHandle | undefined;
  get(id: string): BitHandle | undefined;
  has(position: Vec3): boolean;
  bits(): Iterable<BitHandle>;
  evaluate(camera?: Camera): void;
  onCameraMoved(): void;
  cameraMoved(camera: Camera): void;
  wrangle<T>(context: WranglerContext, fn: () => T): T;
  attachSink(sink: EventSink): void;
  resumeSeq(seq: number): void;
  /** Records for every bit, sorted by id. Call after evaluate() for meaningful render fields. */
  snapshot(): BitRecord[];
}

export type ContainerFactory = (opts?: ContainerOptions) => Container;
