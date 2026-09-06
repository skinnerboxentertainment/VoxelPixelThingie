/**
 * Senses (PLAN-4.md Phase 21, ADR 0015, SPEC.md §9.9). What a physical bit
 * feels lands in its own history as annotations under reserved keys
 * `sense:<quantity>`, each a reading with a value, a unit, a time, and
 * the device that read it. No new event type: readings are notes with
 * units, validated at the sink like job records, and exported as EPCIS
 * sensor reports in the CBV vocabulary.
 */
import type { BitHandle, Container } from "./container.ts";
import type { JsonValue } from "./json.ts";

export const SENSE_PREFIX = "sense:";

export interface Reading {
  value: number;
  /** UN/CEFACT common code, as EPCIS wants it: CEL, LUX, P1, PAL, C62. */
  uom: string;
  /** When the device read it, ms since the epoch. */
  time: number;
  /** The device, as a name or URI. */
  device?: string;
  min?: number;
  max?: number;
}

export interface Quantity {
  /** The CBV measurement type for the EPCIS sensor report. */
  type: string;
  /** The unit a device without one is assumed to use. */
  uom: string;
  /** The WLED sensor `type` letter that maps here, when one does. */
  wled?: string;
}

/**
 * The quantities a bit can report. CBV 2.0 names the physical ones;
 * touch is ours (`vpb:Touch`, unitless C62), a count of contacts.
 */
export const QUANTITIES: Record<string, Quantity> = {
  temperature: { type: "gs1:Temperature", uom: "CEL", wled: "T" },
  illuminance: { type: "gs1:Illuminance", uom: "LUX", wled: "L" },
  humidity: { type: "gs1:Humidity", uom: "P1", wled: "H" },
  pressure: { type: "gs1:Pressure", uom: "PAL", wled: "P" },
  touch: { type: "vpb:Touch", uom: "C62" },
};

export const isSenseKey = (key: string): boolean => key.startsWith(SENSE_PREFIX);
export const senseKey = (quantity: string): string => `${SENSE_PREFIX}${quantity}`;
export const quantityOf = (key: string): string => key.slice(SENSE_PREFIX.length);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Refuse a malformed reading at the door. Other keys pass through. */
export function validateSenseAnnotation(key: string, value: unknown): void {
  if (!isSenseKey(key)) return;
  const q = quantityOf(key);
  if (!q) throw new Error(`${key}: the quantity is empty`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${key}: a reading is an object`);
  const r = value as Record<string, unknown>;
  if (!finite(r.value)) throw new Error(`${key}: value must be a finite number`);
  if (typeof r.uom !== "string" || r.uom.length === 0 || r.uom.length > 8)
    throw new Error(`${key}: uom must be a UN/CEFACT code`);
  if (!finite(r.time)) throw new Error(`${key}: time must be a number`);
  if (r.device !== undefined && typeof r.device !== "string")
    throw new Error(`${key}: device must be a string`);
  if (r.min !== undefined && !finite(r.min)) throw new Error(`${key}: min must be a number`);
  if (r.max !== undefined && !finite(r.max)) throw new Error(`${key}: max must be a number`);
}

/** A WLED `info.sensor` entry, the draft shape usermods use. */
export interface WledSensor {
  type: string;
  n?: string;
  val?: unknown;
  unit?: string;
  tm?: number;
  min?: number;
  max?: number;
}

const WLED_UNITS: Record<string, string> = {
  "°C": "CEL",
  C: "CEL",
  "°F": "FAH",
  F: "FAH",
  lx: "LUX",
  lux: "LUX",
  "%": "P1",
  Pa: "PAL",
  hPa: "A97",
};

/**
 * A WLED sensor entry as a (key, reading), or undefined when the type is
 * not one the bit senses. The device's unit string maps to a UN/CEFACT
 * code; a missing unit is the quantity's default.
 */
export function readingFromWled(
  sensor: WledSensor,
  time: number,
  device?: string,
): { key: string; reading: Reading } | undefined {
  const entry = Object.entries(QUANTITIES).find(([, q]) => q.wled === sensor.type);
  if (!entry || !finite(sensor.val)) return undefined;
  const [quantity, q] = entry;
  const uom = sensor.unit ? (WLED_UNITS[sensor.unit] ?? q.uom) : q.uom;
  return {
    key: senseKey(quantity),
    reading: {
      value: sensor.val,
      uom,
      time,
      ...(device ? { device } : {}),
      ...(finite(sensor.min) ? { min: sensor.min } : {}),
      ...(finite(sensor.max) ? { max: sensor.max } : {}),
    },
  };
}

/** Write readings into a bit's history under the device as actor. */
export function recordReadings(
  grid: Container,
  bit: BitHandle,
  readings: { key: string; reading: Reading }[],
  device: string,
): void {
  grid.wrangle({ actor: `device:${device}`, cause: "sense" }, () => {
    for (const { key, reading } of readings) bit.annotate(key, reading as unknown as JsonValue);
  });
}
