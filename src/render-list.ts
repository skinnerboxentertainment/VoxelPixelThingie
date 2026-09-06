/**
 * The seam between the model and every renderer. Walks nodes that survived
 * the self-test and hands back what a renderer needs and nothing else.
 */

import type { BitHandle } from "./container.ts";
import { kindOf, type NodeKind, outwardOf, type Slot } from "./slots.ts";
import type { Emission, Vec3 } from "./vpb.ts";

export interface RenderItem {
  readonly bit: BitHandle;
  readonly slot: Slot;
  readonly kind: NodeKind;
  readonly emission: Emission;
  /** World-space center of the node. */
  readonly center: Vec3;
  /** Outward direction of the node, unnormalized, in bit units. */
  readonly outward: Vec3;
}

/** Call after evaluate(). Bits outside the render cycle contribute nothing. */
export function renderList(bits: Iterable<BitHandle>): RenderItem[] {
  const out: RenderItem[] = [];
  for (const bit of bits) {
    if (!bit.renderCycle) continue;
    for (const slot of bit.open) {
      if (!bit.renderEnabledOf(slot)) continue;
      out.push({
        bit,
        slot,
        kind: kindOf(slot),
        emission: bit.emissionOf(slot),
        center: bit.nodeCenter(slot),
        outward: outwardOf(slot),
      });
    }
  }
  return out;
}
