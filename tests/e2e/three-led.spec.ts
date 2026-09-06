/**
 * Click to packet (PLAN-2.md Phase 10, ticket 10.3): the Three.js demo
 * mirrors one bit to the LED bridge, which runs here in the test process
 * with a stand-in display socket. A hundred changes to the bit become a
 * hundred DDP packets; carving the bit sends a dark one. The latency from
 * the demo's event time to the packet leaving the bridge is the software
 * half of click-to-photon, recorded in the test's annotations.
 */
import dgram from "node:dgram";
import { expect, type Page, test } from "@playwright/test";
import { startBridge } from "../../scripts/led-bridge.ts";
import { decodeDdp, ledRangeOf } from "../../src/ddp.ts";

type Hook = {
  ledTarget(): string | undefined;
  ledPosts(): number;
  ledError(): string;
  selectBit(id: string): boolean;
  setPassportOnSelected(obj: unknown): boolean;
};

const hook = <T>(page: Page, fn: (h: Hook) => T): Promise<T> =>
  page.evaluate(
    (src: string) =>
      new Function("h", `return (${src})(h)`)((window as unknown as { __vpb: Hook }).__vpb) as T,
    fn.toString(),
  );

test("a hundred changes to the mirrored bit reach the display as DDP; carving it sends a dark frame", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const display = dgram.createSocket("udp4");
  const packets: Uint8Array[] = [];
  display.on("message", (m) => packets.push(new Uint8Array(m)));
  await new Promise<void>((r) => display.bind(0, "127.0.0.1", r));
  const bridge = await startBridge({
    host: "127.0.0.1",
    port: (display.address() as { port: number }).port,
    listen: 0,
  });
  try {
    await page.goto(`/three/?led=${encodeURIComponent(bridge.url)}&bit=first`);
    await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
    const target = await hook(page, (h) => h.ledTarget());
    expect(target).toMatch(/^[0-9a-f-]{36}$/);
    // The fill already posted the bit's creation and its emissions.
    await expect.poll(() => bridge.samples.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const seeded = bridge.samples.length;
    expect(await hook(page, (h) => h.selectBit(h.ledTarget()!))).toBe(true);

    for (let i = 0; i < 100; i++) {
      const ok = await page.evaluate(
        (n) => (window as unknown as { __vpb: Hook }).__vpb.setPassportOnSelected({ n }),
        i,
      );
      expect(ok).toBe(true);
    }
    await expect.poll(() => bridge.samples.length, { timeout: 30_000 }).toBe(seeded + 100);
    expect(await hook(page, (h) => h.ledError())).toBe("");
    const lit = decodeDdp(packets[packets.length - 1]!);
    expect(lit.header.push).toBe(true);
    expect(ledRangeOf(lit.header)).toEqual({ start: 0, stop: 68 });
    expect([...lit.data.subarray(0, 3)]).toEqual([19, 67, 141]); // a face, blue at 0.6

    // Carve the mirrored bit: the next frame is dark.
    await page.click("#remove");
    await expect
      .poll(() => bridge.samples.length, { timeout: 15_000 })
      .toBeGreaterThan(seeded + 100);
    await expect
      .poll(() => packets.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(bridge.samples.length);
    const dark = decodeDdp(packets[packets.length - 1]!);
    expect(dark.data.every((v) => v === 0)).toBe(true);

    const stats = bridge.stats();
    const s = stats.eventToPacket;
    test
      .info()
      .annotations.push(
        { type: "click→packet, n", description: String(s.n) },
        { type: "click→packet p50 ms", description: s.p50.toFixed(1) },
        { type: "click→packet p95 ms", description: s.p95.toFixed(1) },
        { type: "click→packet max ms", description: s.max.toFixed(1) },
      );
    console.log(
      `click→packet over ${s.n} posts: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`,
    );
    expect(s.p95).toBeLessThan(1000);
  } finally {
    await bridge.close();
    display.close();
  }
});
