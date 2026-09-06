import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { failingWorkload, InProcessPool, WORKLOADS } from "../src/actor.ts";
import { toEpcisDocument } from "../src/epcis.ts";
import { RecordingSink, replay, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { JOB_KEYS, jobsOf, validateJobAnnotation } from "../src/jobs.ts";
import { PackedStore, packScene } from "../src/pack.ts";
import { SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import {
  contentId,
  digestOf,
  getText,
  isContentId,
  MemoryStorage,
  putText,
  VerifyingStorage,
} from "../src/storage.ts";
import { FolderStorage } from "../src/storage-node.ts";
import { MemoryStore } from "../src/store.ts";
import { sceneDigest } from "../src/verify.ts";

const require = createRequire(import.meta.url);

test("content ids: CIDv1 raw sha2-256 in base32, the same bytes give the same id on two backends, and a wrong blob is caught", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const cid = await contentId(bytes);
  assert.ok(cid.startsWith("bafkrei"), `raw-codec CIDv1 prefix: ${cid}`);
  const digest = digestOf(cid)!;
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  assert.deepEqual([...digest], expected, "the id decodes to the SHA-256 of the bytes");
  assert.ok(isContentId(cid));
  assert.equal(
    isContentId("bafybeibbu7hdh6jmuovoonsppyhjzni74av6koqkq2wjemqtgjvphkwi6m"),
    false,
    "a dag-pb id is not ours",
  );
  assert.equal(isContentId("not a cid"), false);
  assert.equal(isContentId(42), false);

  const mem = new MemoryStorage();
  const folder = new FolderStorage(mkdtempSync(join(tmpdir(), "vpb-storage-")));
  const a = await mem.put(bytes);
  const b = await folder.put(bytes);
  assert.equal(a, cid);
  assert.equal(b, cid);
  assert.deepEqual([...(await mem.get(cid))!], [...bytes]);
  assert.deepEqual([...(await folder.get(cid))!], [...bytes]);
  assert.equal(
    await mem.get("bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    undefined,
  );
  assert.equal(
    await folder.get("../etc/passwd"),
    undefined,
    "a non-id never touches the file system",
  );
  assert.equal(mem.size, 1, "putting the same bytes twice stores one blob");

  const lying = new VerifyingStorage({
    put: (x) => mem.put(x),
    get: async () => new Uint8Array([1, 2, 3]),
  });
  await assert.rejects(lying.get(cid), /wrong bytes/);
  const textCid = await putText(mem, "a passport's worth of text");
  assert.equal(await getText(mem, textCid), "a passport's worth of text");
});

test("job records validate at the sink: malformed ones are refused, other annotations pass, jobsOf groups by id", async () => {
  const ok = (key: string, value: unknown) => validateJobAnnotation(key, value);
  const bad = (key: string, value: unknown, re: RegExp) =>
    assert.throws(() => validateJobAnnotation(key, value), re);
  ok("note", "anything at all");
  ok(JOB_KEYS.request, { id: "j1", kind: "led-frame" });
  ok(JOB_KEYS.result, { id: "j1", value: 3, ms: 0 });
  ok(JOB_KEYS.result, { id: "j1", cid: await contentId(new Uint8Array(1)), bytes: 1, ms: 1.5 });
  ok(JOB_KEYS.audit, { id: "j1", check: "x", passed: true });
  ok(JOB_KEYS.reward, { id: "j1", note: null });
  bad(JOB_KEYS.request, "text", /not an object/);
  bad(JOB_KEYS.request, { id: "", kind: "k" }, /id/);
  bad(JOB_KEYS.request, { id: "j", kind: 7 }, /kind/);
  bad(JOB_KEYS.request, { id: "j", kind: "k", params: [] }, /params/);
  bad(JOB_KEYS.result, { id: "j", ms: -1, value: 1 }, /ms/);
  bad(JOB_KEYS.result, { id: "j", ms: 1 }, /cid or a value/);
  bad(JOB_KEYS.result, { id: "j", ms: 1, cid: "QmNotOurs" }, /content id/);
  bad(JOB_KEYS.audit, { id: "j", check: "", passed: true }, /check/);
  bad(JOB_KEYS.audit, { id: "j", check: "c", passed: "yes" }, /passed/);

  // The sink refuses a malformed record and accepts a good one.
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const g = FlatGrid.fill(1, 1, 1, { sink });
  const bit = g.at(0, 0, 0)!;
  assert.throws(() => bit.annotate(JOB_KEYS.audit, { id: "j", passed: true }), /check/);
  bit.annotate(JOB_KEYS.request, { id: "j", kind: "k" });
  bit.annotate("free", { any: "thing" });
  await sink.flush();
  const rec = new RecordingSink();
  replay(
    await (async () => {
      const { ledgerPath, parseLedger } = await import("../src/scene.ts");
      return parseLedger(await mem.read(ledgerPath(bit.id)));
    })(),
    { sink: rec },
  );
  const jobs = jobsOf(rec.events);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.request?.kind, "k");
  assert.equal(jobs[0]!.result, undefined);
});

function carved(sink?: RecordingSink) {
  const g = FlatGrid.fill(4, 4, 4, {
    emission: { color: 0x1f6feb, light: 0.6 },
    ...(sink ? { sink } : {}),
  });
  for (const b of g.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  g.setPresent(g.at(3, 3, 3)!, false);
  return g;
}

test("fifty jobs on fifty bits through the reference pool: every one ends in an audit; failures leave no reward; big results go to storage by id", async () => {
  const recorder = new RecordingSink();
  const g = carved(recorder);
  const storage = new MemoryStorage();
  const pool = new InProcessPool(g, {
    storage,
    history: () => recorder.events,
    workloads: { ...WORKLOADS, fail: failingWorkload },
  });
  const bits = [...g.bits()].slice(0, 50);
  const kinds = ["led-frame", "epcis", "links"] as const;
  const audits = await pool.runAll(
    bits.map((b, i) => ({ bit: b.id, job: { id: `job-${i}`, kind: kinds[i % 3]! } })),
  );
  assert.equal(audits.length, 50);
  assert.ok(
    audits.every((a) => a.passed),
    JSON.stringify(audits.filter((a) => !a.passed).slice(0, 2)),
  );
  for (const [i, b] of bits.entries()) {
    const jobs = jobsOf(recorder.events.filter((e) => e.bit === b.id));
    const j = jobs.find((x) => x.id === `job-${i}`)!;
    assert.ok(j.request && j.result && j.audit && j.reward, `bit ${i} has all four records`);
    assert.deepEqual(
      [...j.seqs].sort((a, c) => a - c),
      j.seqs,
      "written in order",
    );
    assert.equal(j.result!.worker, "actor:in-process");
    const req = recorder.events.find(
      (e) => e.type === "annotated" && e.key === JOB_KEYS.request && e.bit === b.id,
    )!;
    assert.equal(req.actor, "actor:in-process", "the ledger names the actor");
    assert.match(req.cause!, /^job /);
  }
  // Bytes results go to storage by id, JSON values stay inline.
  const epcisJob = jobsOf(recorder.events.filter((e) => e.bit === bits[1]!.id)).find(
    (x) => x.id === "job-1",
  )!;
  assert.ok(epcisJob.result!.cid && epcisJob.result!.bytes! > 4096, "epcis result stored by id");
  const stored = await storage.get(epcisJob.result!.cid!);
  assert.ok(stored && stored.length === epcisJob.result!.bytes);
  const frameJob = jobsOf(recorder.events.filter((e) => e.bit === bits[0]!.id)).find(
    (x) => x.id === "job-0",
  )!;
  assert.ok(frameJob.result!.cid, "the LED frame's bytes are stored by id too");
  assert.equal(frameJob.result!.bytes, 68 * 3);
  assert.equal((await storage.get(frameJob.result!.cid!))!.length, 68 * 3);
  const linksJob = jobsOf(recorder.events.filter((e) => e.bit === bits[2]!.id)).find(
    (x) => x.id === "job-2",
  )!;
  assert.equal(linksJob.result!.cid, undefined, "a JSON value rides inline");
  assert.equal(typeof (linksJob.result!.value as { checked: number }).checked, "number");

  // A failing check: audit recorded as failed, no reward, the pool keeps going.
  const [failed] = await pool.runAll([{ bit: bits[0]!.id, job: { id: "job-x", kind: "fail" } }]);
  assert.equal(failed!.passed, false);
  const fx = jobsOf(recorder.events.filter((e) => e.bit === bits[0]!.id)).find(
    (x) => x.id === "job-x",
  )!;
  assert.ok(
    fx.audit && !fx.audit.passed && fx.result && !fx.reward,
    "failed audit, result kept, no reward",
  );
  const [unknown] = await pool.runAll([{ bit: bits[0]!.id, job: { id: "job-u", kind: "nope" } }]);
  assert.equal(unknown!.passed, false);
  assert.match(unknown!.detail!, /no workload/);
  // A workload that throws is a failed audit, not a lost job.
  const thrower = new InProcessPool(g, {
    storage,
    workloads: {
      boom: () => {
        throw new Error("kaboom");
      },
    },
  });
  const [boom] = await thrower.runAll([{ bit: bits[2]!.id, job: { id: "job-b", kind: "boom" } }]);
  assert.equal(boom!.passed, false);
  assert.match(boom!.detail!, /kaboom/);
  await assert.rejects(pool.actor("no-such-bit").run({ id: "j", kind: "links" }), /no bit/);

  // The links check can fail: lie to it with a neighbor that does not link back.
  const liar = new InProcessPool(g, {
    storage,
    workloads: {
      links: (bit, job, ctx) =>
        WORKLOADS.links!(bit, job, {
          ...ctx,
          grid: { ...ctx.grid, get: () => undefined } as never,
        }),
    },
  });
  const [lied] = await liar.runAll([{ bit: bits[5]!.id, job: { id: "job-l", kind: "links" } }]);
  assert.equal(lied!.passed, false);
});

test("job events survive the round trip: same digest from memory and pack, and the EPCIS export validates with vpb:job sensor reports", async () => {
  const mem = new MemoryStore();
  const recorder = new RecordingSink();
  const sink = new SceneSink(mem);
  const g = FlatGrid.fill(2, 2, 2, {
    emission: { color: 0x1f6feb, light: 0.6 },
    sink: new TeeSink([recorder, sink]),
  });
  const pool = new InProcessPool(g, {
    storage: new MemoryStorage(),
    history: () => recorder.events,
  });
  const ids = [...g.bits()].map((b) => b.id);
  await pool.runAll(ids.map((bit, i) => ({ bit, job: { id: `j${i}`, kind: "links" } })));
  await sink.flush();
  const before = await sceneDigest(g);
  const { openScene } = await import("../src/scene.ts");
  const fromMem = await openScene(mem);
  const fromPack = await openScene(new PackedStore(await packScene(mem)));
  assert.equal(await sceneDigest(fromMem), before);
  assert.equal(await sceneDigest(fromPack), before);
  const rec = new RecordingSink();
  const { ledgerPath, parseLedger } = await import("../src/scene.ts");
  for (const id of ids) replay(parseLedger(await mem.read(ledgerPath(id))), { sink: rec });
  assert.equal(jobsOf(rec.events).length, ids.length, "every job replays with its records");

  const doc = toEpcisDocument(recorder.events, { now: () => 0 });
  const jobEvents = doc.epcisBody.eventList.filter(
    (e) => typeof e.bizStep === "string" && (e.bizStep as string).includes("bizstep/job-"),
  );
  assert.equal(jobEvents.length, ids.length * 4, "request, result, audit, reward per job");
  const report = (
    jobEvents[0]!.sensorElementList as { sensorReport: { type: string; stringValue: string }[] }[]
  )[0]!.sensorReport[0]!;
  assert.equal(report.type, "vpb:job");
  assert.equal(JSON.parse(report.stringValue).kind, "links");
  const AjvCtor = (require("ajv").default ?? require("ajv")) as new (
    o: object,
  ) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown[] | null } };
  const addFormats = (require("ajv-formats").default ?? require("ajv-formats")) as (
    a: object,
  ) => void;
  const ajv = new AjvCtor({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(require("node:fs").readFileSync("vendor/epcis/epcis-json-schema.json", "utf8")),
  );
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 3)));
});
