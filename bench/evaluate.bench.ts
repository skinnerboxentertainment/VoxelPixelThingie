/**
 * How long does the self-test take on dense blocks?
 * Run: npm run bench. Prints median and p99 per size in milliseconds.
 * 64^3 needs --max-old-space-size=8192; see memory.bench.ts for why.
 */
import { Bench } from "tinybench";
import { Grid } from "../src/grid.ts";
import { renderList } from "../src/render-list.ts";

const RED = { color: 0xff0000 };
const camera = { position: [40, 30, 50] as const };

const bench = new Bench({ time: 500, warmupTime: 100 });

for (const n of [8, 16, 32]) {
  const grid = Grid.fill(n, n, n, { emission: RED });
  grid.evaluate(camera);
  bench.add(`evaluate ${n}^3 after camera move`, () => {
    grid.onCameraMoved();
    grid.evaluate(camera);
  });
  bench.add(`renderList ${n}^3`, () => {
    renderList(grid.bits());
  });
}

const fill = new Bench({ time: 500, warmupTime: 100 });
fill.add("Grid.fill 16^3 (links included)", () => {
  Grid.fill(16, 16, 16, { emission: RED });
});

await bench.run();
await fill.run();

for (const b of [bench, fill]) {
  for (const t of b.tasks) {
    const r = t.result;
    if (!r) continue;
    const ms = (x: number) => x.toFixed(3).padStart(9);
    console.log(
      `${t.name.padEnd(40)} median ${ms(r.latency.p50)} ms  p99 ${ms(r.latency.p99)} ms  n=${r.latency.samplesCount}`,
    );
  }
}
