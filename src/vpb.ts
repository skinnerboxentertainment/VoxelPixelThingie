/**
 * VoxelPixelBit (VPB): the atomic unit. SPEC.md §3, §4, §7, §8.
 *
 * A bit owns 26 private nodes. Adjacency is recorded as explicit links
 * between nodes of different bits. The bit self-tests its nodes and disables
 * its own rendering wherever it can prove nothing would reach the screen.
 */

import type { BitEventBody } from "./events.ts";
import {
  ALL_SLOTS,
  FACE_SLOTS,
  kindOf,
  linkOffsets,
  localCenterOf,
  NODE_COUNT,
  type NodeKind,
  negate,
  type Offset,
  outwardOf,
  partnerSlot,
  type Slot,
} from "./slots.ts";

export type Vec3 = readonly [number, number, number];

/**
 * What a node emits. Open question 2 in SPEC.md §9: this is the fixed-struct
 * option. A field left undefined means "not emitting that."
 */
export interface Emission {
  color?: number;
  light?: number;
  data?: unknown;
}

export function isSilent(e: Emission): boolean {
  return e.color === undefined && e.light === undefined && e.data === undefined;
}

/** A link from one node to the touching node on a neighbor. Stateless in v0.1 (§4.2). */
export interface NodeLink {
  readonly bit: VoxelPixelBit;
  readonly slot: Slot;
  /** Offset from the owning bit to `bit`. */
  readonly offset: Offset;
}

export interface VPBNode {
  readonly slot: Slot;
  readonly kind: NodeKind;
  emission: Emission;
  readonly links: NodeLink[];
  /** Result of the bit's last evaluate(). True until proven otherwise. */
  renderEnabled: boolean;
}

/**
 * The minimum a bit needs to know about the viewer. Optional methods default
 * to "pass" so a bare camera only enables the back-facing test.
 */
export interface Camera {
  readonly position: Vec3;
  /** Frustum test on the bit's unit bounding cube. Default: true. */
  containsBit?(bit: VoxelPixelBit): boolean;
  /** Whether the bit projects to at least one pixel. Default: true. */
  coversPixel?(bit: VoxelPixelBit): boolean;
}

export interface VPBOptions {
  present?: boolean;
  color?: number;
  /** Where mutations are reported. Set by the container; standalone bits report nowhere. */
  onEvent?: (body: BitEventBody) => void;
}

export class VoxelPixelBit {
  /** Immutable identity, minted by the container (SPEC.md §9.1, ADR 0005). */
  readonly id: string;
  position: [number, number, number];
  color: number;
  readonly nodes: readonly VPBNode[];

  /** Whether this bit takes part in rendering at all. Result of evaluate(). */
  renderCycle = true;

  #present: boolean;
  #onEvent: (body: BitEventBody) => void;
  #staticDirty = true; // state or links changed since last static pass
  #cameraDirty = true; // camera moved since last camera pass
  #enclosed = false;
  #staticPass: boolean[] = new Array(NODE_COUNT).fill(true);
  #facingPass: boolean[] = new Array(NODE_COUNT).fill(true);

  constructor(id: string, position: Vec3, opts: VPBOptions = {}) {
    if (!id) throw new RangeError("a bit needs an id; use a Grid to mint one");
    this.id = id;
    this.position = [position[0], position[1], position[2]];
    this.#present = opts.present ?? true;
    this.color = opts.color ?? 0xffffff;
    this.#onEvent = opts.onEvent ?? (() => {});
    this.nodes = ALL_SLOTS.map((slot) => ({
      slot,
      kind: kindOf(slot),
      emission: {},
      links: [],
      renderEnabled: true,
    }));
  }

  // ---------------------------------------------------------------- identity & state

  /** Grid-cell key. A property, not the identity (§9.1). */
  get key(): string {
    return VoxelPixelBit.keyOf(this.position);
  }

  static keyOf(p: Vec3): string {
    return `${p[0]},${p[1]},${p[2]}`;
  }

