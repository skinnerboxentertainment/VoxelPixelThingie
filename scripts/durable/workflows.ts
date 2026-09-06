/**
 * The durable job workflow (PLAN-3.md Phase 15). Runs inside the engine's
 * sandbox, so it imports nothing from Node and nothing from src at
 * runtime; the activities in ./activities.ts do the work against the
 * scene. The workflow id is the bit id plus the job id, so a job resumed
 * after a crash is the same job, and each activity is idempotent against
 * the bit's ledger, so a retried step writes nothing twice.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { Job } from "../../src/actor.ts";
import type { JobAudit } from "../../src/jobs.ts";
import type { Activities } from "./activities.ts";

const { recordRequest, doWork, recordResult, recordAudit, recordReward } = proxyActivities<Activities>({
  startToCloseTimeout: "60 seconds",
  heartbeatTimeout: "3 seconds",
  retry: { initialInterval: "500ms", backoffCoefficient: 1.5, maximumInterval: "5 seconds" },
});

/** Request, work, result, audit, reward, in that order, each step durable. */
export async function bitJob(bitId: string, job: Job): Promise<JobAudit> {
  await recordRequest(bitId, job);
  const { result, audit } = await doWork(bitId, job);
  await recordResult(bitId, result);
  await recordAudit(bitId, audit);
  if (audit.passed) await recordReward(bitId, audit);
  return audit;
}
