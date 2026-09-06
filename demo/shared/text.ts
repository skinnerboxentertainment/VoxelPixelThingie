/**
 * A scene as words (PLAN-4.md Phase 24): one line per bit, in reading
 * order (z, then y, then x), with what the canvas would show and the
 * passport. The same lines go to a screen reader in the demos and to a
 * terminal from scripts/scene-text.ts.
 */
import type { BitHandle, Container } from "../../src/index.ts";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export function bitLine(b: BitHandle): string {
  const rec = b.record();
  const lit = rec.emissions.filter((e) => e.color !== undefined || e.light !== undefined).length;
  const passport = Object.keys(rec.passport).length
    ? ` passport ${JSON.stringify(rec.passport)}`
    : "";
  return `bit ${rec.id} at ${rec.position.join(",")}: ${rec.present ? "present" : "absent"}, color ${hex(rec.color)}, ${lit} of 26 nodes lit${passport}`;
}

/** Header line first, then every bit the container holds, absent ones included. */
export function sceneTextLines(grid: Container): string[] {
  const bits = [...grid.bits()].sort((a, b) => {
    const p = a.position;
    const q = b.position;
    return p[2] - q[2] || p[1] - q[1] || p[0] - q[0];
  });
  const present = bits.filter((b) => b.present).length;
  return [`scene ${grid.id}: ${present} present bits of ${bits.length}`, ...bits.map(bitLine)];
}
