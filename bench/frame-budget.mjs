/**
 * Frame budget for the Three.js demo, measured in a headed Chromium.
 * Loads a size, orbits by dragging, and reports p50/p95 frame time and the
 * model pass time from the page's own counters. Requires a preview server
 * on http://localhost:4173 (npm run build && npm run preview).
 *
 * Run: node bench/frame-budget.mjs [size=32] [seconds=6]
 */
import { chromium } from "@playwright/test";

const size = Number(process.argv[2] ?? 32);
const seconds = Number(process.argv[3] ?? 6);
const url = process.env.VPB_URL ?? "http://localhost:4173/three/";

const browser = await chromium.launch({
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
await page.selectOption("#size", String(size));
await page.waitForTimeout(1500);
await page.evaluate(() => window.__vpb.loadSize(Number(document.getElementById("size").value)));
await page.waitForTimeout(1000);

const idleStart = Date.now();
while (Date.now() - idleStart < 2000) await page.waitForTimeout(100);
const idle = await page.evaluate(() => window.__vpb.frameStats());

// Orbit continuously for `seconds`.
const cx = 640;
const cy = 400;
const t0 = Date.now();
let angle = 0;
while (Date.now() - t0 < seconds * 1000) {
  const x1 = cx + Math.cos(angle) * 200;
  const y1 = cy + Math.sin(angle) * 120;
  angle += 0.6;
  const x2 = cx + Math.cos(angle) * 200;
  const y2 = cy + Math.sin(angle) * 120;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
}
const orbit = await page.evaluate(() => window.__vpb.frameStats());
const hud = await page.locator("#hud").textContent();
const backend = await page.getAttribute("body", "data-renderer");

console.log(`renderer ${backend}  size ${size}^3`);
console.log(`idle   p50 ${idle.p50.toFixed(1)} ms  p95 ${idle.p95.toFixed(1)} ms  n=${idle.n}`);
console.log(`orbit  p50 ${orbit.p50.toFixed(1)} ms  p95 ${orbit.p95.toFixed(1)} ms  n=${orbit.n}`);
console.log(
  hud
    .split("\n")
    .filter((l) => l.startsWith("model") || l.startsWith("nodes") || l.startsWith("awake"))
    .join("\n"),
);
await browser.close();
