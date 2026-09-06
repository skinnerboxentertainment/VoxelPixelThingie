/**
 * The durable backend (PLAN-3.md Phase 15) against a local dev server the
 * test environment downloads and starts, no account involved. The first
 * run fetches the server binary; later runs use the cache.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createActorWorker, DurableActorPool, workflowIdFor } from "../scripts/actor-durable.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { jobsOf } from "../src/jobs.ts";
import { ledgerPath, openScene, parseLedger, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { MemoryStorage } from "../src/storage.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sceneDigest, sealScene } from "../src/verify.ts";

/** A 4x4x4 scene written to a fresh folder, sealed. */
async function sceneFolder(): Promise<{ folder: string; store: NodeFsStore; ids: string[] }> {
  const folder = mkdtempSync(join(tmpdir(), "vpb-durable-"));
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

test("sixty-four actors on the durable backend: every ledger ends with one request, one result, one audit, one reward; the digest survives", async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  const { folder, store, ids } = await sceneFolder();
  const taskQueue = `vpb-test-${process.pid}`;
  const sink = await SceneSink.resume(store);
  const recorder = new RecordingSink();
  const grid = await openScene(store, { attach: new TeeSink([recorder, sink]) });
  const worker = await createActorWorker({
    address: env.address,
    taskQueue,
    host: { grid, recorder, store, sink, storage: new MemoryStorage(), name: "actor:durable-test" },
  });
  const running = worker.run();
  try {
    const pool = new DurableActorPool({ client: env.client, taskQueue });
    const t0 = performance.now();
    const audits = await pool.runAll(
      ids.map((bit, i) => ({ bit, job: { id: `d-${i}`, kind: "links" } })),
      16,
    );
    const ms = performance.now() - t0;
    assert.equal(audits.length, 64);
    assert.ok(
      audits.every((a) => a.passed),
      JSON.stringify(audits.filter((a) => !a.passed)[0]),
    );
    await sink.flush();
    for (const [i, bit] of ids.entries()) {
      const events = parseLedger(await store.read(ledgerPath(bit)));
      const j = jobsOf(events).find((x) => x.id === `d-${i}`)!;
      assert.ok(j.request && j.result && j.audit && j.reward, `bit ${i} has all four records`);
      assert.equal(j.seqs.length, 4, `exactly four records for bit ${i}`);
      assert.equal(j.result!.worker, "actor:durable-test");
      const req = events.find((e) => e.type === "annotated" && e.key === "job:request")!;
      assert.equal(req.actor, "actor:durable-test");
    }
    // Submitting the same job again attaches to the finished workflow and writes nothing new.
    const again = await pool.run(ids[0]!, { id: "d-0", kind: "links" });
    assert.equal(again.passed, true);
    await sink.flush();
    assert.equal((await records(store, ids[0]!, "d-0"))!.seqs.length, 4, "no duplicate records");
    // The scene still opens and digests the same from its folder.
    const before = await sceneDigest(grid);
    assert.equal(await sceneDigest(await openScene(store)), before);
    console.log(
      `  durable: 64 actors, 64 jobs, ${(ms / 1000).toFixed(1)} s on the local dev server`,
    );
  } finally {
    worker.shutdown();
    await running;
    await env.teardown();
  }
});

async function spawnWorker(
  address: string,
  folder: string,
  taskQueue: string,
): Promise<ChildProcess> {
  const proc = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/durable-worker.ts",
      "--scene",
      folder,
      "--address",
      address,
      "--task-queue",
      taskQueue,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  await new Promise<void>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("worker ready")) resolve();
    });
    proc.stderr!.on("data", (c: Buffer) => {
      const s = c.toString();
      if (/error/i.test(s) && !/deprecat/i.test(s))
        process.stderr.write(`[worker] ${s.slice(0, 300)}`);
    });
    proc.on("exit", (code) => reject(new Error(`worker exited early with ${code}`)));
    setTimeout(() => reject(new Error("worker did not become ready in 90 s")), 90_000);
  });
  return proc;
}

test("kill the worker mid-job with SIGKILL; a new worker finishes it exactly once: one request, one result, one audit, one reward", async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  const { folder, store, ids } = await sceneFolder();
  const taskQueue = `vpb-kill-${process.pid}`;
  const bit = ids[5]!;
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = await spawnWorker(env.address, folder, taskQueue);
    const pool = new DurableActorPool({ client: env.client, taskQueue });
    const t0 = performance.now();
    const pending = pool.run(bit, { id: "k-1", kind: "slow", params: { ms: 4000 } });
    pending.catch(() => {});
    // Wait until the request is on disk, so the kill lands inside doWork.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await records(store, bit, "k-1"))?.request)
      await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      (await records(store, bit, "k-1"))?.request,
      "the request was recorded before the kill",
    );
    await new Promise((r) => setTimeout(r, 800));
    first.kill("SIGKILL");
    const killedAt = performance.now();
    second = await spawnWorker(env.address, folder, taskQueue);
    const audit = await pending;
    const finishedAt = performance.now();
    assert.equal(audit.passed, true);
    const j = (await records(store, bit, "k-1"))!;
    assert.ok(j.request && j.result && j.audit && j.reward, "all four records");
    assert.equal(j.seqs.length, 4, "exactly one of each, no duplicate from the retry");
    const handle = env.client.workflow.getHandle(workflowIdFor(bit, "k-1"));
    const desc = await handle.describe();
    assert.equal(desc.status.name, "COMPLETED");
    console.log(
      `  kill-and-restart: request at +${((killedAt - t0) / 1000).toFixed(1)} s, killed, second worker up, completed at +${((finishedAt - t0) / 1000).toFixed(1)} s; ${j.seqs.length} records`,
    );
  } finally {
    first?.kill("SIGKILL");
    second?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    second?.kill("SIGKILL");
    await env.teardown();
  }
});
