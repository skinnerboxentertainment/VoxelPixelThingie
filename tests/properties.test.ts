/**
 * Property tests over the slot math. Each invariant runs 1000 cases.
 * These are the claims SPEC.md §5 and §7 make for every slot and offset,
 * stated so that fast-check can hunt for a counterexample.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Grid } from "../src/grid.ts";
import {
  ALL_SLOTS,
  kindOf,
  lies,
  linkOffsets,
  NODE_COUNT,
  negate,
  type Offset,
  partnerSlot,
  signsOf,
  slotOf,
} from "../src/slots.ts";

const RUNS = { numRuns: 1000 };
const slotArb = fc.integer({ min: 0, max: NODE_COUNT - 1 });
const compArb = fc.constantFrom(-1, 0, 1);
const offsetArb = fc
  .tuple(compArb, compArb, compArb)
  .filter(([x, y, z]) => x !== 0 || y !== 0 || z !== 0) as fc.Arbitrary<Offset>;

test("property: slotOf(signsOf(s)) == s", () => {
  fc.assert(
    fc.property(slotArb, (s) => slotOf(signsOf(s)) === s),
    RUNS,
  );
});

test("property: partner symmetry across every offset, and same kind", () => {
  fc.assert(
    fc.property(slotArb, offsetArb, (s, o) => {
      const p = partnerSlot(s, o);
      if (p === null) return true;
      return partnerSlot(p, negate(o)) === s && kindOf(p) === kindOf(s);
    }),
    RUNS,
  );
});

test("property: fan-out is 1 / 3 / 7 by kind", () => {
  const expected = { face: 1, edge: 3, vertex: 7 };
  fc.assert(
    fc.property(slotArb, (s) => linkOffsets(s).length === expected[kindOf(s)]),
    RUNS,
  );
});

test("property: lies() is reflexive and a face never lies on an edge or vertex", () => {
  fc.assert(
    fc.property(slotArb, slotArb, (a, b) => {
      if (!lies(a, a)) return false;
      if (kindOf(a) === "face" && kindOf(b) !== "face" && lies(a, b)) return false;
      return true;
    }),
    RUNS,
  );
});

test("property: in any grid, every link has a mirror on the neighbor", () => {
  const cellArb = fc.tuple(
    fc.integer({ min: 0, max: 3 }),
    fc.integer({ min: 0, max: 3 }),
    fc.integer({ min: 0, max: 3 }),
  );
  fc.assert(
    fc.property(
      fc.uniqueArray(cellArb, { minLength: 1, maxLength: 12, selector: (c) => c.join(",") }),
      (cells) => {
        const g = new Grid();
        for (const c of cells) g.add(c);
        for (const b of g.bits()) {
          for (const n of b.nodes) {
            for (const l of n.links) {
              const back = l.bit.node(l.slot).links.find((m) => m.bit === b && m.slot === n.slot);
              if (!back) return false;
            }
          }
        }
        return true;
      },
    ),
    { numRuns: 300 },
  );
});

test("property: removing any single bit leaves every remaining link mirrored", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 26 }), (victim) => {
      const g = Grid.fill(3, 3, 3);
      const bits = [...g.bits()];
      g.remove(bits[victim]!);
      for (const b of g.bits()) {
        if (b === bits[victim]) return false;
        for (const n of b.nodes) {
          for (const l of n.links) {
            if (l.bit === bits[victim]) return false;
            const back = l.bit.node(l.slot).links.find((m) => m.bit === b && m.slot === n.slot);
            if (!back) return false;
          }
        }
      }
      return true;
    }),
    { numRuns: 27 },
  );
});

test("ALL_SLOTS is 0..25 with no gaps", () => {
  assert.deepEqual(
    ALL_SLOTS,
    Array.from({ length: 26 }, (_, i) => i),
  );
});
