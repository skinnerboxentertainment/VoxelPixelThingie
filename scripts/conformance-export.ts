/**
 * The conformance kit as fixtures (PLAN-4.md Phase 25, ADR 0018): what
 * counts as a correct bit, written as inputs and expected answers any
 * language can read. The TypeScript implementation writes them; the
 * TypeScript runner (tests/conformance/kit.test.ts) and the Python
 * implementation (kit/python) read them.
 *
 *   npm run conformance:export [-- <out dir>]
 *
 * Tier 1: packed scenes with the expected state digest, snapshot, seal and
 * signature verdicts. Tier 2: operation scripts with deterministic ids
 * and a fixed clock, the expected events, state, and link counts. Tier 3:
 * render flags and the full scene digest for a camera; the TypeScript
 * runner checks it, a second implementation may skip it.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildDidDocument, type DidDocument, frameDid } from "../src/did.ts";
import { type BitEvent, RecordingSink, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import type { JsonObject } from "../src/json.ts";
import { generateKeyPair } from "../src/keys.ts";
import { packScene, type ScenePack } from "../src/pack.ts";
import { readManifest, SceneSink } from "../src/scene.ts";
import {
  ALL_SLOTS,
  EDGE_SLOTS,
  kindOf,
  linkOffsets,
  NODE_COUNT,
  partnerSlot,
  signsOf,
  VERTEX_SLOTS,
} from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { type Camera, type Emission, type Vec3 } from "../src/vpb.ts";
import { sceneDigest, sealScene, stateCanonical, stateDigest, verifyScene } from "../src/verify.ts";

export const KIT_FORMAT = "vpb-conformance/1";

export interface Tier1Expected {
  stateDigest: string;
  sceneDigest: string;
  camera: Camera;
  bits: number;
  present: number;
  state: ReturnType<typeof stateCanonical>;
  seal: { ok: boolean; mismatches: { id: string; file: string }[] };
  signature: { state: string; did?: string };
}

export type Op =
  | { op: "add"; id: string; position: Vec3; color?: number; emission?: Emission }
  | { op: "emit"; id: string; slot: number; emission: Emission }
  | { op: "emitAll"; id: string; slots: number[]; emission: Emission }
  | { op: "setPresent"; id: string; present: boolean }
  | { op: "move"; id: string; to: Vec3 }
  | { op: "setPassport"; id: string; passport: JsonObject }
  | { op: "annotate"; id: string; key: string; value: unknown }
  | { op: "remove"; id: string }
  | { op: "wrangle"; actor?: string; cause?: string; ops: Op[] };

export interface Tier2Case {
  scene: string;
  clock: { start: number; step: number };
  ops: Op[];
  expected: {
    events: BitEvent[];
    state: ReturnType<typeof stateCanonical>;
    stateDigest: string;
    linkCounts: Record<string, number[]>;
  };
}

/** The slot tables as data: signs, kinds, and for each neighbor offset the partner slot per slot. */
export function slotTables() {
  const offsets: { offset: Vec3; partners: number[] }[] = [];
  for (const dz of [-1, 0, 1])
    for (const dy of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) {
        if (!dx && !dy && !dz) continue;
        const o: Vec3 = [dx, dy, dz];
        offsets.push({ offset: o, partners: ALL_SLOTS.map((s) => partnerSlot(s, o) ?? -1) });
      }
  return {
    nodeCount: NODE_COUNT,
    slots: ALL_SLOTS.map((s) => ({
      slot: s,
      kind: kindOf(s),
      signs: signsOf(s).map((x) => (x === null ? null : x)),
      linkOffsets: linkOffsets(s).map((o) => [...o]),
    })),
    offsets,
  };
}

const CAMERA: Camera = { position: [20, 10, 30] };

function clock(start = 1_700_000_000_000, step = 1000) {
  let n = 0;
  return () => start + step * n++;
}

