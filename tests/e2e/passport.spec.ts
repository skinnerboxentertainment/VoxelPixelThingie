import { expect, type Page, test } from "@playwright/test";

type Shown = {
  id: string;
  frame: string;
  present: boolean;
  emissions: number;
  events: number;
  qr: boolean;
};

const shown = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __vpb: { shown(): Shown | undefined } }).__vpb.shown(),
  );

test("the built-in reference scene's first bit: identity, 26 lit nodes, its history, and a QR of this page", async ({
  page,
}) => {
  await page.goto("/passport/?scene=builtin&id=first");
  await page.waitForSelector("body[data-ready='1']");
  await page.waitForSelector("body[data-qr='1']");
  const s = (await shown(page))!;
  expect(s).toBeTruthy();
  expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.present).toBe(true);
  expect(s.emissions).toBe(26);
  expect(s.events).toBeGreaterThan(0);
  expect(s.qr).toBe(true);
  await expect(page.locator("#f-id")).toHaveText(s.id);
  await expect(page.locator("#f-frame")).toHaveText(s.frame);
  await expect(page.locator("#f-epc")).toContainText(`/ns/bit/${s.id}`);
  await expect(page.locator("#f-emissions tbody tr")).toHaveCount(26);
  await expect(page.locator("#f-events tbody tr")).toHaveCount(s.events);
  // The QR encodes this page's own address with the bit's id.
  await expect(page.locator("#qr-url")).toContainText(`/passport/?id=${s.id}&scene=builtin`);
  // The canvas was drawn: it is not blank.
  const painted = await page.evaluate(() => {
    const c = document.getElementById("qr") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
    return dark;
  });
  expect(painted).toBeGreaterThan(1000);
});

test("an unknown bit id reports the problem instead of a blank page", async ({ page }) => {
  await page.goto("/passport/?scene=builtin&id=00000000-0000-7000-8000-000000000000");
  await page.waitForSelector("body[data-ready='1']");
  await expect(page.locator("#error")).toContainText("no bit 00000000-0000-7000-8000-000000000000");
  await expect(page.locator("#bit")).toBeHidden();
});

test("with no id the page waits for the form", async ({ page }) => {
  await page.goto("/passport/");
  await page.waitForSelector("body[data-ready='1']");
  await expect(page.locator("#bit")).toBeHidden();
  await expect(page.locator("#error")).toHaveText("");
});
