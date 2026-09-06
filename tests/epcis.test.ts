import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { EpcisSink, epcisKind, toEpcisDocument, VPB_NS } from "../src/epcis.ts";
import { RecordingSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { Grid } from "../src/grid.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";

const require = createRequire(import.meta.url);
const AjvCtor = (require("ajv").default ?? require("ajv")) as new (
  opts: object,
) => {
  compile(
    schema: object,
  ): ((doc: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
};
const addFormats = (require("ajv-formats").default ?? require("ajv-formats")) as (
  ajv: object,
) => void;

const schema = JSON.parse(readFileSync("vendor/epcis/epcis-json-schema.json", "utf8"));
const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function carveSequence(sink: RecordingSink, flat: boolean) {
  const g = flat
    ? FlatGrid.fill(8, 8, 8, {
        emission: { color: 0x1f6feb, light: 0.6 },
        sink,
        now: () => 1_700_000_000_000,
      })
    : Grid.fill(8, 8, 8, {
        emission: { color: 0x1f6feb, light: 0.6 },
        sink,
        now: () => 1_700_000_000_000,
      });
  for (const b of g.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  g.wrangle({ actor: "Oscar", cause: "carve the tunnel" }, () => {
    for (let x = 0; x < 8; x++) g.setPresent(g.at(x, 3, 3)!, false);
  });
  g.setPresent(g.at(5, 3, 3)!, true);
  g.move(g.at(0, 0, 0)!, [10, 10, 10]);
  const b = g.at(7, 7, 7)!;
  b.emit(9, { color: 0x00ff00, data: { tag: "seam" } });
  b.setPassport({ name: "corner", nested: { a: [1, null] } });
  b.annotate("note", "corner");
  g.remove(g.at(7, 0, 0)!);
  return g;
}

test("the carve sequence on FlatGrid validates against the EPCIS 2.0 schema", () => {
  const sink = new RecordingSink();
  carveSequence(sink, true);
  const doc = toEpcisDocument(sink.events, { now: () => 1_700_000_000_000 });
  const ok = validate(doc);
  assert.ok(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2));
  assert.equal(doc.type, "EPCISDocument");
  assert.equal(doc.epcisBody.eventList.length, sink.events.length);
});

test("every VPB event type lands as its mapped EPCIS type and action, counted", () => {
  const sink = new RecordingSink();
  carveSequence(sink, false); // Grid records link events too
  const doc = toEpcisDocument(sink.events);
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 5), null, 2));
  const expect = new Map<string, number>();
  for (const e of sink.events) {
    const k = epcisKind(e.type);
    const key = `${k.type}:${k.action}`;
    expect.set(key, (expect.get(key) ?? 0) + 1);
  }
  const got = new Map<string, number>();
  for (const ev of doc.epcisBody.eventList) {
    const key = `${ev.type}:${ev.action}`;
    got.set(key, (got.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...got.entries()].sort(), [...expect.entries()].sort());
  assert.ok((got.get("AssociationEvent:ADD") ?? 0) > 0, "links became AssociationEvents");
  assert.ok((got.get("AssociationEvent:DELETE") ?? 0) > 0);
  assert.equal(got.get("ObjectEvent:ADD"), 512);
  assert.equal(got.get("ObjectEvent:DELETE"), 1);
});

test("fields: identifiers, readPoint, bizStep from cause, actor as owning party, sensors, ilmd", () => {
  const sink = new RecordingSink();
  const g = carveSequence(sink, true);
  const doc = toEpcisDocument(sink.events);
  const list = doc.epcisBody.eventList;
  const created = list.find((e) => e["vpb:type"] === "created")!;
  assert.deepEqual(created.epcList, [`${VPB_NS}bit/${sink.events[0]!.bit}`]);
  assert.equal(created.bizStep, "commissioning");
  assert.deepEqual((created.readPoint as { id: string }).id, `${VPB_NS}frame/${g.id}`);
  const ilmd = created.ilmd as Record<string, unknown>;
  assert.equal(ilmd["vpb:color"], 0xffffff, "the bit's own color, default white");
  assert.deepEqual(ilmd["vpb:emission"], { color: 0x1f6feb, light: 0.6 }, "the initial emission");
  const carved = list.find((e) => e["vpb:type"] === "presence")!;
  assert.equal(carved.disposition, "inactive");
  assert.match(String(carved.bizStep), /bizstep\/carve-the-tunnel$/);
  assert.deepEqual(carved.sourceList, [{ type: "owning_party", source: `${VPB_NS}actor/oscar` }]);
  // The fill lights slot 9 first; the carve sequence emits it again with data. Take the last.
  const emitted = list.filter((e) => e["vpb:type"] === "emitted" && e["vpb:slot"] === 9).at(-1)!;
  const report = (emitted.sensorElementList as { sensorReport: Record<string, unknown>[] }[])[0]!
    .sensorReport;
  assert.deepEqual(
    report.map((r) => r.type),
    ["vpb:color", "vpb:data"],
  );
  const passport = list.find((e) => e["vpb:type"] === "passport")!;
  assert.equal(passport.ilmd, undefined, "ilmd is ADD-only; the passport rides an extension");
  assert.deepEqual(passport["vpb:passport"], {
    name: "corner",
    nested: { a: [1, null] },
  });
  const destroyed = list.find((e) => e["vpb:type"] === "destroyed")!;
  assert.equal(destroyed.action, "DELETE");
  assert.equal(destroyed.bizStep, "destroying");
  assert.ok(
    list.every((e) => typeof e.eventID === "string" && e.eventID.startsWith("urn:vpb:event:")),
  );
  assert.ok(list.every((e) => e.eventTimeZoneOffset === "+00:00"));
});

test("identifiers other than the event id are web URIs, and the prefixes are options", () => {
  const sink = new RecordingSink();
  carveSequence(sink, false);
  const doc = toEpcisDocument(sink.events);
  for (const ev of doc.epcisBody.eventList) {
    const ids = [
      ...((ev.epcList as string[] | undefined) ?? []),
      ...((ev.childEPCs as string[] | undefined) ?? []),
      ...(ev.parentID ? [ev.parentID as string] : []),
      (ev.readPoint as { id: string }).id,
      ...((ev.sourceList as { source: string }[] | undefined) ?? []).map((s) => s.source),
    ];
    for (const id of ids) assert.ok(id.startsWith(VPB_NS), `web URI under the namespace: ${id}`);
    assert.ok((ev.eventID as string).startsWith("urn:vpb:event:"));
  }
  const custom = toEpcisDocument(sink.events, {
    bitPrefix: "urn:uuid:",
    framePrefix: "urn:epc:id:sgln:0614141.00777.",
    actorPrefix: "urn:epc:id:pgln:0614141.",
  });
  const first = custom.epcisBody.eventList[0]!;
  assert.deepEqual(first.epcList, [`urn:uuid:${sink.events[0]!.bit}`]);
  assert.ok((first.readPoint as { id: string }).id.startsWith("urn:epc:id:sgln:"));
});

test("EpcisSink accumulates and renders on demand", () => {
  const sink = new EpcisSink({ now: () => 0 });
  const g = new FlatGrid({ sink });
  g.add([0, 0, 0], { emission: { color: 1 } });
  g.add([1, 0, 0]);
  const doc = sink.document();
  assert.equal(doc.creationDate, "1970-01-01T00:00:00.000Z");
  assert.equal(doc.epcisBody.eventList.length, sink.events.length);
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 3)));
});
