/**
 * Accessibility (PLAN-4.md Phase 24): every page passes axe with WCAG
 * 2.0, 2.1, and 2.2 A and AA rules, no critical or serious findings.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages: { name: string; url: string; ready: string }[] = [
  { name: "passport", url: "/passport/?scene=builtin&id=first", ready: "body[data-ready='1']" },
  { name: "reader", url: "/reader/?scene=builtin", ready: "body[data-ready='1']" },
  { name: "three", url: "/three/", ready: "body[data-ready='1']" },
  { name: "canvas", url: "/canvas/", ready: "body[data-mode]" },
];

for (const p of pages) {
  test(`axe: ${p.name} has no critical or serious findings`, async ({ page }) => {
    await page.goto(p.url);
    await page.waitForSelector(p.ready, { timeout: 60_000 });
    if (p.name === "three") {
      // With a bit's panel open, so the panel's controls are audited too.
      await page.evaluate(() =>
        (
          window as unknown as { __vpb: { selectFirstFaceBit(): string } }
        ).__vpb.selectFirstFaceBit(),
      );
      await expect(page.locator("#panel")).toBeVisible();
    }
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(
      bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`),
    ).toEqual([]);
    test.info().annotations.push({
      type: "axe",
      description: `${results.violations.length} minor/moderate, ${results.passes.length} passes`,
    });
  });
}
