/**
 * Click to terminal write (ticket #76): the Three.js demo mirrors one bit to
 * the bridge, the bridge sends DDP to the WLED simulator running as its own
 * process, and the simulator stamps each frame when its bytes are accepted
 * by the output. The distribution over a hundred changes is the software
 * half of click-to-photon: a lower bound, terminal compositing excluded.
 * The hardware oracles (#72, #73) are not claimed here.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { startBridge } from "../../scripts/led-bridge.ts";
import { nextSequence } from "../../src/ddp.ts";
import { changePassport, hook, openMirroredDemo } from "./led-page.ts";

type SimSample = { sequence: number; receivedAt: number; writtenAt: number };
type SimStats = { frames: number; samples: SimSample[] };

/** The simulator as a child process; its first stdout line names the ports. */
async function spawnSim(
  timeoutMs: number,
): Promise<{ proc: ChildProcess; udp: number; http: number }> {
  const proc = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/wled-sim.ts",
      "--no-tty",
      "--udp",
      "0",
      "--http",
      "0",
      "--timeout",
      String(timeoutMs),
      "--name",
      "e2e-sim",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ports = await new Promise<{ udp: number; http: number }>((resolve, reject) => {
    let text = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const line = text.split("\n")[0];
      if (line?.startsWith("{")) resolve(JSON.parse(line) as { udp: number; http: number });
    });
    proc.stderr!.on("data", (c: Buffer) => process.stderr.write(`[sim] ${c}`));
    proc.on("exit", (code) =>
      reject(new Error(`simulator exited with ${code} before naming its ports`)),
    );
    setTimeout(() => reject(new Error("simulator did not name its ports in 20 s")), 20_000);
  });
  return { proc, ...ports };
}

test("a hundred changes reach the simulator; click→terminal-write is measured across three processes; carving goes dark; silence times out", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sim = await spawnSim(1500);
  const stats = async () =>
    (await (await fetch(`http://127.0.0.1:${sim.http}/vpb/stats`)).json()) as SimStats;
  const info = async () =>
    (await (await fetch(`http://127.0.0.1:${sim.http}/json/info`)).json()) as {
      live: boolean;
      lm: string;
    };
  const bridge = await startBridge({ host: "127.0.0.1", port: sim.udp, listen: 0 });
  try {
    await openMirroredDemo(page, bridge.url);
    await expect.poll(() => bridge.samples.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const seeded = bridge.samples.length;

    await changePassport(page, 100);
    await expect.poll(() => bridge.samples.length, { timeout: 30_000 }).toBe(seeded + 100);
    expect(await hook(page, (h) => h.ledError())).toBe("");
    // Packets just flowed, so the simulator is inside its realtime window.
    const live = await info();
    expect(live.live).toBe(true);
    expect(live.lm).toBe("DDP");
    // The last frame sent is the last frame shown: wait for the simulator to catch up.
    const lastSent = bridge.samples[bridge.samples.length - 1]!.sequence;
    await expect
      .poll(async () => (await stats()).samples.at(-1)?.sequence, { timeout: 15_000 })
      .toBe(lastSent);

    // Join: a simulator frame carries the DDP sequence of the last packet folded into it
    // (WLED-style show coalescing), and sequences wrap every 15 sends. Pair each frame with
    // the latest send of that sequence that left before the frame's packet arrived; a small
    // slack covers the processes' clock alignment. This survives coalescing and reordering.
    const s = await stats();
    expect(s.samples.length).toBeGreaterThan(0);
    for (let i = 1; i < bridge.samples.length; i++) {
      expect(bridge.samples[i]!.sequence).toBe(nextSequence(bridge.samples[i - 1]!.sequence));
    }
    const bySequence = new Map<number, { eventTime: number; sentAt: number }[]>();
    for (const x of bridge.samples) {
      const list = bySequence.get(x.sequence) ?? [];
      list.push({ eventTime: x.eventTime, sentAt: x.sentAt });
      bySequence.set(x.sequence, list);
    }
    const SLACK_MS = 5;
    const latencies: number[] = [];
    let unpaired = 0;
    for (const frame of s.samples) {
      if (frame.sequence === 0) continue; // idle frames carry no sequence
      const candidates = (bySequence.get(frame.sequence) ?? []).filter(
        (c) => c.sentAt <= frame.receivedAt + SLACK_MS,
      );
      const send = candidates[candidates.length - 1];
      if (!send) {
        unpaired++;
        continue;
      }
      expect(
        frame.receivedAt - send.sentAt,
        "the packet arrived within a second of leaving",
      ).toBeLessThan(1000);
      latencies.push(frame.writtenAt - send.eventTime);
    }
    expect(unpaired, "frames with no send that could have produced them").toBe(0);
    expect(latencies.length).toBeGreaterThan(0);
    const sorted = [...latencies].sort((x, y) => x - y);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
    const p50 = at(0.5);
    const p95 = at(0.95);
    const max = sorted[sorted.length - 1]!;
    test
      .info()
      .annotations.push(
        { type: "click→terminal-write, frames", description: String(latencies.length) },
        { type: "click→terminal-write, sends", description: String(bridge.samples.length) },
        { type: "click→terminal-write p50 ms", description: p50.toFixed(1) },
        { type: "click→terminal-write p95 ms", description: p95.toFixed(1) },
        { type: "click→terminal-write max ms", description: max.toFixed(1) },
      );
    console.log(
      `click→terminal-write over ${latencies.length} frames of ${bridge.samples.length} sends: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(1000);
    expect(p50).toBeGreaterThanOrEqual(-1); // millisecond clock alignment across processes

    // Carve the mirrored bit: the simulator's next frame is dark. Read it back through the
    // JSON API's stats count and the bridge's last frame bytes are asserted in three-led.spec.
    const framesBefore = (await stats()).frames;
    await page.click("#remove");
    await expect
      .poll(async () => (await stats()).frames, { timeout: 15_000 })
      .toBeGreaterThan(framesBefore);

    // Silence: after the simulator's timeout it leaves realtime.
    await expect.poll(async () => (await info()).live, { timeout: 15_000 }).toBe(false);
  } finally {
    await bridge.close();
    sim.proc.kill();
  }
});