  /**
   * Change the grid cell. Links are the container's job: call this only
   * with no links attached, or through Grid.move which unlinks and relinks.
   */
  setPosition(to: Vec3): void {
    if (this.nodes.some((n) => n.links.length)) {
      throw new Error("unlink before moving; use Grid.move");
    }
    const from: Vec3 = [this.position[0], this.position[1], this.position[2]];
    this.position = [to[0], to[1], to[2]];
    this.onCameraMoved();
    this.#onEvent({ type: "moved", from, to: [to[0], to[1], to[2]] });
  }

  get present(): boolean {
    return this.#present;
  }

  setPresent(present: boolean): void {
    if (present === this.#present) return;
    this.#present = present;
    if (!present) this.unlinkAll();
    this.onStateChanged();
    this.#onEvent({ type: "presence", present });
  }

  /** Attach a free-form note to the bit's history. No effect on state. */
  annotate(key: string, value: unknown): void {
    this.#onEvent({ type: "annotated", key, value });
  }

  node(slot: Slot): VPBNode {
    const n = this.nodes[slot];
    if (!n) throw new RangeError(`slot out of range: ${slot}`);
    return n;
  }

  nodesOfKind(kind: NodeKind): VPBNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  /** Set what a node emits. Replaces the whole emission. */
  emit(slot: Slot, emission: Emission): void {
    this.node(slot).emission = { ...emission };
    this.onStateChanged();
    this.#onEvent({ type: "emitted", slot, emission: { ...emission } });
  }

  /** Set the same emission on a set of nodes (collective addressing, §5.1). */
  emitAll(slots: Iterable<Slot>, emission: Emission): void {
    for (const s of slots) {
      this.node(s).emission = { ...emission };
      this.#onEvent({ type: "emitted", slot: s, emission: { ...emission } });
    }
    this.onStateChanged();
  }

  // ---------------------------------------------------------------- links (§4.2, §7)

  /** Offset from `a` to `b` if they are grid neighbors, else null. */
  static offsetBetween(a: VoxelPixelBit, b: VoxelPixelBit): Offset | null {
    const d: [number, number, number] = [
      b.position[0] - a.position[0],
      b.position[1] - a.position[1],
      b.position[2] - a.position[2],
    ];
    if (d.every((c) => c === 0)) return null;
    if (d.some((c) => c < -1 || c > 1)) return null;
    return d;
  }

  isLinkedTo(other: VoxelPixelBit): boolean {
    return this.nodes.some((n) => n.links.some((l) => l.bit === other));
  }

  /**
   * Link every touching node pair between this bit and a neighbor, in both
   * directions. Returns the number of links created on this side, or 0 if
   * the bits are not adjacent, not both present, or already linked.
   */
  link(other: VoxelPixelBit): number {
    if (other === this || !this.#present || !other.#present) return 0;
    if (this.isLinkedTo(other)) return 0;
    const offset = VoxelPixelBit.offsetBetween(this, other);
    if (!offset) return 0;
    const back = negate(offset);
    let count = 0;
    for (const slot of ALL_SLOTS) {
      const partner = partnerSlot(slot, offset);
      if (partner === null) continue;
      this.nodes[slot]!.links.push({ bit: other, slot: partner, offset });
      other.nodes[partner]!.links.push({ bit: this, slot, offset: back });
      this.#onEvent({ type: "linked", neighbor: other.id, slot, partner, offset });
      other.#onEvent({
        type: "linked",
        neighbor: this.id,
        slot: partner,
        partner: slot,
        offset: back,
      });
      count++;
    }
    if (count) {
      this.onLinksChanged();
      other.onLinksChanged();
    }
    return count;
  }

  /** Remove every link between this bit and `other`, both sides. */
  unlink(other: VoxelPixelBit): void {
    let changed = false;
    for (const bit of [this, other]) {
      const target = bit === this ? other : this;
      for (const n of bit.nodes) {
        const before = n.links.length;
        for (let i = n.links.length - 1; i >= 0; i--) {
          if (n.links[i]!.bit === target) {
            n.links.splice(i, 1);
            bit.#onEvent({ type: "unlinked", neighbor: target.id, slot: n.slot });
          }
        }
        if (n.links.length !== before) changed = true;
      }
    }
    if (changed) {
      this.onLinksChanged();
      other.onLinksChanged();
    }
  }

