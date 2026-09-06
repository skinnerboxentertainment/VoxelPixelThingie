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
  frameCount(): number;
  save(): Promise<{ ok: boolean; reason?: string; events?: number }>;
  load(): Promise<{ ok: boolean; reason?: string; bits?: number }>;
  selectFirstFaceBit(): string | undefined;
  setPassportOnSelected(obj: unknown): boolean;
  passportOf(id: string): unknown;
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
  expect(after.nodes).toBeGreaterThan(before.nodes);
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
  // Software GL on CI can take hundreds of ms per frame; assert the loop runs, not that it is fast.
  const read = () => page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.frameCount());
  const a = await read();
  await page.waitForTimeout(1500);
  const b = await read();
  expect(b).toBeGreaterThan(a);
});

void hook;

test("save to OPFS, reload the page, load: counts and a passport survive", async ({ page }) => {
  // OPFS writes one file per handle operation; 8^3 is about a thousand of them on CI's software stack.
  test.setTimeout(180_000);
  const w = () => (window as unknown as { __vpb: Hook }).__vpb;
  // Carve three bits and give one a passport.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.removeCenterFacingBit());
  }
  const id = await page.evaluate(() =>
    (window as unknown as { __vpb: Hook }).__vpb.selectFirstFaceBit(),
  );
  expect(id).toBeTruthy();
  const applied = await page.evaluate(() =>
    (window as unknown as { __vpb: Hook }).__vpb.setPassportOnSelected({ name: "keeper", n: 7 }),
  );
  expect(applied).toBe(true);
  const before = await counts(page);
  expect(before.bits).toBe(482);
  const saved = await page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.save());
  expect(saved.ok).toBe(true);

  await page.reload();
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  const fresh = await counts(page);
  expect(fresh.bits).toBe(485);
  const loaded = await page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.load());
  expect(loaded.ok).toBe(true);
  await page.waitForTimeout(200);
  const after = await counts(page);
  expect(after.bits).toBe(before.bits);
  expect(after.face).toBe(before.face);
  const passport = await page.evaluate(
    (bitId) => (window as unknown as { __vpb: Hook }).__vpb.passportOf(bitId),
    id as string,
  );
  expect(passport).toEqual({ name: "keeper", n: 7 });
  void w;
});

test("a fresh browser context has no saved scene and says so", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  const loaded = await page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.load());
  expect(loaded.ok).toBe(false);
  expect(loaded.reason).toMatch(/no saved scene|no origin private file system/);
  await context.close();
});
