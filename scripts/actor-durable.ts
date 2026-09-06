/**
 * The durable backend behind the actor contract (PLAN-3.md Phase 15).
 * Jobs run as workflows on a durable-execution engine; a worker that
 * hosts the scene's actors executes the steps. The engine chosen by the
 * survey's ranking (docs/research/compute-attachment.md): Temporal, MIT,
 * with a dev server that runs locally with no account. Nothing here is
 * specific to it beyond the SDK calls, and the contract is Phase 12's.
 *
 * What the engine guarantees: a started workflow runs to completion even
 * if the worker dies, retrying the step it was in. What the ledger
 * guarantees: each record step writes only if its record is absent. They
 * meet at the workflow id, bit plus job, so a resumed job is the same job.
 */
import { fileURLToPath } from "node:url";
import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { ActorPool, Job } from "../src/actor.ts";
import type { JobAudit } from "../src/jobs.ts";
import { mapLimit } from "../src/scene.ts";
import { type ActorHost, makeActivities } from "./durable/activities.ts";
import type { bitJob } from "./durable/workflows.ts";

export const DEFAULT_TASK_QUEUE = "vpb-bits";

export interface DurableActorPoolOptions {
  client: Client;
  taskQueue?: string;
  name?: string;
}

/** The workflow id for a job on a bit; the same job submitted twice is one workflow. */
export const workflowIdFor = (bitId: string, jobId: string) => `bit-${bitId}-job-${jobId}`;

export class DurableActorPool implements ActorPool {
  readonly name: string;
  readonly #client: Client;
  readonly #taskQueue: string;

  constructor(opts: DurableActorPoolOptions) {
    this.#client = opts.client;
    this.#taskQueue = opts.taskQueue ?? DEFAULT_TASK_QUEUE;
    this.name = opts.name ?? "actor:durable";
  }

  actor(bitId: string) {
    return { bit: bitId, run: (job: Job) => this.run(bitId, job) };
  }

  runAll(jobs: { bit: string; job: Job }[], concurrency = 16): Promise<JobAudit[]> {
    return mapLimit(jobs, concurrency, ({ bit, job }) => this.run(bit, job));
  }

  /** Start the job's workflow, or attach to it if it is already running, and wait for the audit. */
  async run(bitId: string, job: Job): Promise<JobAudit> {
    const workflowId = workflowIdFor(bitId, job.id);
    try {
      const handle = await this.#client.workflow.start<typeof bitJob>("bitJob", {
        taskQueue: this.#taskQueue,
        workflowId,
        args: [bitId, job],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
      return await handle.result();
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        return this.#client.workflow.getHandle<typeof bitJob>(workflowId).result();
      }
      throw err;
    }
  }
}

export interface WorkerOptions {
  address: string;
  taskQueue?: string;
  host: ActorHost;
}

/** A worker hosting a scene's actors: activities over the scene, the workflow from ./durable/workflows.ts. */
export async function createActorWorker(opts: WorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: opts.address });
  return Worker.create({
    connection,
    taskQueue: opts.taskQueue ?? DEFAULT_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./durable/workflows.ts", import.meta.url)),
    activities: makeActivities(opts.host),
    maxConcurrentActivityTaskExecutions: 16,
  });
}
