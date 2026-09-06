/**
 * Host a scene's actors on the durable engine (PLAN-3.md Phase 15).
 *
 *   npm run durable:worker -- --scene <folder> [--address 127.0.0.1:7233] [--task-queue vpb-bits]
 *
 * Opens the scene folder for writing, connects to the engine (a local
 * `temporal server start-dev` or the test environment's server), and
 * runs until SIGINT or SIGTERM. Prints one line, "worker ready", when it
 * is polling. Kill it mid-job and start another: the job completes once.
 */
import { RecordingSink, TeeSink } from "../src/events.ts";
import { openScene, SceneSink } from "../src/scene.ts";
import { FolderStorage } from "../src/storage-node.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { createActorWorker, DEFAULT_TASK_QUEUE } from "./actor-durable.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const folder = flag("scene");
if (!folder) {
  console.error("usage: durable-worker --scene <folder> [--address host:port] [--task-queue name]");
  process.exit(2);
}
const store = new NodeFsStore(folder);
const sink = await SceneSink.resume(store);
const recorder = new RecordingSink();
const grid = await openScene(store, { attach: new TeeSink([recorder, sink]) });
const worker = await createActorWorker({
  address: flag("address") ?? process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  taskQueue: flag("task-queue") ?? DEFAULT_TASK_QUEUE,
  host: { grid, recorder, store, sink, storage: new FolderStorage(`${folder}/results`) },
});
const stop = () => worker.shutdown();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`worker ready: ${grid.size} bits from ${folder}`);
await worker.run();
await sink.flush();
