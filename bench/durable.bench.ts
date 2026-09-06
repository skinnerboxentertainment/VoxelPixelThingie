/**
 * The Phase 15 count: every bit of a scene folder gets an actor on the
 * durable backend and answers one job. Runs against the test
 * environment's local dev server, no account.
 *
 *   node --experimental-strip-types bench/durable.bench.ts <scene folder> [kind=links]
 */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createActorWorker, DurableActorPool } from "../scripts/actor-durable.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { jobsOf } from "../src/jobs.ts";
import { ledgerPath, openScene, parseLedger, readManifest, SceneSink } from "../src/scene.ts";
import { FolderStorage } from "../src/storage-node.ts";
import { NodeFsStore } from "../src/store-node.ts";

const [folder, kind = "links"] = process.argv.slice(2);
if (!folder) {
  console.error("usage: durable.bench <scene folder> [kind]");
  process.exit(2);
}
const env = await TestWorkflowEnvironment.createLocal();
const store = new NodeFsStore(folder);
const manifest = (await readManifest(store))!;
const sink = await SceneSink.resume(store);
const recorder = new RecordingSink();
const t0 = performance.now();
const grid = await openScene(store, { attach: new TeeSink([recorder, sink]) });
const opened = performance.now() - t0;
const taskQueue = `vpb-bench-${process.pid}`;
const worker = await createActorWorker({
  address: env.address,
  taskQueue,
  host: { grid, recorder, store, sink, storage: new FolderStorage(`${folder}/results`) },
});
const running = worker.run();
// Destroyed bits have no actor to host: the scene's live bits are the actors.
const ids = [...grid.bits()].map((b) => b.id);
const destroyed = (manifest.ids?.length ?? ids.length) - ids.length;
const pool = new DurableActorPool({ client: env.client, taskQueue });
const t1 = performance.now();
const audits = await pool.runAll(
  ids.map((bit, i) => ({ bit, job: { id: `bench-${i}`, kind } })),
  32,
);
const ran = performance.now() - t1;
await sink.flush();
let complete = 0;
for (const [i, bit] of ids.entries()) {
  const j = jobsOf(parseLedger(await store.read(ledgerPath(bit)))).find(
    (x) => x.id === `bench-${i}`,
  );
  if (j?.request && j.result && j.audit && j.seqs.length === (j.audit.passed ? 4 : 3)) complete++;
}
console.log(
  `${ids.length} actors replayed from ${folder} in ${opened.toFixed(0)} ms (${destroyed} destroyed bits have no actor); ${audits.length} ${kind} jobs in ${(ran / 1000).toFixed(1)} s, ${audits.filter((a) => a.passed).length} passed; ${complete} ledgers with exactly one record per step`,
);
worker.shutdown();
await running;
await env.teardown();
