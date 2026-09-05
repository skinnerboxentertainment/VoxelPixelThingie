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
  setMode(m: string): void;
  removeAt(x: number, y: number, z: number): boolean;
};

const CARVED = 16 + 5; // 4x4 window plus a 5-cell diagonal

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => (window as unknown as { __vpb: Hook }).__vpb.counts());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/pixi/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
});

test("two 16x16 layers minus the carved cells", async ({ page }) => {
  const c = await counts(page);
  expect(c.bits).toBe(2 * 16 * 16 - CARVED);
});

test("pixel mode shows exactly one face per column and nine-node bits", async ({ page }) => {
  await page.click("button[data-mode='pixel']");
  const c = await counts(page);
  expect(c.face).toBe(256);
  // Every rendered node is one of the nine +Z-side nodes: no side faces, no back edges.
  const hud = await page.locator("#hud").textContent();
  expect(hud).toContain(`faces    ${c.face}`);
  expect(hud).toContain(`edges    ${c.edge}`);
  expect(hud).toContain(`vertices ${c.vertex}`);
  expect(c.nodes).toBe(c.face + c.edge + c.vertex);
});

test("tile mode exposes side faces of the carved cells", async ({ page }) => {
  await page.click("button[data-mode='tile']");
  const c = await counts(page);
  expect(c.face).toBeGreaterThan(256);
  await expect(page.locator("body")).toHaveAttribute("data-mode", "tile");
});

test("the stage is not blank", async ({ page }) => {
  const png = await page.locator("#stage").screenshot();
  // A single-color 800x600 PNG is a few hundred bytes; a drawn scene is far larger.
  expect(png.length).toBeGreaterThan(8000);
});

test("removing a front pixel reveals the back layer face beneath it", async ({ page }) => {
  await page.click("button[data-mode='pixel']");
  const before = await counts(page);
  const removed = await page.evaluate(() =>
    (window as unknown as { __vpb: Hook }).__vpb.removeAt(0, 0, 0),
  );
  expect(removed).toBe(true);
  const after = await counts(page);
  expect(after.bits).toBe(before.bits - 1);
  expect(after.face).toBe(256);
});
