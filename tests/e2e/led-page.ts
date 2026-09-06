/**
 * Shared setup for the LED end-to-end specs: the Three.js demo opened with
 * a bridge URL, and the hooks the page exposes for them.
 */
import { expect, type Page } from "@playwright/test";

export type LedHook = {
  ledTarget(): string | undefined;
  ledPosts(): number;
  ledError(): string;
  selectBit(id: string): boolean;
  setPassportOnSelected(obj: unknown): boolean;
};

export const hook = <T>(page: Page, fn: (h: LedHook) => T): Promise<T> =>
  page.evaluate(
    (src: string) =>
      new Function("h", `return (${src})(h)`)((window as unknown as { __vpb: LedHook }).__vpb) as T,
    fn.toString(),
  );

/** Open the demo mirroring its first bit to `bridgeUrl`; returns the mirrored bit's id. */
export async function openMirroredDemo(page: Page, bridgeUrl: string): Promise<string> {
  await page.goto(`/three/?led=${encodeURIComponent(bridgeUrl)}&bit=first`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
  const target = await hook(page, (h) => h.ledTarget());
  expect(target).toMatch(/^[0-9a-f-]{36}$/);
  expect(await hook(page, (h) => h.selectBit(h.ledTarget()!))).toBe(true);
  return target!;
}

/** Change the selected bit's passport `n` times, one post each. */
export async function changePassport(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const ok = await page.evaluate(
      (k) => (window as unknown as { __vpb: LedHook }).__vpb.setPassportOnSelected({ n: k }),
      i,
    );
    expect(ok).toBe(true);
  }
}
