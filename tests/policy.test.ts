/**
 * The policy a bit carries (PLAN-4.md Phase 19, ADR 0014, SPEC.md §9.8):
 * the vocabulary, refusal at the sink before the container applies,
 * refusal records in the ledger, the pool turning a refused request into
 * a failed audit, replay's exemption, and the digest across stores with
 * refusals in the history.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toOdrl } from "../scripts/export-policy.ts";
import { InProcessPool } from "../src/actor.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { JOB_KEYS, jobsOf } from "../src/jobs.ts";
import type { JsonObject } from "../src/json.ts";
import { PackedStore, packScene } from "../src/pack.ts";
import {
  isAgent,
  judge,
  matchesActor,
  type Policy,
  PolicyError,
  policyOf,
  REFUSED_KEY,
} from "../src/policy.ts";
import { ledgerPath, openScene, parseLedger, SceneSink } from "../src/scene.ts";
import { MemoryStorage } from "../src/storage.ts";
import { MemoryStore } from "../src/store.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sceneDigest } from "../src/verify.ts";

const ev = (over: Record<string, unknown>) =>
  ({ bit: "b", seq: 1, time: 0, frame: "f", ...over }) as Parameters<typeof judge>[1];

test("vocabulary: policyOf validates, matching is exact or prefix, agents are named by prefix, judge applies the rules in order", () => {
  assert.equal(policyOf({}), undefined);
  assert.equal(policyOf(undefined), undefined);
  assert.throws(() => policyOf({ policy: "no" }), /not an object/);
  assert.throws(() => policyOf({ policy: { version: 2 } }), /version/);
  assert.throws(() => policyOf({ policy: { version: 1, work: "links" } }), /work/);
  assert.throws(() => policyOf({ policy: { version: 1, actors: { allow: [1] } } }), /allow/);
  const p: Policy = {
    version: 1,
    controllers: ["oscar"],
    actors: { allow: ["oscar", "mcp:*"], deny: ["mcp:evil"] },
    agents: true,
    work: ["links"],
  };
  assert.deepEqual(policyOf({ policy: p } as unknown as JsonObject), p);
  assert.equal(matchesActor("mcp:*", "mcp:claude"), true);
  assert.equal(matchesActor("mcp:*", "actor:x"), false);
  assert.equal(matchesActor("oscar", "oscar"), true);
  assert.equal(matchesActor("oscar", undefined), false);
  assert.equal(isAgent("mcp:claude"), true);
  assert.equal(isAgent("actor:in-process"), true);
  assert.equal(isAgent("oscar"), false);
  assert.equal(isAgent(undefined), false);

  assert.equal(judge(undefined, ev({ type: "emitted", actor: "anyone" })), undefined);
  assert.equal(judge(p, ev({ type: "emitted", actor: "oscar" })), undefined);
  assert.equal(judge(p, ev({ type: "emitted", actor: "mcp:claude" })), undefined);
  assert.match(judge(p, ev({ type: "emitted", actor: "mcp:evil" }))!.rule, /deny/);
  assert.match(
    judge(p, ev({ type: "emitted", actor: "someone" }))!.rule,
    /allow does not include someone/,
  );
  assert.match(judge(p, ev({ type: "emitted" }))!.rule, /anonymous/);
  assert.match(
    judge(p, ev({ type: "passport", passport: {}, actor: "mcp:claude" }))!.rule,
    /controllers/,
  );
  assert.equal(judge(p, ev({ type: "passport", passport: {}, actor: "oscar" })), undefined);
  const req = (kind: string) =>
    ev({ type: "annotated", key: JOB_KEYS.request, value: { id: "j", kind }, actor: "mcp:claude" });
  assert.equal(judge(p, req("links")), undefined);
  assert.match(judge(p, req("led-frame"))!.rule, /work does not include led-frame/);
  assert.equal(
    judge({ version: 1, agents: false }, ev({ type: "emitted", actor: "mcp:x" }))!.rule,
    "agents: false",
  );
  assert.equal(
    judge({ version: 1, agents: false }, ev({ type: "emitted", actor: "oscar" })),
    undefined,
  );
  // Exempt: replay, the policy's own records, and link bookkeeping.
  assert.equal(
    judge({ version: 1, actors: { allow: ["nobody"] } }, ev({ type: "emitted", actor: "replay" })),
    undefined,
  );
  assert.equal(
    judge(
      { version: 1, actors: { allow: ["nobody"] } },
      ev({ type: "linked", neighbor: "n", slot: 0, partner: 1, offset: [1, 0, 0], actor: "x" }),
    ),
    undefined,
  );
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

test("at the sink: a refused emit changes nothing, lands as policy:refused with the agent named, and the next event takes the next seq", async () => {
  const { mem, sink, recorder, grid } = await scene();
  const bit = grid.at(0, 0, 0)!;
  grid.wrangle({ actor: "oscar" }, () =>
    bit.setPassport({ name: "guarded", policy: { version: 1, agents: false } }),
  );
  assert.deepEqual(sink.policyOf(bit.id), { version: 1, agents: false });
  const before = bit.emissionOf(0);
  const seqBefore = recorder.events.at(-1)!.seq;
  assert.throws(
    () =>
      grid.wrangle({ actor: "mcp:claude", cause: "paint" }, () => bit.emit(0, { color: 0xff0000 })),
    (err: unknown) =>
      err instanceof PolicyError && err.bit === bit.id && err.refusal.rule === "agents: false",
  );
  assert.deepEqual(bit.emissionOf(0), before, "the container never applied the refused change");
  await sink.flush();
  const ledger = parseLedger(await mem.read(ledgerPath(bit.id)));
  const refused = ledger.at(-1)!;
  assert.equal(refused.type, "annotated");
  assert.equal((refused as { key: string }).key, REFUSED_KEY);
  assert.equal(refused.actor, "policy");
  assert.equal(refused.cause, "paint");
  assert.deepEqual((refused as { value: unknown }).value, {
    actor: "mcp:claude",
    type: "emitted",
    rule: "agents: false",
  });
  assert.equal(refused.seq, seqBefore + 1, "the refusal takes the refused event's seq");
  // A person is still allowed, and takes the seq after the refusal.
  grid.wrangle({ actor: "oscar" }, () => bit.emit(0, { color: 0xff0000 }));
  assert.equal(recorder.events.at(-1)!.seq, seqBefore + 2);
  assert.equal(bit.emissionOf(0).color, 0xff0000);
  // Nobody but the policy writes policy:refused.
  assert.throws(
    () =>
      grid.wrangle({ actor: "mcp:claude" }, () =>
        bit.annotate(REFUSED_KEY, { type: "emitted", rule: "x" }),
      ),
    /written by the policy/,
  );
  // A malformed policy never lands.
  assert.throws(
    () => grid.wrangle({ actor: "oscar" }, () => bit.setPassport({ policy: { version: 9 } })),
    /version/,
  );
  assert.deepEqual(bit.passport, { name: "guarded", policy: { version: 1, agents: false } });
});

test("controllers: only they replace the passport, the policy included; a batch judges by the policy set earlier in the same tick", async () => {
  const { sink, grid } = await scene();
  const bit = grid.at(1, 0, 0)!;
  grid.wrangle({ actor: "oscar" }, () => {
    bit.setPassport({ policy: { version: 1, controllers: ["oscar"] } });
    // Same tick, before any flush: the sink already knows the policy.
    assert.throws(
      () =>
        grid.wrangle({ actor: "mcp:claude" }, () => bit.setPassport({ policy: { version: 1 } })),
      /controllers does not include mcp:claude/,
    );
  });
  assert.deepEqual(bit.passport, { policy: { version: 1, controllers: ["oscar"] } });
  grid.wrangle({ actor: "oscar" }, () => bit.setPassport({ open: true }));
  assert.deepEqual(bit.passport, { open: true });
  await sink.flush();
  assert.equal(sink.policyOf(bit.id), undefined, "the policy was dropped with the passport");
  grid.wrangle({ actor: "mcp:claude" }, () => bit.emit(1, { light: 0.1 }));
});

test("work: the pool turns a refused request into a failed audit naming the rule, with no result; an allowed kind runs", async () => {
  const { mem, sink, recorder, grid } = await scene();
  const bit = grid.at(0, 1, 0)!;
  grid.wrangle({ actor: "oscar" }, () =>
    bit.setPassport({ policy: { version: 1, work: ["links"] } }),
  );
  const pool = new InProcessPool(grid, {
    storage: new MemoryStorage(),
    history: () => recorder.events,
  });
  const refused = await pool.actor(bit.id).run({ id: "j1", kind: "led-frame" });
  assert.equal(refused.passed, false);
  assert.equal(refused.check, "policy allows the work");
  assert.match(refused.detail!, /work does not include led-frame/);
  const allowed = await pool.actor(bit.id).run({ id: "j2", kind: "links" });
  assert.equal(allowed.passed, true);
  await sink.flush();
  const jobs = jobsOf(parseLedger(await mem.read(ledgerPath(bit.id))));
  const j1 = jobs.find((j) => j.id === "j1")!;
  assert.equal(j1.request, undefined, "the request never landed");
  assert.equal(j1.result, undefined, "no result was stored");
  assert.equal(j1.audit?.passed, false);
  assert.equal(jobs.find((j) => j.id === "j2")!.seqs.length, 4);
  const ledger = parseLedger(await mem.read(ledgerPath(bit.id)));
  assert.ok(
    ledger.some(
      (e) =>
        e.type === "annotated" &&
        e.key === REFUSED_KEY &&
        (e.value as { key?: string }).key === JOB_KEYS.request,
    ),
  );
  // An agent shut out entirely cannot even write the audit: the error propagates.
  grid.wrangle({ actor: "oscar" }, () =>
    bit.setPassport({ policy: { version: 1, agents: false } }),
  );
  await assert.rejects(pool.actor(bit.id).run({ id: "j3", kind: "links" }), PolicyError);
});

test("replay is exempt: a scene whose policy would refuse its own history replays; the digest holds across memory, folder, and pack with refusals in the ledger", async () => {
  const { mem, sink, grid } = await scene();
  const bit = grid.at(1, 1, 0)!;
  grid.wrangle({ actor: "mcp:agent" }, () => bit.emit(2, { color: 0x00ff00 }));
  grid.wrangle({ actor: "oscar" }, () =>
    bit.setPassport({ policy: { version: 1, agents: false, actors: { allow: ["oscar"] } } }),
  );
  assert.throws(
    () => grid.wrangle({ actor: "mcp:agent" }, () => bit.emit(3, { color: 1 })),
    PolicyError,
  );
  await sink.flush();
  const memGrid = await openScene(mem);
  const digest = await sceneDigest(memGrid);
  assert.equal(
    memGrid.get(bit.id)!.emissionOf(2).color,
    0x00ff00,
    "the agent's earlier change replayed under the tightened policy",
  );
  const folder = mkdtempSync(join(tmpdir(), "vpb-policy-"));
  const fsStore = new NodeFsStore(folder);
  const pack = await packScene(mem);
  for (const [id, b] of Object.entries(pack.bits)) {
    await fsStore.write(`bits/${id}/passport.json`, b.passport ?? "");
    await fsStore.write(ledgerPath(id), b.events ?? "");
  }
  await fsStore.write("manifest.json", JSON.stringify(pack.manifest));
  assert.equal(await sceneDigest(await openScene(fsStore)), digest);
  assert.equal(await sceneDigest(await openScene(new PackedStore(pack))), digest);
  // Resumed: the sink knows the policy from the passports.
  const resumed = await SceneSink.resume(mem);
  assert.deepEqual(resumed.policyOf(bit.id), {
    version: 1,
    agents: false,
    actors: { allow: ["oscar"] },
  });
  const again = await openScene(mem, { attach: resumed });
  assert.throws(
    () => again.wrangle({ actor: "mcp:agent" }, () => again.get(bit.id)!.emit(3, { color: 1 })),
    PolicyError,
  );
});

test("odrl: the enforced form renders one to one; an absent policy is an empty set", () => {
  const bit = "https://example.org/ns/bit/b1";
  const empty = toOdrl(bit, undefined);
  assert.equal(empty["@type"], "Set");
  assert.deepEqual(empty.permission, []);
  assert.deepEqual(empty.prohibition, []);
  const odrl = toOdrl(bit, {
    version: 1,
    controllers: ["oscar"],
    actors: { allow: ["oscar", "mcp:*"], deny: ["mcp:evil"] },
    agents: false,
    work: ["links", "epcis"],
  });
  assert.equal(odrl.uid, `${bit}#policy`);
  assert.equal(odrl.permission.length, 4, "one controller, two allows, one work rule");
  assert.equal(odrl.prohibition.length, 2, "one deny, one agents prohibition");
  assert.equal(odrl.permission[0]!.action, "modify");
  assert.equal(odrl.permission[0]!.target, `${bit}/passport`);
  assert.ok(odrl.permission[2]!.assignee!.endsWith("actor/mcp%3A*"));
  assert.deepEqual(odrl.permission[3]!.constraint, [
    { leftOperand: "vpb:kind", operator: "isAnyOf", rightOperand: ["links", "epcis"] },
  ]);
  assert.ok(odrl.prohibition[1]!.assignee!.endsWith("/agents"));
  assert.equal(JSON.parse(JSON.stringify(odrl))["@context"][0], "http://www.w3.org/ns/odrl.jsonld");
});
