/**
 * Heap cost of dense blocks. Run: node --experimental-strip-types --expose-gc --max-old-space-size=8192 bench/memory.bench.ts
 * Prints heap used after fill, per size, and bytes per bit.
 */
import { Grid } from "../src/grid.ts";

const RED = { color: 0xff0000 };
const gc = (globalThis as { gc?: () => void }).gc;
const sizes = (process.argv[2] ?? "8,16,32,48").split(",").map(Number);

for (const n of sizes) {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const g = Grid.fill(n, n, n, { emission: RED });
  const t1 = performance.now();
  gc?.();
  const used = process.memoryUsage().heapUsed - before;
  const bits = n * n * n;
  console.log(
    `${String(n).padStart(2)}^3 = ${String(bits).padStart(7)} bits  fill ${(t1 - t0).toFixed(0).padStart(6)} ms  heap ${(used / 1048576).toFixed(0).padStart(5)} MB  ${(used / bits).toFixed(0).padStart(5)} B/bit`,
  );
  void g.size;
}
