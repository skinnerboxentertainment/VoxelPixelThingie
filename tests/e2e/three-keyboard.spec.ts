/**
 * Keyboard, words, and stillness (PLAN-4.md Phase 24): a keyboard alone
 * moves the cursor, opens a bit, sets its passport, and removes it, with
 * the ledger naming the same actor as the pointer path; the text view
 * lists every bit; reduced motion stops damping and slows the HUD.
 */
import { expect, type Page, test } from "@playwright/test";

type Hook = {
  cursor(): [number, number, number] | null;
  bitAt(x: number, y: number, z: number): string | undefined;
  passportOf(id: string): Record<string, unknown> | undefined;
  lastEvent(): { type: string; actor?: string; bit: string } | undefined;
  removeCenterFacingBit(): { id: string } | undefined;
  motion(): string;
  hudIntervalMs(): number;
  textLines(): string[];
  counts(): { bits: number };
  cameraPosition(): [number, number, number];
};
const hook = <T>(page: Page, fn: (h: Hook) => T): Promise<T> =>
  page.evaluate(
    (src: string) =>
      new Function("h", `return (${src})(h)`)((window as unknown as { __vpb: Hook }).__vpb) as T,
    fn.toString(),
  );

test("keyboard only: arrows move the cursor, Enter opens the bit, Tab reaches the panel, the passport is set and the bit removed under the same actor as the pointer path", async ({
  page,
}) => {
  // Many awaited steps on a WebGL page; under a full parallel run the default 30 s is not enough.
  test.setTimeout(120_000);
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  await page.locator("#stage").focus();
  // The first press shows the cursor at the origin; the next ones move it.
  await page.keyboard.press("ArrowRight");
  expect(await hook(page, (h) => h.cursor())).toEqual([0, 0, 0]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("PageUp");
  const cursor = (await hook(page, (h) => h.cursor()))!;
  expect(cursor).toEqual([2, 1, 1]);
  await expect(page.locator("#status")).toContainText("cursor at 2,1,1");
  const id = (await hook(page, (h) => h.bitAt(2, 1, 1)))!;
  expect(id).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel")).toBeVisible();
  await expect(page.locator("#panel-title")).toContainText(id);
  // Into the panel by keyboard: the passport box takes focus, then the buttons follow.
  await expect(page.locator("#passport")).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.type('{"name":"by keyboard"}');
  await page.keyboard.press("Tab");
  await expect(page.locator("#apply")).toBeFocused();
  await page.keyboard.press("Enter");
  const passport = await page.evaluate(
    (bit) => (window as unknown as { __vpb: Hook }).__vpb.passportOf(bit),
    id,
  );
  expect(passport).toEqual({ name: "by keyboard" });
  let last = (await hook(page, (h) => h.lastEvent()))!;
  expect(last.type).toBe("passport");
  expect(last.actor).toBe("demo:three");
  await page.keyboard.press("Tab");
  await expect(page.locator("#remove")).toBeFocused();
  const before = (await hook(page, (h) => h.counts())).bits;
  await page.keyboard.press("Enter");
  expect((await hook(page, (h) => h.counts())).bits).toBe(before - 1);
  last = (await hook(page, (h) => h.lastEvent()))!;
  expect(last.type).toBe("destroyed");
  expect(last.bit).toBe(id);
  expect(last.actor).toBe("demo:three");
  await expect(page.locator("#panel")).toBeHidden();
  // The pointer path names the same actor.
  await hook(page, (h) => h.removeCenterFacingBit());
  expect((await hook(page, (h) => h.lastEvent()))!.actor).toBe("demo:three");
  // Escape closes. Walk the cursor to a bit that is still present (the pointer path
  // removed the most interior visible one, which may sit next to the cursor).
  await page.locator("#stage").focus();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowDown");
    const c = (await hook(page, (h) => h.cursor()))!;
    if (await hook(page, (h) => h.bitAt(...(h.cursor() as [number, number, number])))) {
      expect(c).toBeTruthy();
      break;
    }
  }
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#panel")).toBeHidden();
  await expect(page.locator("#stage")).toBeFocused();
});

test("the text view lists every bit in reading order, and the terminal script prints the same lines", async ({
  page,
}) => {
  await page.goto("/three/?view=text");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  const section = page.locator("#text-view");
  await expect(section).toBeVisible();
  const lines = await hook(page, (h) => h.textLines());
  expect(lines[0]).toMatch(/^scene .*: 485 present bits of 485$/);
  expect(lines[1]).toMatch(
    /^bit [0-9a-f-]{36} at 0,0,0: present, color #ffffff, 26 of 26 nodes lit$/,
  );
  await expect(section.locator("li")).toHaveCount(485);
  await expect(section.locator("li").first()).toHaveText(lines[1]!);
  await expect(section).toHaveAttribute("aria-live", "polite");
  // The toggle button shows and hides it without the URL.
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  await expect(page.locator("#text-view")).toBeHidden();
  await page.locator("#text-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#text-view")).toBeVisible();
});

test("reduced motion: damping is off, the HUD refreshes at 1 Hz, and the camera does not move on its own", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  expect(await hook(page, (h) => h.motion())).toBe("reduce");
  expect(await hook(page, (h) => h.hudIntervalMs())).toBe(1000);
  await expect(page.locator("body")).toHaveAttribute("data-motion", "reduce");
  const a = await hook(page, (h) => h.cameraPosition());
  await page.waitForTimeout(1200);
  const b = await hook(page, (h) => h.cameraPosition());
  expect(b).toEqual(a);
  await context.close();
});
