/**
 * The actor contract (PLAN-3.md Phase 12, ADR 0010): one actor per bit id,
 * holding the bit's state, handling one job at a time, and writing the
 * three records that make work a fact: request, result, audit. This file
 * holds the contract, the workloads that ship, and the in-process
 * reference pool. Backends that survive a process arrive in Phase 15
 * behind the same contract.
 *
 * Work, then audit, then reward, in that order. A workload returns a value
 * or bytes and the check it ran; the pool stores bytes by content id and
 * inlines JSON values, records the result, records the audit, and records a reward only when
 * the audit passed. A workload that throws is a failed audit, not a lost
 * job.
 */
import type { BitHandle, Container } from "./container.ts";
import { toEpcisDocument } from "./epcis.ts";
import type { BitEvent } from "./events.ts";
import { JOB_KEYS, type JobAudit, type JobRequest, type JobResult } from "./jobs.ts";
import type { JsonValue } from "./json.ts";
import { defaultLedMap, ledFrame, ledMapOf } from "./led-map.ts";
import { MemoryIndex, type MemoryQuery, tokenize, tokensOf } from "./memory.ts";
import { PolicyError } from "./policy.ts";
import { mapLimit } from "./scene.ts";
import { partnerSlot } from "./slots.ts";
import type { Storage } from "./storage.ts";

export interface Job {
  id: string;
  kind: string;
  params?: JobRequest["params"];
}

export interface Outcome {
  /** A small result, inlined into the result record. */
  value?: JsonValue;
  /** A big result, stored by content id. */
  bytes?: Uint8Array;
  /** The check the workload ran, in words. */
  check: string;
  passed: boolean;
  detail?: string;
}

export interface WorkContext {
  grid: Container;
  /** Events already recorded for the bit, for workloads that read history. */
  history: () => BitEvent[];
}

export type Workload = (bit: BitHandle, job: Job, ctx: WorkContext) => Promise<Outcome> | Outcome;

export interface Actor {
  readonly bit: string;
  /** Runs the job and records request, result, audit, and reward as events. Returns the audit. */
  run(job: Job): Promise<JobAudit>;
}

export interface ActorPool {
  readonly name: string;
  actor(bitId: string): Actor;
  /** Run one job per entry, with bounded concurrency across bits. */
  runAll(jobs: { bit: string; job: Job }[], concurrency?: number): Promise<JobAudit[]>;
}

// ---------------------------------------------------------------- workloads

/** The bit's LED frame; the check is the frame's own invariants, not a second copy of ledFrame. */
export const ledFrameWorkload: Workload = (bit) => {
  const rec = bit.record();
  const map = ledMapOf(rec.passport) ?? defaultLedMap();
  const frame = ledFrame(rec, map);
  const lit = frame.some((b) => b !== 0);
  const anyEmission = rec.emissions.some((e) => e.color !== undefined || e.light !== undefined);
  const expectLit = rec.present && anyEmission && rec.emissions.some((e) => (e.light ?? 1) > 0);
  const ok = frame.length === map.leds * 3 && lit === expectLit;
  return {
    bytes: frame,
    check: "frame is leds×3 bytes, lit exactly when the bit is present with a lit emission",
    passed: ok,
    detail: `${frame.length} bytes, ${lit ? "lit" : "dark"}, present ${rec.present}`,
  };
};

/** The bit's history as an EPCIS document; the check is one EPCIS event per VPB event with well-formed ids. */
export const epcisWorkload: Workload = (bit, _job, ctx) => {
  const events = ctx.history().filter((e) => e.bit === bit.id);
  const doc = toEpcisDocument(events);
  const list = doc.epcisBody.eventList;
  const ok =
    list.length === events.length &&
    list.every((e) => typeof e.eventID === "string" && e.eventID.startsWith("urn:vpb:event:"));
  return {
    bytes: new TextEncoder().encode(JSON.stringify(doc)),
    check: "one EPCIS event per VPB event, every eventID a urn:vpb:event",
    passed: ok,
    detail: `${list.length} EPCIS events for ${events.length} VPB events`,
  };
};