function minter(prefix: string) {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, "0")}`;
}

/** The 4³ reference with a 3³ corner carved, a passport, and an absent bit, deterministic. */
async function referenceStore(): Promise<{ mem: MemoryStore; grid: FlatGrid }> {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem, { now: clock() });
  const grid = new FlatGrid({ id: "kit-reference-4", mintId: minter("bit"), sink, now: clock() });
  for (let z = 0; z < 4; z++)
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const b = grid.add([x, y, z], { emission: { color: 0x1f6feb, light: 0.6 } });
        b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
        b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
      }
  for (let z = 1; z < 4; z++) for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) grid.remove([x, y, z]);
  grid.wrangle({ actor: "kit", cause: "label" }, () => {
    grid.at(0, 0, 0)!.setPassport({ name: "origin", tags: ["first"], n: 1 });
    grid.at(1, 0, 0)!.emit(0, { data: { tag: "seam" } });
    grid.setPresent(grid.at(2, 0, 0)!, false);
  });
  await sink.flush();
  return { mem, grid };
}

async function tier1(out: string): Promise<string[]> {
  const names: string[] = [];
  const write = async (name: string, pack: ScenePack, expected: Tier1Expected, doc?: DidDocument) => {
    const dir = join(out, "tier1", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "pack.json"), `${JSON.stringify(pack)}\n`, "utf8");
    await fs.writeFile(join(dir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`, "utf8");
    if (doc) await fs.writeFile(join(dir, "did.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    names.push(name);
  };
  const expect = async (mem: MemoryStore, grid: FlatGrid, doc?: DidDocument): Promise<Tier1Expected> => {
    const v = await verifyScene(mem, doc ? { resolve: async () => doc } : {});
    return {
      stateDigest: await stateDigest(grid),
      sceneDigest: await sceneDigest(grid, CAMERA),
      camera: CAMERA,
      bits: grid.snapshot().length,
      present: grid.snapshot().filter((r) => r.present).length,
      state: stateCanonical(grid),
      seal: { ok: v.ok, mismatches: v.mismatches },
      signature: { state: v.signature, ...(v.did ? { did: v.did } : {}) },
    };
  };

  // Unsigned, sealed.
  const a = await referenceStore();
  await sealScene(a.mem);
  await write("reference-4", await packScene(a.mem), await expect(a.mem, a.grid));

  // Signed with a throwaway key; the document travels with the fixture.
  const b = await referenceStore();
  const key = await generateKeyPair();
  const did = frameDid("kit.example.invalid", "", b.grid.id);
  await sealScene(b.mem, { did, privateKey: key.privateKey });
  const doc = await buildDidDocument(did, key.publicKey);
  await write("reference-4-signed", await packScene(b.mem), await expect(b.mem, b.grid, doc), doc);

  // Forged: the manifest's hashes rewritten to match a changed ledger; the signature no longer matches.
  const c = await packScene(b.mem);
  const victim = Object.keys(c.bits).sort()[0]!;
  const forgedLedger = `${c.bits[victim]!.events}${JSON.stringify({ forged: true })}\n`;
  const forgedStore = new MemoryStore();
  const { sha256Hex } = await import("../src/verify.ts");
  const forgedManifest = { ...c.manifest, hashes: { ...c.manifest.hashes! } };
  forgedManifest.hashes[victim] = { ...forgedManifest.hashes[victim]!, events: await sha256Hex(forgedLedger) };
  await forgedStore.write("manifest.json", `${JSON.stringify(forgedManifest, null, 2)}\n`);
  for (const [id, bit] of Object.entries(c.bits)) {
    await forgedStore.write(`bits/${id}/passport.json`, bit.passport ?? "");
    await forgedStore.write(`bits/${id}/events.jsonl`, id === victim ? forgedLedger : (bit.events ?? ""));
  }
  const forgedPack = await packScene(forgedStore);
  const forgedV = await verifyScene(forgedStore, { resolve: async () => doc });
  await write(
    "reference-4-forged",
    forgedPack,
    {
      ...(await expect(b.mem, b.grid, doc)),
      seal: { ok: forgedV.ok, mismatches: forgedV.mismatches },
      signature: { state: forgedV.signature, did },
    },
    doc,
  );

  // Tampered: one digit of one ledger changed, the manifest untouched.
  const t = await packScene(a.mem);
  const tv = Object.keys(t.bits).sort()[1]!;
  const events = t.bits[tv]!.events!;
  const m = /"time":(\d)/.exec(events)!;
  t.bits[tv]!.events = `${events.slice(0, m.index + 7)}${(Number(m[1]) + 1) % 10}${events.slice(m.index + 8)}`;
  const tampStore = new MemoryStore();
  const { unpackScene } = await import("../src/pack.ts");
  await unpackScene(t, tampStore);
  const tampV = await verifyScene(tampStore);
  await write("reference-4-tampered", t, {
    ...(await expect(a.mem, a.grid)),
    seal: { ok: tampV.ok, mismatches: tampV.mismatches },
    signature: { state: tampV.signature },
  });
  return names;
}

