/**
 * The physical bit's LED map (PLAN-2.md Phase 10). One strip of WS2812-class
 * LEDs runs through a cube frame; each of the 26 nodes owns a contiguous
 * range of it. The map is JSON so it can ride in the bit's passport under
 * the key `ledMap`, and `ledFrame` turns a bit's emissions into the RGB
 * bytes a DDP sender pushes to the strip.
 *
 * The default map is the bill of materials in the plan: 6 faces x 4 LEDs,
 * 12 edges x 3, 8 corners x 1, 68 LEDs, in slot order.
 */
import type { JsonObject } from "./json.ts";
import { kindOf, NODE_COUNT, type NodeKind } from "./slots.ts";
import { type Emission, isSilent } from "./vpb.ts";

export const LED_MAP_FORMAT = "vpb-led-map/1";
/** Bytes per LED on the wire: R, G, B. */
export const LED_CHANNELS = 3;

export interface LedRange {
  /** First LED of the node, counted from the start of the strip. */
  start: number;
  /** LEDs in the node; zero means the node has none. */
  count: number;
}

export interface LedMap {
  format: typeof LED_MAP_FORMAT;
  /** LEDs on the strip. */
  leds: number;
  /** One range per slot, indexed by slot number, 26 entries. */
  slots: LedRange[];
}

export const DEFAULT_LEDS_PER_KIND: Readonly<Record<NodeKind, number>> = {
  face: 4,
  edge: 3,
  vertex: 1,
};

/** Slots in order, each taking the LEDs its kind is given. */
export function defaultLedMap(
  perKind: Readonly<Record<NodeKind, number>> = DEFAULT_LEDS_PER_KIND,
): LedMap {
  const slots: LedRange[] = [];
  let next = 0;
  for (let slot = 0; slot < NODE_COUNT; slot++) {
    const count = perKind[kindOf(slot)];
    slots.push({ start: next, count });
    next += count;
  }
  return { format: LED_MAP_FORMAT, leds: next, slots };
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Throws with the first thing wrong; returns the map typed when nothing is. */
export function validateLedMap(value: unknown): LedMap {
  if (typeof value !== "object" || value === null) throw new Error("led map: not an object");
  const m = value as Record<string, unknown>;
  if (m.format !== LED_MAP_FORMAT) throw new Error(`led map: format is not ${LED_MAP_FORMAT}`);
  if (!isInt(m.leds) || m.leds < 0) throw new Error("led map: leds must be a non-negative integer");
  if (!Array.isArray(m.slots) || m.slots.length !== NODE_COUNT)
    throw new Error(`led map: slots must have ${NODE_COUNT} entries`);
  const taken = new Uint8Array(m.leds);
  m.slots.forEach((r: unknown, slot: number) => {
    if (typeof r !== "object" || r === null)
      throw new Error(`led map: slot ${slot} is not a range`);
    const { start, count } = r as Record<string, unknown>;
    if (!isInt(start) || start < 0 || !isInt(count) || count < 0)
      throw new Error(`led map: slot ${slot} needs non-negative integer start and count`);
    if (start + count > (m.leds as number))
      throw new Error(`led map: slot ${slot} runs past the strip (${start}+${count} > ${m.leds})`);
    for (let i = start; i < start + count; i++) {
      if (taken[i]) throw new Error(`led map: LED ${i} belongs to two slots`);
      taken[i] = 1;
    }
  });
  return value as LedMap;
}

export function ledMapFromJson(text: string): LedMap {
  return validateLedMap(JSON.parse(text));
}

/** The map a bit carries in its passport under `ledMap`, if it has one that validates. */
export function ledMapOf(passport: JsonObject): LedMap | undefined {
  const candidate = passport.ledMap;
  if (candidate === undefined) return undefined;
  return validateLedMap(candidate);
}

/** What `ledFrame` reads; a BitRecord satisfies it. */
export interface LitBit {
  present: boolean;
  /** The bit's own color, used by an emission that names light but no color. */
  color: number;
  /** Per slot; a missing or silent entry means the node is dark. */
  emissions: readonly (Emission | undefined)[];
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The strip's RGB bytes for a bit, `map.leds * 3` long. An absent bit is
 * dark. A node's color is its emission's color, or the bit's color when the
 * emission has none, scaled by its light (default 1, clamped to 0..1).
 * A silent emission is dark. `data` does not light anything.
 */
export function ledFrame(bit: LitBit, map: LedMap, into?: Uint8Array): Uint8Array {
  const out = into ?? new Uint8Array(map.leds * LED_CHANNELS);
  if (out.length !== map.leds * LED_CHANNELS)
    throw new Error(
      `led frame: buffer is ${out.length} bytes, map needs ${map.leds * LED_CHANNELS}`,
    );
  out.fill(0);
  if (!bit.present) return out;
  for (let slot = 0; slot < NODE_COUNT; slot++) {
    const e = bit.emissions[slot];
    if (!e || isSilent(e)) continue;
    if (e.color === undefined && e.light === undefined) continue; // data only
    const color = e.color ?? bit.color;
    const light = clamp01(e.light ?? 1);
    const r = Math.round(((color >>> 16) & 0xff) * light);
    const g = Math.round(((color >>> 8) & 0xff) * light);
    const b = Math.round((color & 0xff) * light);
    const range = map.slots[slot];
    if (!range) continue;
    for (let i = range.start; i < range.start + range.count; i++) {
      out[i * LED_CHANNELS] = r;
      out[i * LED_CHANNELS + 1] = g;
      out[i * LED_CHANNELS + 2] = b;
    }
  }
  return out;
}

export const LED_FRAME_FORMAT = "vpb-led-frame/1";

/**
 * What a renderer posts to the LED bridge (scripts/led-bridge.ts): the bit
 * as it is now, with the time of the event that changed it, so the bridge
 * can measure event-to-packet latency.
 */
export interface LedFramePost extends LitBit {
  format: typeof LED_FRAME_FORMAT;
  bit: string;
  /** The event's time, ms since the epoch, on the poster's clock. */
  time: number;
  /** A map carried with the post; the bridge's own map is used otherwise. */
  map?: LedMap;
}

/** Reads a post's JSON as a frame post, or throws with the reason. */
export function parseFramePost(text: string): LedFramePost {
  const body = JSON.parse(text) as Record<string, unknown>;
  if (body.format !== LED_FRAME_FORMAT) throw new Error(`format is not ${LED_FRAME_FORMAT}`);
  if (typeof body.bit !== "string") throw new Error("bit must be a string");
  if (typeof body.time !== "number") throw new Error("time must be a number");
  if (typeof body.present !== "boolean") throw new Error("present must be a boolean");
  if (typeof body.color !== "number") throw new Error("color must be a number");
  if (!Array.isArray(body.emissions)) throw new Error("emissions must be an array");
  if (body.map !== undefined) validateLedMap(body.map);
  return body as unknown as LedFramePost;
}
