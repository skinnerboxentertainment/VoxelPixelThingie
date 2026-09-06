/**
 * A container as a body (ADR 0011). Opt in with VPB_DOCKER=1: builds the
 * worker image, runs the engine and workers as containers, and repeats the
 * Phase 15 oracles through Docker. Skipped otherwise, and says so.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, Connection } from "@temporalio/client";
import { DurableActorPool, workflowIdFor } from "../scripts/actor-durable.ts";
import {
  buildImage,
  dockerAvailable,
  killWorker,
  startEngine,
  startWorker,
  stopWorker,
} from "../scripts/docker-host.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { jobsOf } from "../src/jobs.ts";
import { ledgerPath, parseLedger, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sealScene } from "../src/verify.ts";

const optIn = process.env.VPB_DOCKER === "1";

async function sceneFolder() {
  const folder = mkdtempSync(join(tmpdir(), "vpb-docker-"));
  const store = new NodeFsStore(folder);
  const sink = new SceneSink(store);
  const g = FlatGrid.fill(4, 4, 4, { emission: { color: 0x1f6feb, light: 0.6 }, sink });
  for (const b of g.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  await sink.flush();
  await sealScene(store);
  return { folder, store, ids: [...g.bits()].map((b) => b.id) };
}

const records = async (store: NodeFsStore, bitId: string, jobId: string) =>
  jobsOf(parseLedger(await store.read(ledgerPath(bitId)))).find((j) => j.id === jobId);

async function clientFor(address: string): Promise<Client> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const connection = await Connection.connect({ address });
      return new Client({ connection });
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}

test("through Docker: sixty-four jobs on a worker container, then a container killed mid-job and its successor finishing once", {
  skip: !optIn && "set VPB_DOCKER=1 to run the container oracles",
}, async (t) => {
  assert.ok(await dockerAvailable(), "docker is available");
  const built = await buildImage();
  const engine = await startEngine();
  const client = await clientFor(engine.address);
  const { folder, store, ids } = await sceneFolder();
  const taskQueue = `vpb-docker-${process.pid}`;
  let a: string | undefined;
  let b: string | undefined;
  try {
    const tw = performance.now();
    a = (await startWorker({ scene: folder, taskQueue, name: `vpb-worker-a-${process.pid}` })).name;
    const workerUp = performance.now() - tw;
    const pool = new DurableActorPool({ client, taskQueue });

    const t0 = performance.now();
    const audits = await pool.runAll(
      ids.map((bit, i) => ({ bit, job: { id: `c-${i}`, kind: "links" } })),
      16,
    );
    const ran = performance.now() - t0;
    assert.equal(audits.length, 64);
    assert.ok(audits.every((x) => x.passed));
    for (const [i, bit] of ids.entries()) {
      const j = (await records(store, bit, `c-${i}`))!;
      assert.equal(j.seqs.length, 4, `bit ${i}: exactly one record per step`);
    }

    // Kill the container inside a slow job; a second container finishes it once.
    const bit = ids[9]!;
    const pending = pool.run(bit, { id: "ck-1", kind: "slow", params: { ms: 6000 } });
    pending.catch(() => {});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await records(store, bit, "ck-1"))?.request)
      await new Promise((r) => setTimeout(r, 200));
    assert.ok((await records(store, bit, "ck-1"))?.request, "request recorded before the kill");
    await new Promise((r) => setTimeout(r, 1000));
    const tk = performance.now();
    await killWorker(a);
    a = undefined;
    b = (await startWorker({ scene: folder, taskQueue, name: `vpb-worker-b-${process.pid}` })).name;
    const audit = await pending;
    const recovered = performance.now() - tk;
    assert.equal(audit.passed, true);
    const j = (await records(store, bit, "ck-1"))!;
    assert.equal(j.seqs.length, 4, "exactly one of each record after the kill");
    assert.equal(
      (await client.workflow.getHandle(workflowIdFor(bit, "ck-1")).describe()).status.name,
      "COMPLETED",
    );
    t.diagnostic(
      `docker: image built in ${(built / 1000).toFixed(1)} s; worker ready in ${(workerUp / 1000).toFixed(1)} s; 64 jobs in ${(ran / 1000).toFixed(1)} s; killed container, successor finished the job ${(recovered / 1000).toFixed(1)} s after the kill`,
    );
    console.log(
      `  docker: image ${(built / 1000).toFixed(1)} s, worker ready ${(workerUp / 1000).toFixed(1)} s, 64 jobs ${(ran / 1000).toFixed(1)} s, kill to done ${(recovered / 1000).toFixed(1)} s`,
    );
  } finally {
    if (a) await stopWorker(a);
    if (b) await stopWorker(b);
    await client.connection.close();
  }
});