function runOps(grid: FlatGrid, ops: Op[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "add":
        grid.add(op.position, {
          id: op.id,
          ...(op.color !== undefined ? { color: op.color } : {}),
          ...(op.emission ? { emission: op.emission } : {}),
        });
        break;
      case "emit":
        grid.get(op.id)!.emit(op.slot, op.emission);
        break;
      case "emitAll":
        grid.get(op.id)!.emitAll(op.slots, op.emission);
        break;
      case "setPresent":
        grid.setPresent(grid.get(op.id)!, op.present);
        break;
      case "move":
        grid.move(grid.get(op.id)!, op.to);
        break;
      case "setPassport":
        grid.get(op.id)!.setPassport(op.passport);
        break;
      case "annotate":
        grid.get(op.id)!.annotate(op.key, op.value);
        break;
      case "remove":
        grid.remove(grid.get(op.id)!);
        break;
      case "wrangle":
        grid.wrangle(
          { ...(op.actor !== undefined ? { actor: op.actor } : {}), ...(op.cause !== undefined ? { cause: op.cause } : {}) },
          () => runOps(grid, op.ops),
        );
        break;
    }
  }
}

/** Run a tier 2 script the way the fixtures expect it to be run. Exported for the runner. */
export function runTier2(c: Omit<Tier2Case, "expected">): Tier2Case["expected"] {
  const recorder = new RecordingSink();
  let n = 0;
  const grid = new FlatGrid({
    id: c.scene,
    sink: new TeeSink([recorder]),
    now: () => c.clock.start + c.clock.step * n++,
  });
  runOps(grid, c.ops);
  const linkCounts: Record<string, number[]> = {};
  for (const r of grid.snapshot()) linkCounts[r.id] = r.links.map((l) => l.length);
  return {
    events: recorder.events,
    state: stateCanonical(grid),
    stateDigest: "",
    linkCounts,
  };
}

async function tier2(out: string): Promise<string[]> {
  const dir = join(out, "tier2");
  await fs.mkdir(dir, { recursive: true });
  const id = (n: number) => `bit-${String(n).padStart(4, "0")}`;
  const cases: Record<string, Omit<Tier2Case, "expected">> = {};
  // A 3³ filled with seams and beads, one carved, one absent then back, one moved, one labelled.
  const ops: Op[] = [];
  let n = 0;
  for (let z = 0; z < 3; z++)
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) {
        const b = id(++n);
        ops.push({ op: "add", id: b, position: [x, y, z], emission: { color: 0x1f6feb, light: 0.6 } });
        ops.push({ op: "emitAll", id: b, slots: [...EDGE_SLOTS], emission: { color: 0x58a6ff, light: 1 } });
        ops.push({ op: "emitAll", id: b, slots: [...VERTEX_SLOTS], emission: { color: 0xffffff, light: 1 } });
      }
  ops.push({
    op: "wrangle",
    actor: "kit",
    cause: "carve",
    ops: [
      { op: "remove", id: id(14) }, // the center
      { op: "setPresent", id: id(1), present: false },
      { op: "setPresent", id: id(1), present: true },
      { op: "move", id: id(27), to: [5, 5, 5] },
      { op: "setPassport", id: id(2), passport: { name: "two", nested: { a: [1, null, "x"] }, f: 0.5 } },
      { op: "annotate", id: id(2), key: "note", value: { seen: true } },
      { op: "emit", id: id(3), slot: 1, emission: { color: 0xff0000, light: 0.25, data: { tag: "seam" } } },
    ],
  });
  cases.carve = { scene: "kit-carve", clock: { start: 1_700_000_000_000, step: 1000 }, ops };
  // Presence and links alone: two bits, one toggled.
  cases.presence = {
    scene: "kit-presence",
    clock: { start: 1_700_000_100_000, step: 1 },
    ops: [
      { op: "add", id: id(1), position: [0, 0, 0], color: 0x112233 },
      { op: "add", id: id(2), position: [1, 0, 0] },
      { op: "add", id: id(3), position: [1, 1, 0] },
      { op: "setPresent", id: id(2), present: false },
      { op: "emit", id: id(1), slot: 0, emission: { light: 1 } },
      { op: "setPresent", id: id(2), present: true },
      { op: "remove", id: id(3) },
    ],
  };
  const names: string[] = [];
  for (const [name, c] of Object.entries(cases)) {
    const expected = runTier2(c);
    let n2 = 0;
    const grid = new FlatGrid({ id: c.scene, now: () => c.clock.start + c.clock.step * n2++ });
    runOps(grid, c.ops);
    expected.stateDigest = await stateDigest(grid);
    await fs.writeFile(join(dir, `${name}.json`), `${JSON.stringify({ ...c, expected }, null, 2)}\n`, "utf8");
    names.push(name);
  }
  return names;
}

