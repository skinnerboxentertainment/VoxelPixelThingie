/**
 * The seam between the model and every renderer. Walks nodes that survived
 * the self-test and hands back what a renderer needs and nothing else.
 */

import { type NodeKind, outwardOf, type Slot } from "./slots.ts";
import type { Emission, Vec3, VoxelPixelBit } from "./vpb.ts";

export interface RenderItem {
  readonly bit: VoxelPixelBit;
  readonly slot: Slot;
  readonly kind: NodeKind;
  readonly emission: Emission;
  /** World-space center of the node. */
  readonly center: Vec3;
  /** Outward direction of the node, unnormalized, in bit units. */
  readonly outward: Vec3;
}

/** Call after evaluate(). Bits outside the render cycle contribute nothing. */
export function renderList(bits: Iterable<VoxelPixelBit>): RenderItem[] {
  const out: RenderItem[] = [];
  for (const bit of bits) {
    if (!bit.renderCycle) continue;
    for (const n of bit.nodes) {
      if (!n.renderEnabled) continue;
      out.push({
        bit,
        slot: n.slot,
        kind: n.kind,
        emission: n.emission,
        center: bit.nodeCenter(n.slot),
        outward: outwardOf(n.slot),
      });
    }
  }
  return out;
}
