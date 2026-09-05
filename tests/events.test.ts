import assert from "node:assert/strict";
import { test } from "node:test";
import { type BitEvent, RecordingSink, replay } from "../src/events.ts";
import { Grid } from "../src/grid.ts";
import { ALL_SLOTS } from "../src/slots.ts";
import type { VoxelPixelBit } from "../src/vpb.ts";

const RED = { color: 0xff0000 };

/** Everything replay must reproduce, per bit, in a stable order. */
function snapshot(g: Grid) {
  return [...g.bits()]
    .map((b: VoxelPixelBit) => ({
      id: b.id,
      key: b.key,
      present: b.present,
      color: b.color,
      emissions: b.nodes.map((n) => n.emission),
      links: b.nodes.map((n) => n.links.map((l) => `${l.bit.id}:${l.slot}`).sort()),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function fakeClock() {
  let t = 1000;
  return () => (t += 1);
}

test("oracle: carve, move, emit, destroy on an 8x8x8, then replay to the same state", () => {
  const sink = new RecordingSink();
  const live = Grid.fill(8, 8, 8, { emission: RED, sink, now: fakeClock() });

  // Carve a 12-bit tunnel along X through the middle by presence.
  for (let x = 0; x < 8; x++) live.setPresent(live.at(x, 3, 3)!, false);
  for (let x = 2; x < 6; x++) live.setPresent(live.at(x, 4, 3)!, false);
  // Bring one back.
  live.setPresent(live.at(5, 3, 3)!, true);
  // Move a corner bit out to a free cell.
  live.move(live.at(0, 0, 0)!, [10, 10, 10]);
  // Emit on three nodes of another bit.
  const b = live.at(7, 7, 7)!;
  b.emit(5, { light: 0.5 });
  b.emit(9, { color: 0x00ff00, data: { tag: "seam" } });
  b.emit(25, {});
  b.annotate("note", "corner");
  // Destroy one.
  live.remove(live.at(7, 0, 0)!);
  live.evaluate();

  const replayed = replay(sink.events);
  replayed.evaluate();

  assert.equal(replayed.size, live.size);
  assert.deepEqual(snapshot(replayed), snapshot(live));

  // Render results agree too, since they are a projection of the same state.
  const enabled = (g: Grid) =>
    [...g.bits()].map((x) => [x.id, x.renderCycle, x.nodes.map((n) => n.renderEnabled)]);
  assert.deepEqual(enabled(replayed), enabled(live));
});

test("events are stamped in sequence with the container clock and the bit id", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink, now: fakeClock() });
  const a = g.add([0, 0, 0]);
  const b = g.add([1, 0, 0]);
  const seqs = sink.events.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i + 1),
    "seq is 1..n",
  );
  assert.ok(sink.events.every((e, i) => i === 0 || e.time > sink.events[i - 1]!.time));
  const kinds = sink.events.map((e) => `${e.bit}:${e.type}`);
  assert.equal(kinds[0], `${a.id}:created`);
  assert.equal(kinds[1], `${b.id}:created`);
  assert.equal(sink.events.filter((e) => e.type === "linked").length, 18, "9 per side");
  assert.equal(g.eventCount, sink.events.length);
});

test("every mutator emits exactly its event", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  const a = g.add([0, 0, 0], { emission: RED });
  g.add([1, 0, 0]);
  const after = () => sink.events.slice(-1)[0]!;
  a.emit(3, { light: 1 });
  assert.equal(after().type, "emitted");
  a.annotate("k", 42);
  assert.deepEqual(after(), { ...after(), type: "annotated", key: "k", value: 42 });
  g.setPresent(a, false);
  const types = sink.events.map((e) => e.type);
  assert.ok(types.includes("unlinked"));
  assert.equal(after().type, "presence");
  g.setPresent(a, true);
  assert.equal(types.length < sink.events.length, true);
  assert.ok(
    sink.events.slice(types.length).some((e) => e.type === "linked"),
    "relinked on return",
  );
  g.move(a, [0, 5, 0]);
  assert.ok(sink.events.some((e) => e.type === "moved" && e.bit === a.id));
  g.remove(a);
  assert.equal(after().type, "destroyed");
  const created = sink.events.find((e) => e.type === "created" && e.bit === a.id) as BitEvent & {
    type: "created";
  };
  assert.deepEqual(created.emission, RED);
  assert.equal(created.color, 0xffffff);
});

test("standalone bits report nowhere and emitAll records one event per slot", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  const a = g.add([0, 0, 0]);
  const before = sink.events.length;
  a.emitAll(ALL_SLOTS, RED);
  assert.equal(sink.events.length - before, 26);
});

test("replay rejects an event for an unknown bit", () => {
  assert.throws(
    () => replay([{ type: "presence", present: false, bit: "ghost", seq: 1, time: 0 }]),
    /no bit ghost/,
  );
});