/** Every link the bit reports is reported back by its neighbor at the partner slot. */
export const linksWorkload: Workload = (bit, _job, ctx) => {
  const rec = bit.record();
  let checked = 0;
  let broken = 0;
  for (let slot = 0; slot < rec.links.length; slot++) {
    for (const link of rec.links[slot]!) {
      checked++;
      const [neighborId, partnerText] = link.split(":");
      const neighbor = ctx.grid.get(neighborId!);
      const partner = Number(partnerText);
      const back = neighbor?.record().links[partner]?.some((l) => l === `${bit.id}:${slot}`);
      if (!back) broken++;
    }
  }
  return {
    value: { checked, broken },
    check: "every link is mirrored by the neighbor at the partner slot",
    passed: broken === 0 && checked === rec.links.flat().length,
    detail: `${checked} links, ${broken} unmirrored`,
  };
};

/** A workload whose check always fails, for tests of the failed path. */
/**
 * A bit answers a query about its own history (PLAN-4.md Phase 20). The
 * params are a MemoryQuery; the audit recomputes the answer by scanning
 * the history without the index and compares.
 */
export const searchWorkload: Workload = (bit, job, ctx) => {
  const q = (job.params ?? {}) as MemoryQuery;
  for (const [k, v] of Object.entries(q)) {
    const numeric = k === "slot" || k === "from" || k === "to" || k === "limit";
    if (numeric ? typeof v !== "number" : typeof v !== "string")
      return {
        value: null,
        check: "query is well formed",
        passed: false,
        detail: `${k} must be a ${numeric ? "number" : "string"}`,
      };
  }
  // The bit's own history, minus this job's own records: a query must not find its own request.
  const mine = ctx
    .history()
    .filter(
      (e) =>
        e.bit === bit.id &&
        !(
          e.type === "annotated" &&
          e.key.startsWith("job:") &&
          (e.value as { id?: unknown } | null)?.id === job.id
        ),
    );
  const index = new MemoryIndex(ctx.grid.id);
  for (const e of mine) index.add(e);
  const { total, hits } = index.search({ ...q, bit: bit.id });
  // The check: a plain scan of the history agrees with the index on which events match.
  const toks = tokenize(q.text ?? "");
  const scan = mine
    .filter((e) => {
      if (q.type !== undefined && e.type !== q.type) return false;
      if (q.slot !== undefined && !("slot" in e && e.slot === q.slot)) return false;
      if (q.actor !== undefined && e.actor !== q.actor) return false;
      if (q.key !== undefined && !(e.type === "annotated" && e.key === q.key)) return false;
      if (q.from !== undefined && e.time < q.from) return false;
      if (q.to !== undefined && e.time > q.to) return false;
      const have = new Set(tokensOf(e));
      return toks.every((t) => have.has(t));
    })
    .sort((a, b) => a.seq - b.seq);
  const agree =
    scan.length === total && hits.every((h, i) => scan[i] !== undefined && scan[i]!.seq === h.seq);
  return {
    value: { total, hits } as unknown as JsonValue,
    check: "a plain scan of the history agrees with the index",
    passed: agree,
    detail: agree
      ? `${total} hit(s) of ${mine.length} events`
      : `index ${total}, scan ${scan.length}`,
  };
};

export const failingWorkload: Workload = () => ({
  value: null,
  check: "always fails",
  passed: false,
  detail: "by design",
});

export const WORKLOADS: Record<string, Workload> = {
  "led-frame": ledFrameWorkload,
  epcis: epcisWorkload,
  links: linksWorkload,
  search: searchWorkload,
};

// ---------------------------------------------------------------- reference pool

export interface InProcessPoolOptions {
  storage: Storage;
  workloads?: Record<string, Workload>;
  /** The actor name written into every record, default "actor:in-process". */
  name?: string;
  /** Events recorded so far, for history-reading workloads. */
  history?: () => BitEvent[];
}

/** One process, one grid, an actor per bit, jobs one at a time per bit. */
export class InProcessPool implements ActorPool {
  readonly name: string;
  readonly #grid: Container;
  readonly #storage: Storage;
  readonly #workloads: Record<string, Workload>;
  readonly #history: () => BitEvent[];
  readonly #busy = new Map<string, Promise<unknown>>();

  constructor(grid: Container, opts: InProcessPoolOptions) {
    this.#grid = grid;
    this.#storage = opts.storage;
    this.#workloads = opts.workloads ?? WORKLOADS;
    this.name = opts.name ?? "actor:in-process";
    this.#history = opts.history ?? (() => []);
  }