async function tier3(out: string): Promise<string[]> {
  const dir = join(out, "tier3");
  await fs.mkdir(dir, { recursive: true });
  // A fresh grid per camera, as a runner opens one: flags from an earlier camera must not carry over.
  const { mem } = await referenceStore();
  await sealScene(mem);
  const { PackedStore } = await import("../src/pack.ts");
  const { openScene } = await import("../src/scene.ts");
  const pack = await packScene(mem);
  const cameras: Record<string, Camera> = {
    default: CAMERA,
    "straight-down": { position: [1.5, 1.5, 100], towardCamera: [0, 0, 1] },
    corner: { position: [-8, -6, -7] },
  };
  const names: string[] = [];
  for (const [name, camera] of Object.entries(cameras)) {
    const grid = await openScene(new PackedStore(pack));
    grid.evaluate(camera);
    const renderCycle: Record<string, boolean> = {};
    const renderEnabled: Record<string, boolean[]> = {};
    for (const r of grid.snapshot()) {
      renderCycle[r.id] = r.renderCycle;
      renderEnabled[r.id] = r.renderEnabled;
    }
    await fs.writeFile(
      join(dir, `${name}.json`),
      `${JSON.stringify({ pack: "tier1/reference-4/pack.json", camera, expected: { sceneDigest: await sceneDigest(grid, camera), renderCycle, renderEnabled } }, null, 2)}\n`,
      "utf8",
    );
    names.push(name);
  }
  return names;
}

export async function exportKit(out: string): Promise<void> {
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(join(out, "slots.json"), `${JSON.stringify(slotTables(), null, 2)}\n`, "utf8");
  const t1 = await tier1(out);
  const t2 = await tier2(out);
  const t3 = await tier3(out);
  const manifest = {
    format: KIT_FORMAT,
    tiers: {
      "1": { name: "replay, state digest, seal, signature", cases: t1 },
      "2": { name: "container operations, events, links", cases: t2 },
      "3": { name: "render self-tests for a camera, scene digest", cases: t3 },
    },
    canonical: {
      state: "JSON.stringify({ scene, bits }) with bits sorted by id, each { id, position, present, color, passport, emissions, links }",
      hash: "SHA-256, lowercase hex, over the UTF-8 of the canonical text",
    },
  };
  await fs.writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (process.argv[1] && /conformance-export\.ts$/.test(process.argv[1])) {
  const out = process.argv[2] ?? "conformance";
  await exportKit(out);
  const manifest = JSON.parse(await fs.readFile(join(out, "manifest.json"), "utf8")) as { tiers: Record<string, { cases: string[] }> };
  console.log(
    `wrote ${out}: ${Object.entries(manifest.tiers)
      .map(([t, v]) => `tier ${t} ${v.cases.length} case(s)`)
      .join(", ")}`,
  );
  const m = await readManifest(new MemoryStore());
  void m;
}
