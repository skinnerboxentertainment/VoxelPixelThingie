/**
 * Work as events (PLAN-3.md Phase 12, SPEC.md §9.7). A bit asks for work,
 * gets a result, and gets an audit that names the check that passed or
 * failed. Nothing new in the event set: the three records are `annotated`
 * events under reserved keys, validated at the sink, so a container that
 * has never heard of jobs still stores them and a reader that has still
 * finds them. The reward is the audit that passed; a wrangler may add a
 * `job:reward` record with whatever it means by that.
 */
import type { BitEvent } from "./events.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { isContentId } from "./storage.ts";

export const JOB_KEYS = {
  request: "job:request",
  result: "job:result",
  audit: "job:audit",
  reward: "job:reward",
} as const;

export type JobKey = (typeof JOB_KEYS)[keyof typeof JOB_KEYS];

export interface JobRequest {
  /** Unique within the bit; the three records share it. */
  id: string;
  /** The workload's name, for example "led-frame". */
  kind: string;
  params?: JsonObject;
  /** Where the requester wants it run: "local", "pool", or a backend's name. */
  where?: string;
}

export interface JobResult {
  id: string;
  /** Content id of the result's bytes in storage, for results too big to inline. */
  cid?: string;
  /** A small result inline. */
  value?: JsonValue;
  /** Size of the bytes, when stored. */
  bytes?: number;
  /** Wall time of the work, ms. */
  ms: number;
  /** Which actor or backend did it. */
  worker?: string;
}

export interface JobAudit {
  id: string;
  /** The check that ran, in words a stranger can repeat. */
  check: string;
  passed: boolean;
  detail?: string;
}

export interface JobReward {
  id: string;
  /** What the wrangler means by a reward; the model does not care. */
  note?: JsonValue;
}

export const isJobKey = (key: string): key is JobKey =>
  key === JOB_KEYS.request ||
  key === JOB_KEYS.result ||
  key === JOB_KEYS.audit ||
  key === JOB_KEYS.reward;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Throws with the first thing wrong in a job record; other annotation keys pass untouched. */
export function validateJobAnnotation(key: string, value: unknown): void {
  if (!isJobKey(key)) return;
  if (!isObj(value)) throw new Error(`${key}: not an object`);
  if (!nonEmpty(value.id)) throw new Error(`${key}: id must be a non-empty string`);
  switch (key) {
    case JOB_KEYS.request:
      if (!nonEmpty(value.kind)) throw new Error(`${key}: kind must be a non-empty string`);
      if (value.params !== undefined && !isObj(value.params))
        throw new Error(`${key}: params must be an object`);
      if (value.where !== undefined && !nonEmpty(value.where))
        throw new Error(`${key}: where must be a string`);
      return;
    case JOB_KEYS.result:
      if (typeof value.ms !== "number" || !(value.ms >= 0))
        throw new Error(`${key}: ms must be a non-negative number`);
      if (value.cid === undefined && value.value === undefined)
        throw new Error(`${key}: needs a cid or a value`);
      if (value.cid !== undefined && !isContentId(value.cid))
        throw new Error(`${key}: cid is not a content id`);
      if (value.bytes !== undefined && (typeof value.bytes !== "number" || value.bytes < 0))
        throw new Error(`${key}: bytes must be a non-negative number`);
      return;
    case JOB_KEYS.audit:
      if (!nonEmpty(value.check)) throw new Error(`${key}: check must name the check`);
      if (typeof value.passed !== "boolean") throw new Error(`${key}: passed must be a boolean`);
      if (value.detail !== undefined && typeof value.detail !== "string")
        throw new Error(`${key}: detail must be a string`);
      return;
    case JOB_KEYS.reward:
      return;
  }
}

export interface JobHistory {
  id: string;
  request?: JobRequest;
  result?: JobResult;
  audit?: JobAudit;
  reward?: JobReward;
  /** Sequence numbers of the records, in the order they were written. */
  seqs: number[];
}

/** The jobs in a bit's events, each with whatever records it has, in first-seen order. */
export function jobsOf(events: Iterable<BitEvent>): JobHistory[] {
  const byId = new Map<string, JobHistory>();
  for (const e of events) {
    if (e.type !== "annotated" || !isJobKey(e.key) || !isObj(e.value) || !nonEmpty(e.value.id))
      continue;
    const id = e.value.id;
    const h = byId.get(id) ?? { id, seqs: [] };
    h.seqs.push(e.seq);
    if (e.key === JOB_KEYS.request) h.request = e.value as unknown as JobRequest;
    else if (e.key === JOB_KEYS.result) h.result = e.value as unknown as JobResult;
    else if (e.key === JOB_KEYS.audit) h.audit = e.value as unknown as JobAudit;
    else h.reward = e.value as unknown as JobReward;
    byId.set(id, h);
  }
  return [...byId.values()];
}

/** A short business step name for the EPCIS mapping: "job-request", "job-result", "job-audit", "job-reward". */
export const jobStep = (key: JobKey): string => key.replace(":", "-");
