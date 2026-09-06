/**
 * EPCIS 2.0 export (PLAN-2.md Phase 9, docs/spime-research.md §3).
 *
 * A VoxelPixelBit's history becomes an EPCISDocument in JSON-LD, so a
 * supply chain tool that speaks GS1's event language can read a bit's life
 * without knowing what a voxel is. The mapping:
 *
 *   created    ObjectEvent ADD, bizStep commissioning, ilmd carries color and emission
 *   destroyed  ObjectEvent DELETE, bizStep destroying
 *   presence   ObjectEvent OBSERVE, disposition active or inactive
 *   moved      ObjectEvent OBSERVE, extension carries from and to
 *   emitted    ObjectEvent OBSERVE, sensorElementList carries the emission
 *   passport   ObjectEvent OBSERVE, extension carries the passport (ilmd is ADD-only in EPCIS 2.0)
 *   annotated  ObjectEvent OBSERVE, extension carries key and value
 *   linked     AssociationEvent ADD, parent the bit, child the neighbor
 *   unlinked   AssociationEvent DELETE
 *
 * Identifiers are urn:uuid URIs. The container is the readPoint. A wrangler's
 * cause becomes a bizStep under the project namespace; the actor becomes an
 * owning_party source. Extension fields use the `vpb:` prefix declared in
 * the document's @context.
 */
import type { BitEvent, EventSink } from "./events.ts";

export const VPB_NS = "https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/";
export const EPCIS_CONTEXT = "https://ref.gs1.org/standards/epcis/epcis-context.jsonld";

export interface EpcisOptions {
  /** Prefix for readPoint ids built from a container id. Default urn:vpb:frame: */
  framePrefix?: string;
  /** Prefix for actor party ids. Default urn:vpb:actor: */
  actorPrefix?: string;
  /** Document creation time. Default now. */
  now?: () => number;
}

export type EpcisEvent = Record<string, unknown> & {
  type: "ObjectEvent" | "AssociationEvent";
  eventTime: string;
  eventTimeZoneOffset: string;
  eventID: string;
  action: "ADD" | "OBSERVE" | "DELETE";
};

export interface EpcisDocument {
  "@context": (string | Record<string, string>)[];
  type: "EPCISDocument";
  schemaVersion: "2.0";
  creationDate: string;
  epcisBody: { eventList: EpcisEvent[] };
}

const iso = (ms: number) => new Date(ms).toISOString();
const uuidUri = (id: string) => `urn:uuid:${id}`;

function slug(s: string): string {
  const out: string[] = [];
  for (const ch of s.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out.push(ch);
    else if (out.length && out[out.length - 1] !== "-") out.push("-");
  }
  while (out.length && out[out.length - 1] === "-") out.pop();
  return out.join("") || "unspecified";
}

/** The EPCIS event type and action for a VPB event type. */
export function epcisKind(type: BitEvent["type"]): {
  type: EpcisEvent["type"];
  action: EpcisEvent["action"];
} {
  switch (type) {
    case "created":
      return { type: "ObjectEvent", action: "ADD" };
    case "destroyed":
      return { type: "ObjectEvent", action: "DELETE" };
    case "linked":
      return { type: "AssociationEvent", action: "ADD" };
    case "unlinked":
      return { type: "AssociationEvent", action: "DELETE" };
    default:
      return { type: "ObjectEvent", action: "OBSERVE" };
  }
}

/** One VPB event as one EPCIS event. */
export function toEpcisEvent(e: BitEvent, opts: EpcisOptions = {}): EpcisEvent {
  const framePrefix = opts.framePrefix ?? "urn:vpb:frame:";
  const actorPrefix = opts.actorPrefix ?? "urn:vpb:actor:";
  const kind = epcisKind(e.type);
  const out: EpcisEvent = {
    type: kind.type,
    action: kind.action,
    eventTime: iso(e.time),
    eventTimeZoneOffset: "+00:00",
    eventID: `urn:vpb:event:${e.frame}:${e.seq}`,
    readPoint: { id: `${framePrefix}${e.frame}` },
    "vpb:type": e.type,
    "vpb:seq": e.seq,
  };
  if (e.cause !== undefined) out.bizStep = `${VPB_NS}bizstep/${slug(e.cause)}`;
  if (e.actor !== undefined) {
    out.sourceList = [{ type: "owning_party", source: `${actorPrefix}${slug(e.actor)}` }];
    out["vpb:actor"] = e.actor;
  }

  if (kind.type === "AssociationEvent") {
    const neighbor = e.type === "linked" || e.type === "unlinked" ? e.neighbor : "";
    out.parentID = uuidUri(e.bit);
    out.childEPCs = [uuidUri(neighbor)];
    if (e.type === "linked") {
      out["vpb:slot"] = e.slot;
      out["vpb:partner"] = e.partner;
      out["vpb:offset"] = [...e.offset];
    } else if (e.type === "unlinked") {
      out["vpb:slot"] = e.slot;
    }
    return out;
  }

  out.epcList = [uuidUri(e.bit)];
  switch (e.type) {
    case "created":
      out.bizStep = out.bizStep ?? "commissioning";
      out.ilmd = {
        "vpb:color": e.color,
        "vpb:position": [...e.position],
        ...(e.emission ? { "vpb:emission": { ...e.emission } } : {}),
      };
      break;
    case "destroyed":
      out.bizStep = out.bizStep ?? "destroying";
      break;
    case "presence":
      out.disposition = e.present ? "active" : "inactive";
      break;
    case "moved":
      out["vpb:from"] = [...e.from];
      out["vpb:to"] = [...e.to];
      break;
    case "emitted": {
      const reports: Record<string, unknown>[] = [];
      if (e.emission.color !== undefined)
        reports.push({ type: "vpb:color", value: e.emission.color });
      if (e.emission.light !== undefined)
        reports.push({ type: "vpb:light", value: e.emission.light });
      if (e.emission.data !== undefined)
        reports.push({ type: "vpb:data", stringValue: JSON.stringify(e.emission.data) });
      out["vpb:slot"] = e.slot;
      out.sensorElementList = [{ sensorMetadata: { time: iso(e.time) }, sensorReport: reports }];
      break;
    }
    case "passport":
      out["vpb:passport"] = e.passport;
      break;
    case "annotated":
      out["vpb:annotation"] = { key: e.key, value: e.value === undefined ? null : e.value };
      break;
    default:
      break;
  }
  return out;
}

/** A whole log as one EPCISDocument, in sequence order. */
export function toEpcisDocument(
  events: Iterable<BitEvent>,
  opts: EpcisOptions = {},
): EpcisDocument {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return {
    "@context": [EPCIS_CONTEXT, { vpb: VPB_NS }],
    type: "EPCISDocument",
    schemaVersion: "2.0",
    creationDate: iso((opts.now ?? Date.now)()),
    epcisBody: { eventList: ordered.map((e) => toEpcisEvent(e, opts)) },
  };
}

/** Accumulates events and renders them as an EPCISDocument on demand. */
export class EpcisSink implements EventSink {
  readonly events: BitEvent[] = [];
  #opts: EpcisOptions;

  constructor(opts: EpcisOptions = {}) {
    this.#opts = opts;
  }

  record(event: BitEvent): void {
    this.events.push(event);
  }

  document(): EpcisDocument {
    return toEpcisDocument(this.events, this.#opts);
  }
}
