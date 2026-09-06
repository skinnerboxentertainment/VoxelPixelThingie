/**
 * JSON value types and the serializability check used by passports
 * (SPEC.md §9.5). A passport must survive JSON.stringify and parse
 * unchanged, so functions, symbols, bigints, cycles, and non-finite numbers
 * are rejected before the model accepts it.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Throws with a path when `value` cannot be represented in JSON. */
export function assertJsonSerializable(value: unknown, path = "$"): void {
  const seen = new Set<object>();
  const walk = (v: unknown, at: string): void => {
    if (v === null) return;
    switch (typeof v) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(v)) throw new TypeError(`${at}: non-finite number`);
        return;
      case "undefined":
        throw new TypeError(`${at}: undefined is not JSON`);
      case "function":
      case "symbol":
      case "bigint":
        throw new TypeError(`${at}: ${typeof v} is not JSON`);
      case "object": {
        const o = v as object;
        if (seen.has(o)) throw new TypeError(`${at}: cycle`);
        seen.add(o);
        if (Array.isArray(o)) {
          for (let i = 0; i < o.length; i++) walk(o[i], `${at}[${i}]`);
        } else {
          const proto = Object.getPrototypeOf(o);
          if (proto !== Object.prototype && proto !== null) {
            throw new TypeError(`${at}: only plain objects and arrays are JSON`);
          }
          for (const [k, item] of Object.entries(o)) walk(item, `${at}.${k}`);
        }
        seen.delete(o);
        return;
      }
      default:
        throw new TypeError(`${at}: unsupported value`);
    }
  };
  walk(value, path);
}

/** A detached copy that is exactly what a reader of the serialized form would see. */
export function jsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
