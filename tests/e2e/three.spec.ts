import { expect, type Page, test } from "@playwright/test";

type Counts = {
  face: number;
  edge: number;
  vertex: number;
  nodes: number;
  bits: number;
  awake: number;
};
type Hook = {
  counts(): Counts;
  frameStats(): { p50: number; p95: number; n: number };
  removeCenterFacingBit(): string | undefined;
  loadSize(n: number): void;
  backend(): string;
};

const hook = <T>(page: Page, fn: (h: Hook) => T) =>
  page.evaluate(fn as unknown as (h: Hook) => T, undefined as never) as Promise<T>;

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.counts());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
});

test("scene is the carved 8x8x8 and the HUD matches the model", async ({ page }) => {
  const c = await counts(page);
  expect(c.bits).toBe(485);
  expect(c.nodes).toBe(c.face + c.edge + c.vertex);
  expect(c.awake).toBeLessThan(c.bits);
  const backend = await page.getAttribute("body", "data-renderer");
  test.info().annotations.push({ type: "renderer", description: backend ?? "unknown" });
  const hud = await page.locator("#hud").textContent();
  expect(hud).toContain(`bits     ${c.bits} present`);
  expect(hud).toContain(`faces    ${c.face}`);
});

test("removing a bit through the hook drops the count by one and re-exposes", async ({ page }) => {
  const before = await counts(page);
  const removed = await page.evaluate(() =>
    (window as unknown as { __vpb: Hook }).__vpb.removeCenterFacingBit(),
  );
  expect(removed).toBeTruthy();
  await page.waitForTimeout(100);
  const after = await counts(page);
  expect(after.bits).toBe(before.bits - 1);
  expect(after.nodes).toBeGreaterThan(0);
});

test("size 16 loads 4069 bits", async ({ page }) => {
  await page.selectOption("#size", "16");
  await page.waitForTimeout(200);
  const c = await counts(page);
  expect(c.bits).toBe(16 * 16 * 16 - 27);
});

test("renderer reports a backend and frames are being timed when it exists", async ({ page }) => {
  const backend = await page.getAttribute("body", "data-renderer");
  expect(["webgpu", "webgl2", "none"]).toContain(backend);
  test.skip(backend === "none", "no GPU path in this environment");
  await page.waitForTimeout(600);
  const fs = await page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.frameStats());
  expect(fs.n).toBeGreaterThan(5);
});

void hook;
