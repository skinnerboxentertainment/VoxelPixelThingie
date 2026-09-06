/**
 * Ask a bit for work and watch the audit land (PLAN-3.md Phase 12).
 *
 *   npm run job:drive -- <folder> [--bit <id|first>] [--kind led-frame|epcis|links] [--results <folder>]
 *
 * Opens the scene folder for writing, runs the job through the in-process
 * actor pool, stores a big result under <folder>/results by content id,
 * and prints the four records as they now stand in the bit's ledger.
 */
import { join } from "node:path";
import { InProcessPool } from "../src/actor.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { jobsOf } from "../src/jobs.ts";
import { ledgerPath, openScene, parseLedger, SceneSink } from "../src/scene.ts";
import { FolderStorage } from "../src/storage-node.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { uuidv7 } from "../src/uuid.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const folder = args[0];
if (!folder || folder.startsWith("--")) {
  console.error("usage: job-drive <folder> [--bit <id|first>] [--kind led-frame|epcis|links] [--results <folder>]");
  process.exit(2);
}
const kind = flag("kind") ?? "links";
const store = new NodeFsStore(folder);
const sink = await SceneSink.resume(store);
const recorder = new RecordingSink();
const grid = await openScene(store, { attach: new TeeSink([recorder, sink]) });
const wanted = flag("bit") ?? "first";
const bit = wanted === "first" ? [...grid.bits()].find((b) => b.present) : grid.get(wanted);
if (!bit) {
  console.error(`no bit ${wanted}`);
  process.exit(1);
}
const history = parseLedger(await store.read(ledgerPath(bit.id)));
const pool = new InProcessPool(grid, {
  storage: new FolderStorage(flag("results") ?? join(folder, "results")),
  history: () => [...history, ...recorder.events],
});
const id = uuidv7();
const t0 = performance.now();
const audit = await pool.actor(bit.id).run({ id, kind });
await sink.flush();
const ms = (performance.now() - t0).toFixed(1);
const job = jobsOf(recorder.events.filter((e) => e.bit === bit.id)).find((j) => j.id === id)!;
console.log(`bit ${bit.id} at ${bit.key}: job ${kind} ${id}, ${ms} ms, audit ${audit.passed ? "PASSED" : "FAILED"}`);
console.log(`  check: ${audit.check}${audit.detail ? ` (${audit.detail})` : ""}`);
console.log(`  result: ${job.result?.cid ? `cid ${job.result.cid}, ${job.result.bytes} bytes` : `inline, ${JSON.stringify(job.result?.value).slice(0, 80)}`}`);
console.log(`  records: seq ${job.seqs.join(", ")}${job.reward ? " (rewarded)" : " (no reward)"}`);
process.exit(audit.passed ? 0 : 1);