  actor(bitId: string): Actor {
    return { bit: bitId, run: (job) => this.#run(bitId, job) };
  }

  runAll(jobs: { bit: string; job: Job }[], concurrency = 8): Promise<JobAudit[]> {
    return mapLimit(jobs, concurrency, ({ bit, job }) => this.#run(bit, job));
  }

  #run(bitId: string, job: Job): Promise<JobAudit> {
    const prev = this.#busy.get(bitId) ?? Promise.resolve();
    const next = prev.then(() => this.#runNow(bitId, job));
    this.#busy.set(
      bitId,
      next.catch(() => {}),
    );
    return next;
  }

  async #runNow(bitId: string, job: Job): Promise<JobAudit> {
    const bit = this.#grid.get(bitId);
    if (!bit) throw new Error(`no bit ${bitId}`);
    const record = <T>(key: string, value: T, cause: string) =>
      this.#grid.wrangle({ actor: this.name, cause }, () =>
        bit.annotate(key, value as unknown as JsonValue),
      );
    try {
      record(JOB_KEYS.request, requestRecord(job), `job ${job.kind}`);
    } catch (err) {
      // The bit's policy refused the request (SPEC.md §9.8): a failed audit
      // naming the rule, no result. A refusal of the audit itself propagates.
      if (!(err instanceof PolicyError)) throw err;
      const audit: JobAudit = {
        id: job.id,
        check: "policy allows the work",
        passed: false,
        detail: err.refusal.rule,
      };
      record(JOB_KEYS.audit, audit, `audit ${job.kind}`);
      return audit;
    }
    const { result, audit } = await performJob(bit, job, {
      grid: this.#grid,
      storage: this.#storage,
      workloads: this.#workloads,
      history: this.#history,
      worker: this.name,
    });
    record(JOB_KEYS.result, result, `job ${job.kind}`);
    record(JOB_KEYS.audit, audit, `audit ${job.kind}`);
    if (audit.passed) record(JOB_KEYS.reward, rewardRecord(audit), `reward ${job.kind}`);
    return audit;
  }
}

/** The request record for a job. */
export function requestRecord(job: Job): JobRequest {
  return { id: job.id, kind: job.kind, ...(job.params ? { params: job.params } : {}) };
}

/** The reward record that follows a passed audit. */
export function rewardRecord(audit: JobAudit): { id: string; note: string } {
  return { id: audit.id, note: `audit passed: ${audit.check}` };
}

export interface PerformOptions {
  grid: Container;
  storage: Storage;
  workloads: Record<string, Workload>;
  history: () => BitEvent[];
  /** Named in the result record. */
  worker: string;
}

/**
 * Run a workload and produce the result and audit records without writing
 * them: the in-process pool and the durable backend (Phase 15) both call
 * this, and each records the outcome its own way. Bytes go to storage by
 * content id; a throwing or missing workload is a failed audit.
 */
export async function performJob(
  bit: BitHandle,
  job: Job,
  opts: PerformOptions,
): Promise<{ result: JobResult; audit: JobAudit }> {
  const t0 = performance.now();
  let outcome: Outcome;
  const workload = opts.workloads[job.kind];
  if (!workload) {
    outcome = {
      value: null,
      check: "workload exists",
      passed: false,
      detail: `no workload ${job.kind}`,
    };
  } else {
    try {
      outcome = await workload(bit, job, { grid: opts.grid, history: opts.history });
    } catch (err) {
      outcome = {
        value: null,
        check: "workload completes",
        passed: false,
        detail: (err as Error).message,
      };
    }
  }
  const ms = Math.round((performance.now() - t0) * 1000) / 1000;
  const result: JobResult = { id: job.id, ms, worker: opts.worker };
  if (outcome.bytes) {
    result.cid = await opts.storage.put(outcome.bytes);
    result.bytes = outcome.bytes.length;
  } else {
    result.value = outcome.value ?? null;
  }
  const audit: JobAudit = {
    id: job.id,
    check: outcome.check,
    passed: outcome.passed,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
  return { result, audit };
}

/** True when a partner slot exists for the offset: the model's own rule, used by the links check. */
export const hasPartner = (slot: number, offset: readonly [number, number, number]) =>
  partnerSlot(slot, offset) !== null;
