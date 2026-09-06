/**
 * Activities for the durable job workflow (PLAN-3.md Phase 15). They run
 * in the worker process that hosts a scene's actors. Each record step
 * first looks for its record in the bit's ledger and writes only when it
 * is absent, so the engine may retry a step after a crash and the ledger
 * still shows one request, one result, one audit.
 */
import { Context } from "@temporalio/activity";
import { type Job, performJob, requestRecord, rewardRecord, type Workload, WORKLOADS } from "../../src/actor.ts";
import type { Container } from "../../src/container.ts";
import type { BitEvent, RecordingSink } from "../../src/events.ts";
import { JOB_KEYS, type JobAudit, type JobResult, jobsOf } from "../../src/jobs.ts";
import type { JsonValue } from "../../src/json.ts";
import { ledgerPath, parseLedger, type SceneSink } from "../../src/scene.ts";
import type { Storage } from "../../src/storage.ts";
import type { FileStore } from "../../src/store.ts";

export interface ActorHost {
  grid: Container;
  recorder: RecordingSink;
  storage: Storage;
  /** The scene's store, for reading ledgers written by an earlier worker. */
  store?: FileStore;
  /** The sink to flush after each record so the ledger is on disk before the step completes. */
  sink?: SceneSink;
  workloads?: Record<string, Workload>;
  name?: string;
}

/** A workload that takes its time and heartbeats, for the kill-and-restart test. */
export const slowWorkload: Workload = async (_bit, job) => {
  const ms = Number((job.params as { ms?: number } | undefined)?.ms ?? 3000);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      Context.current().heartbeat(until - Date.now());
    } catch {
      // outside an activity, as in the in-process pool: no heartbeat to send
    }
  }
  return { value: { slept: ms }, check: "slept the requested time", passed: true };
};

export function makeActivities(host: ActorHost) {
  const name = host.name ?? "actor:durable";
  const workloads = host.workloads ?? { ...WORKLOADS, slow: slowWorkload };
  const history = async (bitId: string): Promise<BitEvent[]> => {
    const stored = host.store ? parseLedger(await host.store.read(ledgerPath(bitId))) : [];
    const seen = new Set(stored.map((e) => e.seq));
    const fresh = host.recorder.events.filter((e) => e.bit === bitId && !seen.has(e.seq));
    return [...stored, ...fresh].sort((a, b) => a.seq - b.seq);
  };
  const bitOr = (bitId: string) => {
    const bit = host.grid.get(bitId);
    if (!bit) throw new Error(`no bit ${bitId}`);
    return bit;
  };
  const jobOf = async (bitId: string, jobId: string) => jobsOf(await history(bitId)).find((j) => j.id === jobId);
  const write = async <T>(bitId: string, key: string, value: T, cause: string) => {
    const bit = bitOr(bitId);
    host.grid.wrangle({ actor: name, cause }, () => bit.annotate(key, value as unknown as JsonValue));
    await host.sink?.flush();
  };

  return {
    async recordRequest(bitId: string, job: Job): Promise<void> {
      if ((await jobOf(bitId, job.id))?.request) return; // written before the crash
      await write(bitId, JOB_KEYS.request, requestRecord(job), `job ${job.kind}`);
    },
    async doWork(bitId: string, job: Job): Promise<{ result: JobResult; audit: JobAudit }> {
      const bit = bitOr(bitId);
      return performJob(bit, job, {
        grid: host.grid,
        storage: host.storage,
        workloads,
        history: () => host.recorder.events,
        worker: name,
      });
    },
    async recordResult(bitId: string, result: JobResult): Promise<void> {
      if ((await jobOf(bitId, result.id))?.result) return;
      await write(bitId, JOB_KEYS.result, result, "job result");
    },
    async recordAudit(bitId: string, audit: JobAudit): Promise<void> {
      if ((await jobOf(bitId, audit.id))?.audit) return;
      await write(bitId, JOB_KEYS.audit, audit, "job audit");
    },
    async recordReward(bitId: string, audit: JobAudit): Promise<void> {
      if ((await jobOf(bitId, audit.id))?.reward) return;
      await write(bitId, JOB_KEYS.reward, rewardRecord(audit), "job reward");
    },
  };
}

export type Activities = ReturnType<typeof makeActivities>;
