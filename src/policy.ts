/**
 * The policy a bit carries (PLAN-4.md Phase 19, ADR 0014, SPEC.md §9.8).
 * A small document under the reserved passport key `policy` says who may
 * change the bit, what work it accepts, and whether a software agent may
 * act on it. The scene sink judges every event against the bit's current
 * policy before the container applies it; a refusal lands in the ledger
 * as `policy:refused` and the caller gets a PolicyError.
 *
 * The vocabulary is deliberately small and maps one-to-one onto ODRL 2.2
 * terms (scripts/export-policy.ts); the enforced form is this one.
 */
import type { BitEvent } from "./events.ts";
import { JOB_KEYS } from "./jobs.ts";
import type { JsonObject } from "./json.ts";

export const POLICY_KEY = "policy";
export const REFUSED_KEY = "policy:refused";
/** The actor a refusal record is written under. */
export const POLICY_ACTOR = "policy";

export interface Policy {
  version: 1;
  /** Actors who may replace the passport, the policy included. Absent: anyone. */
  controllers?: string[];
  /** Actor patterns; `*` at the end matches a prefix. Deny wins over allow. */
  actors?: { allow?: string[]; deny?: string[] };
  /** Whether software agents (actors `mcp:*`, `actor:*`, `agent:*`) may change the bit. Absent: yes. */
  agents?: boolean;
  /** Job kinds the bit accepts. Absent: any. */
  work?: string[];
}

/** What a refusal record carries. */
export interface Refusal {
  actor?: string;
  type: BitEvent["type"];
  key?: string;
  rule: string;
}

export class PolicyError extends Error {
  readonly refusal: Refusal;
  readonly bit: string;
  constructor(bit: string, refusal: Refusal) {
    super(
      `policy on bit ${bit} refuses ${refusal.type}${refusal.key ? ` ${refusal.key}` : ""} by ${refusal.actor ?? "an anonymous actor"}: ${refusal.rule}`,
    );
    this.name = "PolicyError";
    this.bit = bit;
    this.refusal = refusal;
  }
}

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/** The policy in a passport, validated, or undefined when there is none. Malformed throws. */
export function policyOf(passport: JsonObject | undefined): Policy | undefined {
  const raw = passport?.[POLICY_KEY];
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("policy: not an object");
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) throw new Error("policy: version must be 1");
  if (p.controllers !== undefined && !isStringList(p.controllers))
    throw new Error("policy: controllers must be a list of actors");
  if (p.actors !== undefined) {
    if (p.actors === null || typeof p.actors !== "object")
      throw new Error("policy: actors must be an object");
    const a = p.actors as Record<string, unknown>;
    if (a.allow !== undefined && !isStringList(a.allow))
      throw new Error("policy: actors.allow must be a list");
    if (a.deny !== undefined && !isStringList(a.deny))
      throw new Error("policy: actors.deny must be a list");
  }
  if (p.agents !== undefined && typeof p.agents !== "boolean")
    throw new Error("policy: agents must be a boolean");
  if (p.work !== undefined && !isStringList(p.work))
    throw new Error("policy: work must be a list of kinds");
  return p as unknown as Policy;
}

export const isAgent = (actor: string | undefined): boolean =>
  actor !== undefined && /^(mcp|actor|agent):/.test(actor);

/** `mcp:*` matches any actor starting with `mcp:`; otherwise exact. */
export function matchesActor(pattern: string, actor: string | undefined): boolean {
  if (actor === undefined) return false;
  return pattern.endsWith("*") ? actor.startsWith(pattern.slice(0, -1)) : actor === pattern;
}

/** Events that change nothing about the bit and are never judged. */
const EXEMPT_ACTORS = new Set(["replay", POLICY_ACTOR]);

/**
 * The refusal, or undefined when the policy allows the event. Replay and
 * the policy's own records are exempt; link events are the container's
 * bookkeeping and are exempt too.
 */
export function judge(policy: Policy | undefined, event: BitEvent): Refusal | undefined {
  if (!policy) return undefined;
  if (event.actor !== undefined && EXEMPT_ACTORS.has(event.actor)) return undefined;
  if (event.type === "linked" || event.type === "unlinked") return undefined;
  const actor = event.actor;
  const base = { ...(actor !== undefined ? { actor } : {}), type: event.type };
  const key = event.type === "annotated" ? event.key : undefined;
  const withKey = key ? { ...base, key } : base;
  if (policy.agents === false && isAgent(actor)) return { ...withKey, rule: "agents: false" };
  if (policy.actors?.deny?.some((p) => matchesActor(p, actor)))
    return { ...withKey, rule: `actors.deny matches ${actor}` };
  if (policy.actors?.allow && !policy.actors.allow.some((p) => matchesActor(p, actor)))
    return { ...withKey, rule: `actors.allow does not include ${actor ?? "an anonymous actor"}` };
  if (
    event.type === "passport" &&
    policy.controllers &&
    !policy.controllers.some((p) => matchesActor(p, actor))
  )
    return { ...withKey, rule: `controllers does not include ${actor ?? "an anonymous actor"}` };
  if (event.type === "annotated" && event.key === JOB_KEYS.request && policy.work) {
    const kind = (event.value as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !policy.work.includes(kind))
      return { ...withKey, rule: `work does not include ${String(kind)}` };
  }
  return undefined;
}

/** The ledger record for a refusal: the refused event's place, the policy as actor. */
export function refusalEvent(event: BitEvent, refusal: Refusal): BitEvent {
  return {
    type: "annotated",
    key: REFUSED_KEY,
    value: refusal as unknown as JsonObject,
    bit: event.bit,
    seq: event.seq,
    time: event.time,
    frame: event.frame,
    actor: POLICY_ACTOR,
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
  };
}

/** `policy:refused` is the sink's to write: anyone else is refused at the door. */
export function validatePolicyAnnotation(
  key: string,
  value: unknown,
  actor: string | undefined,
): void {
  if (key !== REFUSED_KEY) return;
  if (actor !== POLICY_ACTOR)
    throw new Error(
      `${REFUSED_KEY} is written by the policy, not by ${actor ?? "an anonymous actor"}`,
    );
  const v = value as Partial<Refusal> | null;
  if (!v || typeof v !== "object" || typeof v.type !== "string" || typeof v.rule !== "string")
    throw new Error(`${REFUSED_KEY}: value must carry type and rule`);
}
