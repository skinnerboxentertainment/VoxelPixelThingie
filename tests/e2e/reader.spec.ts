/**
 * The reader (PLAN-4.md Phase 17): one file, opened from disk with the
 * network off, lists the bits, shows a bit, reports the digest Node
 * computed, and verifies the seal against the DID document it carries.
 * The tampered file names the bit and fails. The page passes axe and is
 * operable by keyboard. Served with `?scene=builtin` it works too.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

type Scene = { id: string; bits: number; digest: string; embedded: Record<string, boolean> };
type Report = {
  ok: boolean;
  checked: number;
  mismatches: { id: string; file: string }[];
  signature: string;
  resolvedBy: string;
};
type Hook = {
  scene(): Scene | undefined;
  report(): Report | undefined;
  selected(): string | undefined;
};
const hook = <T>(page: Page, fn: (h: Hook) => T) =>
  page.evaluate(
    (src: string) =>
      new Function("h", `return (${src})(h)`)((window as unknown as { __vpb: Hook }).__vpb) as T,
    fn.toString(),
  );

let good = "";
let tampered = "";
let digest = "";
let tamperedBit = "";

test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "vpb-reader-"));
  good = join(dir, "reader.html");
  tampered = join(dir, "tampered.html");
  const run = (...args: string[]) =>
    execFileSync("node", ["--experimental-strip-types", "scripts/reader-scene.ts", ...args], {
      encoding: "utf8",
      timeout: 120_000,
    });
  const out = run("builtin", good);
  digest = /digest ([0-9a-f]{64})/.exec(out)![1]!;
  tamperedBit = /tampered bit (\S+)/.exec(run("builtin", tampered, "--tamper"))![1]!;
});

async function offlinePage(browser: Browser, file: string): Promise<Page> {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  return page;
}

test("from disk with the network off: the bits, a bit by keyboard, the digest Node computed, the seal verified against the embedded document", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  expect(statSync(good).size).toBeLessThan(4 * 1024 * 1024);
  const page = await offlinePage(browser, good);
  const scene = (await hook(page, (h) => h.scene()))!;
  expect(scene.bits).toBe(512);
  expect(scene.digest).toBe(digest);
  expect(scene.embedded).toEqual({ pack: true, spec: true, did: true });
  const report = (await hook(page, (h) => h.report()))!;
  expect(report.ok).toBe(true);
  expect(report.checked).toBe(512);
  expect(report.signature).toBe("verified");
  expect(report.resolvedBy).toBe("embedded");
  await expect(page.locator("#s-signature")).toContainText("embedded in this file");
  await expect(page.locator("#status")).toContainText("verified: 512 bits");
  await expect(page.locator("#bits button")).toHaveCount(512);
  // Keyboard only: filter, tab to the first bit, open it with Enter.
  await page.locator("#filter").focus();
  await page.keyboard.type("0,0,0");
  await expect(page.locator("#bits button")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const selected = await hook(page, (h) => h.selected());
  expect(selected).toBeTruthy();
  await expect(page.locator("#bit")).toBeVisible();
  await expect(page.locator("#f-id")).toHaveText(selected!);
  await expect(page.locator("#f-position")).toHaveText("0, 0, 0");
  await expect(page.locator("#f-emissions tbody tr")).toHaveCount(26);
  expect(await page.locator("#f-events tbody tr").count()).toBeGreaterThan(0);
  await expect(page.locator("#spec-details")).toBeVisible();
  await expect(page.locator("#spec-text")).toContainText("Core Model Specification");
  await page.context().close();
});

test("the tampered file names the bit and fails", async ({ browser }) => {
  const page = await offlinePage(browser, tampered);
  const report = (await hook(page, (h) => h.report()))!;
  expect(report.ok).toBe(false);
  expect(report.mismatches).toEqual([{ id: tamperedBit, file: "events" }]);
  await expect(page.locator("#status")).toContainText("FAILED");
  await expect(page.locator("#status")).toContainText(tamperedBit);
  await expect(page.locator("#s-seal")).toContainText(tamperedBit);
  await page.context().close();
});

test("axe: no critical or serious findings on the reader with a bit open", async ({ browser }) => {
  const page = await offlinePage(browser, good);
  await page.locator("#bits button").first().click();
  await expect(page.locator("#bit")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  await page.context().close();
});

test("served with ?scene=builtin the page builds the reference scene, unsigned, and verifies its hashes", async ({
  page,
}) => {
  await page.goto("/reader/?scene=builtin");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  const scene = (await hook(page, (h) => h.scene()))!;
  expect(scene.bits).toBe(512);
  expect(scene.embedded).toEqual({ pack: false, spec: false, did: false });
  const report = (await hook(page, (h) => h.report()))!;
  expect(report.ok).toBe(true);
  expect(report.signature).toBe("unsigned");
  await expect(page.locator("#spec-details")).toBeHidden();
});
