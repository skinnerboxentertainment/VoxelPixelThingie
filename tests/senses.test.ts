/**
 * Senses (PLAN-4.md Phase 21, ADR 0015, SPEC.md §9.9): readings validate
 * at the sink, land under the device as actor, export as standard EPCIS
 * sensor reports that validate against the schema, survive compaction as
 * the last per quantity, and arrive from the twin through the bridge's
 * reader, the same path the physical bit will use.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readWledSensors } from "../scripts/led-bridge.ts";
import { startWledSim } from "../scripts/wled-sim.ts";
import { compactLedger } from "../src/compact.ts";
import { toEpcisDocument, toEpcisEvent } from "../src/epcis.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { PackedStore, packScene } from "../src/pack.ts";
import { ledgerPath, openScene, parseLedger, SceneSink } from "../src/scene.ts";
import {
  QUANTITIES,
  type Reading,
  readingFromWled,
  recordReadings,
  senseKey,
  validateSenseAnnotation,
} from "../src/senses.ts";
import { MemoryStore } from "../src/store.ts";
import { sceneDigest } from "../src/verify.ts";

const require = createRequire(import.meta.url);
const AjvCtor = (require("ajv").default ?? require("ajv")) as new (
  o: object,
) => { compile(schema: object): ((d: unknown) => boolean) & { errors?: unknown[] } };
const addFormats = (require("ajv-formats").default ?? require("ajv-formats")) as (
  a: object,
) => void;
const schema = JSON.parse(readFileSync("vendor/epcis/epcis-json-schema.json", "utf8"));
const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const reading = (over: Partial<Reading> = {}): Reading => ({
  value: 24.3,
  uom: "CEL",
  time: 1_700_000_000_000,
  device: "wled-bit-1",
  ...over,
});

test("a reading validates: value, unit, time, device; the rest is refused by name; other keys pass", () => {
  validateSenseAnnotation("sense:temperature", reading());
  validateSenseAnnotation("sense:touch", { value: 3, uom: "C62", time: 1 });
  validateSenseAnnotation("note", "anything");
  assert.throws(() => validateSenseAnnotation("sense:", reading()), /quantity is empty/);
  assert.throws(() => validateSenseAnnotation("sense:temperature", "24"), /is an object/);
  assert.throws(
    () => validateSenseAnnotation("sense:temperature", reading({ value: "24" as never })),
    /finite number/,
  );
  assert.throws(
    () => validateSenseAnnotation("sense:temperature", reading({ value: Number.NaN })),
    /finite number/,
  );
  assert.throws(() => validateSenseAnnotation("sense:temperature", { value: 1, time: 1 }), /uom/);
  assert.throws(
    () => validateSenseAnnotation("sense:temperature", reading({ time: "now" as never })),
    /time/,
  );
  assert.throws(
    () => validateSenseAnnotation("sense:temperature", reading({ device: 7 as never })),
    /device/,
  );
  assert.throws(
    () => validateSenseAnnotation("sense:temperature", reading({ min: "x" as never })),
    /min/,
  );
  assert.deepEqual(readingFromWled({ type: "T", n: "board", val: 21.5, unit: "°C" }, 5, "sim"), {
    key: "sense:temperature",
    reading: { value: 21.5, uom: "CEL", time: 5, device: "sim" },
  });
  assert.equal(readingFromWled({ type: "L", val: 300, unit: "lx" }, 5)!.reading.uom, "LUX");
  assert.equal(
    readingFromWled({ type: "L", val: 300 }, 5)!.reading.uom,
    "LUX",
    "a missing unit is the quantity's default",
  );
  assert.equal(readingFromWled({ type: "H", val: 40, unit: "%" }, 5)!.key, "sense:humidity");
  assert.equal(
    readingFromWled({ type: "X", val: 1 }, 5),
    undefined,
    "an unknown type is not a sense",
  );
  assert.equal(
    readingFromWled({ type: "T", val: "warm" }, 5),
    undefined,
    "a non-numeric value is not a reading",
  );
  for (const q of Object.values(QUANTITIES)) assert.match(q.uom, /^[A-Z0-9]{2,3}$/);
});

async function scene() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const recorder = new RecordingSink();
  const grid = FlatGrid.fill(2, 2, 1, {
    emission: { color: 0x1f6feb, light: 0.6 },
    sink: new TeeSink([sink, recorder]),
  });
  await sink.flush();
  return { mem, sink, recorder, grid };
}

test("readings land under the device as actor, a malformed one is refused at the sink, and the digest holds across memory and pack with readings in the ledger", async () => {
  const { mem, sink, grid } = await scene();
  const bit = grid.at(0, 0, 0)!;
  recordReadings(
    grid,
    bit,
    [
      { key: senseKey("temperature"), reading: reading() },
      { key: senseKey("illuminance"), reading: reading({ value: 320, uom: "LUX" }) },
    ],
    "wled-bit-1",
  );
  assert.throws(
    () =>
      grid.wrangle({ actor: "device:x" }, () =>
        bit.annotate("sense:temperature", { value: "hot" }),
      ),
    /finite number/,
  );
  await sink.flush();
  const ledger = parseLedger(await mem.read(ledgerPath(bit.id)));
  const senses = ledger.filter((e) => e.type === "annotated" && e.key.startsWith("sense:"));
  assert.equal(senses.length, 2);
  assert.equal(senses[0]!.actor, "device:wled-bit-1");
  assert.equal(senses[0]!.cause, "sense");
  assert.deepEqual((senses[1] as { value: Reading }).value, reading({ value: 320, uom: "LUX" }));
  const digest = await sceneDigest(await openScene(mem));
  assert.equal(await sceneDigest(await openScene(new PackedStore(await packScene(mem)))), digest);
});

test("EPCIS: a reading is an observation with a standard sensor report in the CBV vocabulary, and the document validates against the schema", async () => {
  const { recorder, grid } = await scene();
  const bit = grid.at(1, 0, 0)!;
  recordReadings(
    grid,
    bit,
    [
      { key: senseKey("temperature"), reading: reading({ min: 24.1, max: 24.5 }) },
      {
        key: senseKey("touch"),
        reading: reading({ value: 2, uom: "C62", device: "https://example.org/device/1" }),
      },
    ],
    "wled-bit-1",
  );
  const events = recorder.events.filter((e) => e.type === "annotated");
  const temp = toEpcisEvent(events[0]!);
  assert.equal(temp.type, "ObjectEvent");
  assert.equal(temp.action, "OBSERVE");
  assert.match(String(temp.bizStep), /bizstep\/sense$/, "the cause is the business step");
  const element = (
    temp.sensorElementList as {
      sensorMetadata: Record<string, unknown>;
      sensorReport: Record<string, unknown>[];
    }[]
  )[0]!;
  assert.equal(element.sensorMetadata.time, "2023-11-14T22:13:20.000Z");
  assert.match(String(element.sensorMetadata.deviceID), /\/ns\/device\/wled-bit-1$/);
  assert.deepEqual(element.sensorReport[0], {
    type: "gs1:Temperature",
    value: 24.3,
    uom: "CEL",
    minValue: 24.1,
    maxValue: 24.5,
  });
  const touch = toEpcisEvent(events[1]!);
  const t = (
    touch.sensorElementList as {
      sensorMetadata: Record<string, unknown>;
      sensorReport: Record<string, unknown>[];
    }[]
  )[0]!;
  assert.equal(
    t.sensorMetadata.deviceID,
    "https://example.org/device/1",
    "a URI device stays as it is",
  );
  assert.deepEqual(t.sensorReport[0], { type: "vpb:Touch", value: 2, uom: "C62" });
  const doc = toEpcisDocument(recorder.events, { now: () => 1_700_000_000_000 });
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 5), null, 2));
});

test("compaction keeps the last reading per quantity past the tail", () => {
  const base = { bit: "b", frame: "f", time: 0 } as const;
  const events = [
    { ...base, seq: 1, type: "created" as const, position: [0, 0, 0] as const, color: 0 },
    {
      ...base,
      seq: 2,
      type: "annotated" as const,
      key: "sense:temperature",
      value: reading({ value: 20 }),
    },
    {
      ...base,
      seq: 3,
      type: "annotated" as const,
      key: "sense:illuminance",
      value: reading({ value: 100, uom: "LUX" }),
    },
    {
      ...base,
      seq: 4,
      type: "annotated" as const,
      key: "sense:temperature",
      value: reading({ value: 21 }),
    },
    { ...base, seq: 5, type: "annotated" as const, key: "note", value: "x" },
    { ...base, seq: 6, type: "emitted" as const, slot: 0, emission: {} },
    { ...base, seq: 7, type: "emitted" as const, slot: 1, emission: {} },
  ];
  const passport = { seq: 7 } as never;
  const kept = compactLedger(events as never, passport, { tail: 2, dropLinks: true });
  assert.deepEqual(
    kept.map((e) => e.seq),
    [3, 4, 6, 7],
    "the tail, plus the last temperature and the last illuminance",
  );
  const none = compactLedger(events.slice(0, 1) as never, { seq: 1 } as never, {
    tail: 1,
    dropLinks: true,
  });
  assert.deepEqual(
    none.map((e) => e.seq),
    [1],
  );
});

test("the twin reports senses in info.sensor and the bridge's reader turns them into readings that land in the ledger", async () => {
  const sim = await startWledSim({
    udpPort: 0,
    httpPort: 0,
    render: () => {},
    sensors: { temperature: 22, illuminance: 400 },
  });
  try {
    const base = `http://127.0.0.1:${sim.httpPort}`;
    const info = (await (await fetch(`${base}/json/info`)).json()) as {
      sensor?: { type: string; val: number; unit: string }[];
    };
    assert.equal(info.sensor?.length, 2);
    assert.deepEqual(
      info.sensor!.map((s) => s.type),
      ["T", "L"],
    );
    const readings = await readWledSensors(base, { now: () => 1_700_000_000_000 });
    assert.equal(readings.length, 2);
    const temp = readings.find((r) => r.key === "sense:temperature")!;
    assert.ok(Math.abs(temp.reading.value - 22) <= 0.5, String(temp.reading.value));
    assert.equal(temp.reading.uom, "CEL");
    assert.equal(temp.reading.time, 1_700_000_000_000);
    assert.equal(temp.reading.device, "vpb-sim");
    const lux = readings.find((r) => r.key === "sense:illuminance")!;
    assert.ok(Math.abs(lux.reading.value - 400) <= 20);
    assert.equal(lux.reading.uom, "LUX");

    const { mem, sink, grid } = await scene();
    const bit = grid.at(0, 1, 0)!;
    recordReadings(grid, bit, readings, `127.0.0.1:${sim.httpPort}`);
    await sink.flush();
    const ledger = parseLedger(await mem.read(ledgerPath(bit.id)));
    const last = ledger.at(-1)!;
    assert.equal(last.type, "annotated");
    assert.equal((last as { key: string }).key, "sense:illuminance");
    assert.equal(last.actor, `device:127.0.0.1:${sim.httpPort}`);
    const plain = await startWledSim({ udpPort: 0, httpPort: 0, render: () => {} });
    try {
      assert.deepEqual(
        await readWledSensors(`http://127.0.0.1:${plain.httpPort}`),
        [],
        "a device without sensors reports none",
      );
    } finally {
      await plain.close();
    }
  } finally {
    await sim.close();
  }
});
