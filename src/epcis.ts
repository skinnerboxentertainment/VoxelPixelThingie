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
 * Identifiers are web URIs under the project namespace: a bit is
 * <VPB_NS>bit/<uuid>, the container is the readPoint <VPB_NS>frame/<id>,
 * and an actor is an owning_party source <VPB_NS>actor/<slug>. EPCIS 2.0
 * allows any URI, and urn:uuid: would be the shorter choice, but OpenEPCIS
 * runs every urn: EPC, readPoint, and source through its GS1 identifier
 * translator and rejects the ones that are not GS1 URNs; web URIs pass
 * untouched. The prefixes are options for a deployment that wants urn:uuid:
 * or GS1 Digital Link forms. The event id stays a URN, which is not
 * translated. A wrangler's cause becomes a bizStep under the project
 * namespace. Extension fields use the `vpb:` prefix declared in the
 * document's @context.
 */
import type { BitEvent, EventSink } from "./events.ts";
import { isJobKey, jobStep } from "./jobs.ts";
import { isSenseKey, QUANTITIES, quantityOf, type Reading } from "./senses.ts";

export const VPB_NS = "https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/";
export const EPCIS_CONTEXT = "https://ref.gs1.org/standards/epcis/epcis-context.jsonld";

export interface EpcisOptions {
  /** Prefix for bit ids in epcList, parentID, and childEPCs. Default <VPB_NS>bit/ */
  bitPrefix?: string;
  /** Prefix for readPoint ids built from a container id. Default <VPB_NS>frame/ */
  framePrefix?: string;
  /** Prefix for actor party ids. Default <VPB_NS>actor/ */
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
  const bitPrefix = opts.bitPrefix ?? `${VPB_NS}bit/`;
  const framePrefix = opts.framePrefix ?? `${VPB_NS}frame/`;
  const actorPrefix = opts.actorPrefix ?? `${VPB_NS}actor/`;
  const bitUri = (id: string) => `${bitPrefix}${id}`;
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
    out.parentID = bitUri(e.bit);
    out.childEPCs = [bitUri(neighbor)];
    if (e.type === "linked") {
      out["vpb:slot"] = e.slot;
      out["vpb:partner"] = e.partner;
      out["vpb:offset"] = [...e.offset];
    } else if (e.type === "unlinked") {
      out["vpb:slot"] = e.slot;
    }
    return out;
  }

  out.epcList = [bitUri(e.bit)];
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
      if (isSenseKey(e.key)) {
        // A reading is a sensor report in the CBV vocabulary (SPEC.md §9.9): the standard
        // fields, so any EPCIS system reads it as a sensor event without our extension.
        const r = e.value as Reading;
        const q = QUANTITIES[quantityOf(e.key)];
        out.bizStep = out.bizStep ?? `${VPB_NS}bizstep/sensing`;
        out.sensorElementList = [
          {
            sensorMetadata: {
              time: iso(r.time),
              ...(r.device ? { deviceID: deviceUri(r.device, VPB_NS) } : {}),
            },
            sensorReport: [
              {
                type: q?.type ?? `vpb:${quantityOf(e.key)}`,
                value: r.value,
                uom: r.uom,
                ...(r.min !== undefined ? { minValue: r.min } : {}),
                ...(r.max !== undefined ? { maxValue: r.max } : {}),
              },
            ],
          },
        ];
        break;
      }
      if (isJobKey(e.key)) {
        // Work is an observation with a sensor report carrying the record (SPEC.md §9.7).
        // The job step is the business step, whatever cause the wrangler gave.
        out.bizStep = `${VPB_NS}bizstep/${jobStep(e.key)}`;
        out.sensorElementList = [
          {
            sensorMetadata: { time: iso(e.time) },
            sensorReport: [{ type: "vpb:job", stringValue: JSON.stringify(e.value ?? null) }],
          },
        ];
      }
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

/** A device name as a URI under the project namespace; a URI stays as it is. */
function deviceUri(device: string, ns: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(device) ? device : `${ns}device/${slug(device)}`;
}
