/**
 * Both containers, side by side: heap per bit, fill time, and the three
 * per-frame costs, at dense sizes.
 *
 *   npm run bench:containers -- <grid|flat> [sizes=8,16,32,48,64]
 *
 * Run with --expose-gc for an honest heap number (the npm script does).
 * Grid needs --max-old-space-size=8192 above 32^3 and cannot reach 64^3;
 * that is the point of this bench.
 */
import { FlatGrid } from "../src/flat-grid.ts";
import { Grid } from "../src/grid.ts";
import { renderList } from "../src/render-list.ts";

const RED = { color: 0xff0000, light: 0.6 };
const camera = { position: [40, 30, 50] as const };
const gc = (globalThis as { gc?: () => void }).gc;
const which = process.argv[2] === "grid" ? "grid" : "flat";
const sizes = (process.argv[3] ?? "8,16,32,48,64").split(",").map(Number);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function timeIt(fn: () => void, reps: number): number {
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  return median(xs);
}

console.log(`container ${which}`);
for (const n of sizes) {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const g = which === "flat" ? new FlatGrid() : new Grid();
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.add([x, y, z], { emission: RED });
  const fill = performance.now() - t0;
  gc?.();
  const used = process.memoryUsage().heapUsed - before;
  g.evaluate(camera);
  const reps = n >= 48 ? 5 : 20;
  const cam = timeIt(() => g.cameraMoved(camera), reps);
  const rl = timeIt(() => renderList(g.awake), reps);
  const full = timeIt(
    () => {
      g.onCameraMoved();
      g.evaluate(camera);
    },
    Math.max(3, reps / 2),
  );
  const bits = n ** 3;
  console.log(
    [
      `${String(n).padStart(2)}^3 ${String(bits).padStart(7)} bits`,
      `fill ${fill.toFixed(0).padStart(6)} ms`,
      `heap ${(used / 1048576).toFixed(0).padStart(5)} MB`,
      `${(used / bits).toFixed(0).padStart(6)} B/bit`,
      `cameraMoved ${cam.toFixed(2).padStart(7)} ms`,
      `renderList ${rl.toFixed(2).padStart(7)} ms`,
      `evaluate ${full.toFixed(2).padStart(7)} ms`,
      `awake ${g.awake.length}`,
    ].join("  "),
  );
}
