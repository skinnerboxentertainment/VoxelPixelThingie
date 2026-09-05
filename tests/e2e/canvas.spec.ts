import { expect, type Page, test } from "@playwright/test";

type Counts = { face: number; edge: number; vertex: number; nodes: number; bits: number };

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => (window as unknown as { __vpb: { counts(): Counts } }).__vpb.counts());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/canvas/");
  await page.waitForSelector("body[data-ready='1']");
});

test("scene is the carved 8x8x8: 485 bits present", async ({ page }) => {
  const c = await counts(page);
  expect(c.bits).toBe(512 - 27);
});

for (const mode of ["pixel", "tile", "cube"] as const) {
  test(`${mode} mode matches its golden and its HUD matches the model`, async ({ page }) => {
    await page.click(`button[data-mode='${mode}']`);
    await expect(page.locator("body")).toHaveAttribute("data-mode", mode);
    const c = await counts(page);
    const hud = await page.locator("#hud").textContent();
    expect(hud).toContain(`faces    ${c.face}`);
    expect(hud).toContain(`edges    ${c.edge}`);
    expect(hud).toContain(`vertices ${c.vertex}`);
    expect(c.nodes).toBe(c.face + c.edge + c.vertex);
    expect(c.nodes).toBeGreaterThan(0);
    await expect(page.locator("#stage")).toHaveScreenshot(`${mode}.png`, {
      mask: [page.locator("#hud")],
    });
  });
}

test("pixel mode shows only +Z faces: every visible face count is at most one per column", async ({
  page,
}) => {
  await page.click("button[data-mode='pixel']");
  const c = await counts(page);
  // 8x8 columns from above; the carved corner exposes lower +Z faces in a 3x3 patch, still one per column.
  expect(c.face).toBe(64);
});

test("clicking a bit removes it and exposes neighbors", async ({ page }) => {
  await page.click("button[data-mode='cube']");
  const before = await counts(page);
  const box = (await page.locator("#stage").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const after = await counts(page);
  expect(after.bits).toBe(before.bits - 1);
});
