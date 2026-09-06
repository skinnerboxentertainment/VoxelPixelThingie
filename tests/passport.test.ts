import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingSink } from "../src/events.ts";
import { Grid } from "../src/grid.ts";
import { assertJsonSerializable } from "../src/json.ts";

test("setPassport replaces whole, emits one event, and returns detached copies", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  const b = g.add([0, 0, 0]);
  assert.deepEqual(b.passport, {});
  b.setPassport({ name: "one", n: 1 });
  b.setPassport({ name: "two" });
  const events = sink.events.filter((e) => e.type === "passport");
  assert.equal(events.length, 2);
  assert.deepEqual(b.passport, { name: "two" }, "whole replacement, n is gone");
  const copy = b.passport;
  copy.name = "mutated";
  assert.equal(b.passport.name, "two", "the getter hands out copies");
  const input = { name: "three", list: [1] };
  b.setPassport(input);
  input.list.push(2);
  assert.deepEqual(b.passport, { name: "three", list: [1] }, "the bit keeps its own copy");
});

test("invalid passports throw before any event and leave the bit unchanged", () => {
  const sink = new RecordingSink();
  const g = new Grid({ sink });
  const b = g.add([0, 0, 0]);
  b.setPassport({ ok: true });
  const before = sink.events.length;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const bad: unknown[] = [
    { f: () => 1 },
    cyclic,
    { n: Number.NaN },
    { n: Number.POSITIVE_INFINITY },
    { u: undefined },
    { big: 10n },
    { d: new Date() },
    [1, 2],
    null,
    "string",
  ];
  for (const p of bad) {
    assert.throws(() => b.setPassport(p as never), TypeError, JSON.stringify(String(p)));
  }
  assert.equal(sink.events.length, before, "no event was emitted");
  assert.deepEqual(b.passport, { ok: true });
});

test("assertJsonSerializable names the path of the offending value", () => {
  assert.throws(() => assertJsonSerializable({ a: [{ b: () => 0 }] }), /\$\.a\[0\]\.b: function/);
  assert.doesNotThrow(() => assertJsonSerializable({ a: [1, "x", null, { b: true }] }));
});

test("a sink that refuses a passport event leaves the bit unchanged", () => {
  const refusing = {
    record(e: { type: string }) {
      if (e.type === "passport") throw new Error("too big");
    },
  };
  const g = new Grid({ sink: refusing });
  const b = g.add([0, 0, 0]);
  assert.throws(() => b.setPassport({ x: 1 }), /too big/);
  assert.deepEqual(b.passport, {});
});
