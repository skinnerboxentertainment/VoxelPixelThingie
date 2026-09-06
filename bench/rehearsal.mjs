/**
 * Demo rehearsal: runs the PLAN.md §8 script against a live URL and times
 * it. Every step prints what the audience would see in the HUD. Fails if a
 * step's number is wrong or the whole thing takes over eight minutes.
 *
 * Run: node bench/rehearsal.mjs [baseUrl]
 * Default base: the GitHub Pages URL. Headed, so WebGPU is available.
 */
import { chromium } from "@playwright/test";

const base = (
  process.argv[2] ?? "https://skinnerboxentertainment.github.io/VoxelPixelThingie/"
).replace(/\/?$/, "/");
const BUDGET_S = 480;
const t0 = Date.now();
const steps = [];
let failed = 0;

function step(name, ok, detail) {
  const t = ((Date.now() - t0) / 1000).toFixed(1);
  steps.push({ name, ok, detail, t });
  console.log(`${ok ? "ok " : "FAIL"} ${t.padStart(6)}s  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch({
  headless: false,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const hook = (fn) => page.evaluate(fn);
const ready = () => page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });

// 0. Landing
await page.goto(base);
const cards = await page.locator("a.card").count();
step("landing lists the demos and the API", cards >= 4, `${cards} cards`);

// 1–3. Canvas: pixel, tile, cube
await page.goto(`${base}canvas/`);
await ready();
for (const [mode, faces] of [
  ["pixel", 64],
  ["tile", 192],
  ["cube", 192],
]) {
  await page.click(`button[data-mode='${mode}']`);
  const c = await hook(() => window.__vpb.counts());
  step(
    `canvas ${mode} mode`,
    c.bits === 485 && c.face === faces,
    `bits ${c.bits} faces ${c.face} edges ${c.edge} vertices ${c.vertex}`,
  );
}

// 4–5. Three.js: orbit and HUD
await page.goto(`${base}three/`);
await ready();
const backend = await page.getAttribute("body", "data-renderer");
let c = await hook(() => window.__vpb.counts());
step(
  "three.js 8³ loads",
  c.bits === 485 && backend !== "none",
  `renderer ${backend} awake ${c.awake} nodes ${c.nodes}`,
);
for (let i = 0; i < 6; i++) {
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(600 + (i % 2 ? 180 : -180), 380, { steps: 10 });
  await page.mouse.up();
}
const fs = await hook(() => window.__vpb.frameStats());
step(
  "three.js orbit is smooth",
  fs.n > 30,
  `p50 ${fs.p50.toFixed(1)} ms p95 ${fs.p95.toFixed(1)} ms`,
);

// 6. Carve: one bit leaves, the pit exposes the bit beneath and four sides.
const before = await hook(() => window.__vpb.counts());
await hook(() => window.__vpb.removeCenterFacingBit());
await page.waitForTimeout(150);
c = await hook(() => window.__vpb.counts());
step(
  "three.js carve one bit, neighbors expose",
  c.bits === before.bits - 1 && c.nodes > before.nodes,
  `bits ${before.bits} to ${c.bits}, nodes ${before.nodes} to ${c.nodes}`,
);

// 7. Scale to 32³
await page.selectOption("#size", "32");
await page.waitForTimeout(2500);
for (let i = 0; i < 6; i++) {
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(600 + (i % 2 ? 180 : -180), 380, { steps: 10 });
  await page.mouse.up();
}
c = await hook(() => window.__vpb.counts());
const fs32 = await hook(() => window.__vpb.frameStats());
step(
  "three.js 32³ same code",
  c.bits === 32768 - 27,
  `awake ${c.awake} nodes ${c.nodes} p50 ${fs32.p50.toFixed(1)} ms p95 ${fs32.p95.toFixed(1)} ms`,
);

// 8. PixiJS pixel mode
await page.goto(`${base}pixi/`);
await ready();
c = await hook(() => window.__vpb.counts());
step(
  "pixi pixel mode: one face per column",
  c.face === 256 && c.bits === 491,
  `bits ${c.bits} faces ${c.face}`,
);
await page.click("button[data-mode='tile']");
c = await hook(() => window.__vpb.counts());
step("pixi tile toggle", c.face > 256, `faces ${c.face}`);

// 9. API docs
const api = await page.goto(`${base}api/`);
step("api docs served", api?.ok() ?? false, `status ${api?.status()}`);

await browser.close();
const total = (Date.now() - t0) / 1000;
console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${steps.length - failed}/${steps.length} steps in ${total.toFixed(1)} s (budget ${BUDGET_S} s)`,
);
process.exit(failed === 0 && total < BUDGET_S ? 0 : 1);
