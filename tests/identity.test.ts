import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingSink, replay } from "../src/events.ts";
import { Grid } from "../src/grid.ts";
import { isUuidv7, uuidv7 } from "../src/uuid.ts";

test("10,000 ids across 10 grids: unique, v7, and string order equals minting order", () => {
  const ids: string[] = [];
  const grids = Array.from({ length: 10 }, () => new Grid());
  for (let i = 0; i < 10_000; i++) {
    const g = grids[i % 10]!;
    ids.push(g.add([i, 0, 0]).id);
  }
  assert.equal(new Set(ids).size, ids.length, "no collisions");
  assert.ok(ids.every(isUuidv7), "every id is a UUID v7");
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids, "sorted order is minting order");
  assert.ok(
    grids.every((g) => isUuidv7(g.id)),
    "containers get v7 ids too",
  );
  assert.equal(new Set(grids.map((g) => g.id)).size, 10);
});

test("uuidv7 keeps order across a millisecond boundary and counter wrap", () => {
  const a = uuidv7(1_000);
  const b = uuidv7(1_000);
  const c = uuidv7(1_001);
  assert.ok(a < b && b < c);
  // Force many ids in the same millisecond past the 12-bit counter.
  let prev = uuidv7(5_000);
  for (let i = 0; i < 5000; i++) {
    const next = uuidv7(5_000);
    assert.ok(next > prev, `order held at ${i}`);
    prev = next;
  }
});

test("wrangle stamps actor and cause inside only, nests, and restores on throw", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  const b = g.add([0, 0, 0]);
  const last = () => sink.events[sink.events.length - 1]!;
  b.emit(5, { light: 1 });
  assert.equal(last().actor, undefined);
  g.wrangle({ actor: "oscar", cause: "outer" }, () => {
    b.emit(5, { light: 0.5 });
    assert.equal(last().actor, "oscar");
    assert.equal(last().cause, "outer");
    g.wrangle({ actor: "tool" }, () => {
      b.emit(5, { light: 0.25 });
      assert.equal(last().actor, "tool");
      assert.equal(last().cause, undefined, "nested context replaces, not merges");
    });
    b.emit(5, { light: 0.75 });
    assert.equal(last().cause, "outer", "outer context restored");
  });
  b.emit(5, { light: 0 });
  assert.equal(last().actor, undefined, "cleared on exit");
  assert.throws(() =>
    g.wrangle({ actor: "x" }, () => {
      throw new Error("boom");
    }),
  );
  assert.deepEqual(g.wrangler, {}, "restored after a throw");
  assert.equal(
    g.wrangle({ actor: "y" }, () => 42),
    42,
    "returns the callback's value",
  );
});

test("replay stamps actor replay, copies cause, and keeps the frame", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  g.wrangle({ actor: "oscar", cause: "build" }, () => {
    g.add([0, 0, 0]);
    g.add([1, 0, 0]);
  });
  g.add([2, 0, 0]);
  const replaySink = new RecordingSink();
  const r = replay(sink.events, { sink: replaySink });
  assert.equal(r.id, g.id);
  assert.ok(replaySink.events.every((e) => e.actor === "replay"));
  assert.ok(replaySink.events.every((e) => e.frame === g.id));
  const causes = new Set(replaySink.events.map((e) => e.cause));
  assert.deepEqual([...causes].sort(), ["build", undefined].sort());
});
