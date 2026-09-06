import assert from "node:assert/strict";
import { test } from "node:test";
import { FlatGrid } from "../src/flat-grid.ts";
import {
  defaultLedMap,
  LED_CHANNELS,
  LED_MAP_FORMAT,
  ledFrame,
  ledMapFromJson,
  ledMapOf,
  validateLedMap,
} from "../src/led-map.ts";
import { EDGE_SLOTS, FACE_SLOTS, kindOf, NODE_COUNT, VERTEX_SLOTS } from "../src/slots.ts";

test("the default map is the plan's bill of materials: 68 LEDs, 4 per face, 3 per edge, 1 per corner, in slot order", () => {
  const map = defaultLedMap();
  assert.equal(map.format, LED_MAP_FORMAT);
  assert.equal(map.leds, 6 * 4 + 12 * 3 + 8 * 1);
  assert.equal(map.slots.length, NODE_COUNT);
  let next = 0;
  for (let slot = 0; slot < NODE_COUNT; slot++) {
    const r = map.slots[slot]!;
    assert.equal(r.start, next, `slot ${slot} starts where the previous ended`);
    assert.equal(r.count, { face: 4, edge: 3, vertex: 1 }[kindOf(slot)]);
    next += r.count;
  }
  assert.equal(next, map.leds);
  assert.deepEqual(map.slots[FACE_SLOTS[0]!], { start: 0, count: 4 });
  assert.deepEqual(map.slots[EDGE_SLOTS[0]!], { start: 24, count: 3 });
  assert.deepEqual(map.slots[VERTEX_SLOTS[0]!], { start: 60, count: 1 });
  assert.deepEqual(validateLedMap(JSON.parse(JSON.stringify(map))), map, "round-trips as JSON");
});

test("validation names the first thing wrong", () => {
  const map = defaultLedMap();
  const bad = (edit: (m: ReturnType<typeof defaultLedMap>) => void, re: RegExp) => {
    const m = JSON.parse(JSON.stringify(map));
    edit(m);
    assert.throws(() => validateLedMap(m), re);
  };
  assert.throws(() => validateLedMap(null), /not an object/);
  bad((m) => {
    m.format = "vpb-led-map/2" as never;
  }, /format/);
  bad((m) => {
    m.leds = -1;
  }, /leds/);
  bad((m) => {
    m.slots.pop();
  }, /26 entries/);
  bad((m) => {
    m.slots[3] = { start: 1.5, count: 4 };
  }, /slot 3/);
  bad((m) => {
    m.slots[25] = { start: 67, count: 2 };
  }, /runs past the strip/);
  bad((m) => {
    m.slots[1] = { start: 0, count: 4 };
  }, /LED 0 belongs to two slots/);
  // A node with no LEDs is legal: a lattice build lights corners only.
  const cornersOnly = {
    ...map,
    slots: map.slots.map((r, s) => (kindOf(s) === "vertex" ? r : { start: 0, count: 0 })),
  };
  assert.equal(validateLedMap(cornersOnly).leds, 68);
  assert.equal(ledMapFromJson(JSON.stringify(map)).leds, 68);
});

test("the map travels in the passport under ledMap; a bad one throws, a missing one is undefined", () => {
  const map = defaultLedMap();
  assert.deepEqual(ledMapOf({ ledMap: JSON.parse(JSON.stringify(map)) }), map);
  assert.equal(ledMapOf({ name: "corner" }), undefined);
  assert.throws(() => ledMapOf({ ledMap: { format: LED_MAP_FORMAT } }), /leds/);
});

test("the reference bit's frame: faces blue at 0.6, edges lighter blue, corners white; absent is dark", () => {
  const g = FlatGrid.fill(2, 1, 1, { emission: { color: 0x1f6feb, light: 0.6 } });
  for (const b of g.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  const map = defaultLedMap();
  const bit = g.at(0, 0, 0)!;
  const frame = ledFrame(bit.record(), map);
  assert.equal(frame.length, map.leds * LED_CHANNELS);
  const px = (i: number) => [frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]];
  // face 0 (-X), four LEDs 0..3: 0x1f6feb scaled by 0.6, rounded
  for (let i = 0; i < 4; i++)
    assert.deepEqual(px(i), [
      Math.round(0x1f * 0.6),
      Math.round(0x6f * 0.6),
      Math.round(0xeb * 0.6),
    ]);
  // the +X face is closed by the neighbor but the physical bit lights it anyway: emissions, not culling
  assert.deepEqual(px(4), [19, 67, 141]);
  // edge slot 6, LEDs 24..26
  for (let i = 24; i < 27; i++) assert.deepEqual(px(i), [0x58, 0xa6, 0xff]);
  // corner slot 18, LED 60
  assert.deepEqual(px(60), [255, 255, 255]);
  assert.deepEqual(px(67), [255, 255, 255]);

  g.setPresent(bit, false);
  const dark = ledFrame(bit.record(), map);
  assert.ok(
    dark.every((v) => v === 0),
    "an absent bit is dark",
  );

  // Light clamps; a color-less emission takes the bit's color; data alone does not light.
  const rec = bit.record();
  rec.present = true;
  rec.emissions[0] = { light: 2 };
  rec.emissions[1] = { color: 0x102030, light: -1 };
  rec.emissions[2] = { data: { tag: 1 } };
  rec.emissions[3] = {};
  const f2 = ledFrame(rec, map);
  const p2 = (i: number) => [f2[i * 3], f2[i * 3 + 1], f2[i * 3 + 2]];
  assert.deepEqual(p2(0), [0xff, 0xff, 0xff], "bit color white at light clamped to 1");
  assert.deepEqual(p2(4), [0, 0, 0], "light clamped to 0");
  assert.deepEqual(p2(8), [0, 0, 0], "data only");
  assert.deepEqual(p2(12), [0, 0, 0], "silent");

  // Reuse a buffer; a wrong-sized one is refused.
  const into = new Uint8Array(map.leds * 3);
  assert.equal(ledFrame(rec, map, into), into);
  assert.throws(() => ledFrame(rec, map, new Uint8Array(3)), /buffer is 3 bytes/);
});