  unlinkAll(): void {
    const neighbors = new Set<VoxelPixelBit>();
    for (const n of this.nodes) for (const l of n.links) neighbors.add(l.bit);
    for (const nb of neighbors) this.unlink(nb);
  }

  linkCount(slot: Slot): number {
    return this.node(slot).links.length;
  }

  /** Max links a node can hold: 1 face, 3 edge, 7 vertex. */
  static maxLinks(slot: Slot): number {
    return linkOffsets(slot).length;
  }

  /** All 6 faces linked: the bit is interior (§8.2, full enclosure). */
  get isEnclosed(): boolean {
    return FACE_SLOTS.every((f) => this.nodes[f]!.links.length > 0);
  }

  // ---------------------------------------------------------------- events (§8.3)

  onStateChanged(): void {
    this.#staticDirty = true;
  }

  onLinksChanged(): void {
    this.#staticDirty = true;
  }

  onCameraMoved(): void {
    this.#cameraDirty = true;
  }

  get needsEvaluation(): boolean {
    return this.#staticDirty || this.#cameraDirty;
  }

  // ---------------------------------------------------------------- geometry

  /** World-space center of a node, with the bit spanning position ± 0.5. */
  nodeCenter(slot: Slot): Vec3 {
    const c = localCenterOf(slot);
    return [this.position[0] + c[0], this.position[1] + c[1], this.position[2] + c[2]];
  }

  // ---------------------------------------------------------------- self-test (§8)

  /**
   * Run the bit's self-tests, cheapest first, honoring cached results.
   * Sets `renderCycle` and each node's `renderEnabled`. Pass no camera to run
   * only the camera-independent tests.
   */
  evaluate(camera?: Camera): void {
    if (this.#staticDirty) {
      this.#runStaticTests();
      this.#staticDirty = false;
      this.#cameraDirty = true; // exposure may have changed; camera results are stale
    }

    if (!this.#present) {
      this.#disableAll();
      return;
    }

    if (this.#enclosed) {
      // Interior bit. Leaves the render cycle and never runs a camera test.
      this.renderCycle = false;
      for (const n of this.nodes) n.renderEnabled = false;
      return;
    }

    if (camera && this.#cameraDirty) {
      this.#runCameraTests(camera);
      this.#cameraDirty = false;
    }

    let inView = true;
    if (camera) {
      inView = (camera.containsBit?.(this) ?? true) && (camera.coversPixel?.(this) ?? true);
    }
    this.renderCycle = inView;
    for (const n of this.nodes) {
      n.renderEnabled = inView && this.#staticPass[n.slot]! && this.#facingPass[n.slot]!;
    }
  }

  /** Presence, silence, occlusion by link, full enclosure. */
  #runStaticTests(): void {
    this.#enclosed = this.#present && this.isEnclosed;
    for (const n of this.nodes) {
      this.#staticPass[n.slot] = this.#present && !isSilent(n.emission) && n.links.length === 0;
    }
  }

  /** Back-facing test per node. Frustum and coverage are asked of the camera at evaluate time. */
  #runCameraTests(camera: Camera): void {
    for (const n of this.nodes) {
      if (!this.#staticPass[n.slot]) {
        this.#facingPass[n.slot] = false;
        continue;
      }
      const out = outwardOf(n.slot);
      const c = this.nodeCenter(n.slot);
      const toCam: Vec3 = [
        camera.position[0] - c[0],
        camera.position[1] - c[1],
        camera.position[2] - c[2],
      ];
      const dot = out[0] * toCam[0] + out[1] * toCam[1] + out[2] * toCam[2];
      this.#facingPass[n.slot] = dot > 0;
    }
  }

  #disableAll(): void {
    this.renderCycle = false;
    for (const n of this.nodes) n.renderEnabled = false;
  }
}
