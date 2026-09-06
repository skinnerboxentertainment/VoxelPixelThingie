import assert from "node:assert/strict";
import { test } from "node:test";
import { cubeNetCells, NET_COLS, NET_ROWS, renderCubeNet, TILE } from "../scripts/cube-net.ts";
import { defaultLedMap, LED_MAP_FORMAT, type LedMap } from "../src/led-map.ts";
import { EDGE_SLOTS, FACE_SLOTS, kindOf, VERTEX_SLOTS } from "../src/slots.ts";

test("the net has six 5x5 tiles; every edge sits on two tiles and every corner on three", () => {
  const cells = cubeNetCells(defaultLedMap());
  assert.equal(cells.length, 6 * TILE * TILE);
  assert.ok(cells.every((c) => c.row >= 0 && c.row < NET_ROWS && c.col >= 0 && c.col < NET_COLS));
  const tilesOf = (slot: number) =>
    new Set(
      cells
        .filter((c) => c.slot === slot)
        .map((c) => `${Math.floor(c.row / TILE)},${Math.floor(c.col / TILE)}`),
    );
  for (const s of FACE_SLOTS) assert.equal(tilesOf(s).size, 1, `face ${s} on one tile`);
  for (const s of EDGE_SLOTS) assert.equal(tilesOf(s).size, 2, `edge ${s} on two tiles`);
  for (const s of VERTEX_SLOTS) assert.equal(tilesOf(s).size, 3, `vertex ${s} on three tiles`);
  // Per tile: 9 face cells, 12 edge cells (3 per side), 4 corner cells.
  const byTile = new Map<string, { face: number; edge: number; vertex: number }>();
  for (const c of cells) {
    const k = `${Math.floor(c.row / TILE)},${Math.floor(c.col / TILE)}`;
    const t = byTile.get(k) ?? { face: 0, edge: 0, vertex: 0 };
    t[kindOf(c.slot)]++;
    byTile.set(k, t);
  }
  for (const t of byTile.values()) assert.deepEqual(t, { face: 9, edge: 12, vertex: 4 });
});

test("cells show the LEDs of their slot: edges cover their range end to end on both tiles, corners their one LED, faces their four", () => {
  const map = defaultLedMap();
  const cells = cubeNetCells(map);
  for (const s of EDGE_SLOTS) {
    const r = map.slots[s]!;
    const mine = cells.filter((c) => c.slot === s);
    assert.equal(mine.length, 6);
    const leds = new Set(mine.flatMap((c) => c.leds));
    assert.deepEqual(
      [...leds].sort((a, b) => a - b),
      [r.start, r.start + 1, r.start + 2],
      `edge ${s} shows its whole range`,
    );
    // Both tiles see the same LED at the same end of the edge: three distinct LEDs per tile.
    const tiles = new Map<string, number[]>();
    for (const c of mine) {
      const k = `${Math.floor(c.row / TILE)},${Math.floor(c.col / TILE)}`;
      tiles.set(k, [...(tiles.get(k) ?? []), ...c.leds]);
    }
    for (const l of tiles.values()) assert.equal(new Set(l).size, 3);
  }
  for (const s of VERTEX_SLOTS) {
    for (const c of cells.filter((c) => c.slot === s))
      assert.deepEqual(c.leds, [map.slots[s]!.start]);
  }
  for (const s of FACE_SLOTS) {
    const r = map.slots[s]!;
    const mine = cells.filter((c) => c.slot === s);
    const singles = mine.filter((c) => c.leds.length === 1).map((c) => c.leds[0]!);
    assert.deepEqual(
      [...new Set(singles)].sort((a, b) => a - b),
      [r.start, r.start + 1, r.start + 2, r.start + 3],
      `face ${s}: four LEDs at the inner corners`,
    );
    assert.equal(mine.filter((c) => c.leds.length === 4).length, 1, "the centre averages all four");
    assert.equal(mine.filter((c) => c.leds.length === 2).length, 4, "the inner sides average two");
  }
});

test("a slot with no LEDs is unmapped, not dark; other counts resample", () => {
  const map = defaultLedMap();
  const cornersOnly: LedMap = {
    format: LED_MAP_FORMAT,
    leds: map.leds,
    slots: map.slots.map((r, s) => (kindOf(s) === "vertex" ? r : { start: 0, count: 0 })),
  };
  const cells = cubeNetCells(cornersOnly);
  assert.ok(cells.filter((c) => kindOf(c.slot) !== "vertex").every((c) => c.leds.length === 0));
  const plain = renderCubeNet(cells, new Uint8Array(map.leds * 3), { colorDepth: 1 });
  assert.ok(plain.includes("??"), "unmapped cells are marked");
  // One LED per node everywhere: every cell shows that one LED.
  const one: LedMap = {
    format: LED_MAP_FORMAT,
    leds: 26,
    slots: map.slots.map((_, s) => ({ start: s, count: 1 })),
  };
  for (const c of cubeNetCells(one)) assert.deepEqual(c.leds, [c.slot]);
});

test("render: plain text has no escapes and 15 rows; truecolor paints a lit face and greys the unmapped", () => {
  const map = defaultLedMap();
  const cells = cubeNetCells(map);
  const frame = new Uint8Array(map.leds * 3);
  // Face 0 (−X) blue, everything else dark.
  for (let i = 0; i < 4; i++) {
    frame[i * 3] = 0x1f;
    frame[i * 3 + 1] = 0x6f;
    frame[i * 3 + 2] = 0xeb;
  }
  const plain = renderCubeNet(cells, frame, { colorDepth: 1, header: ["h1", "h2"] });
  assert.ok(!plain.includes("\x1b"));
  const lines = plain.trimEnd().split("\n");
  assert.equal(lines.length, 2 + NET_ROWS);
  assert.equal(lines[0], "h1");
  const color = renderCubeNet(cells, frame, { colorDepth: 24 });
  assert.ok(color.includes("\x1b[48;2;31;111;235m"), "the blue face is painted at full value");
  assert.ok(color.includes("\x1b[48;2;0;0;0m"), "dark LEDs are painted black");
  const c256 = renderCubeNet(cells, frame, { colorDepth: 8 });
  assert.ok(c256.includes("[48;5;"), "256-color cells");
  assert.ok(!c256.includes("48;2;"));
});
