import assert from "node:assert/strict";
import dgram from "node:dgram";
import { test } from "node:test";
import {
  DdpSender,
  LED_FRAME_FORMAT,
  type LedFramePost,
  latencyStats,
  parseFramePost,
  startBridge,
} from "../scripts/led-bridge.ts";
import { decodeDdp, ledRangeOf } from "../src/ddp.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { defaultLedMap } from "../src/led-map.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";

/** A stand-in for WLED: a UDP socket that keeps every packet. */
async function fakeDisplay(): Promise<{
  port: number;
  packets: Uint8Array[];
  close(): void;
  waitFor(n: number): Promise<void>;
}> {
  const socket = dgram.createSocket("udp4");
  const packets: Uint8Array[] = [];
  socket.on("message", (msg) => packets.push(new Uint8Array(msg)));
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  return {
    port,
    packets,
    close: () => socket.close(),
    waitFor: async (n) => {
      const deadline = Date.now() + 5000;
      while (packets.length < n && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(packets.length >= n, `expected ${n} packets, saw ${packets.length}`);
    },
  };
}

function referenceBit() {
  const g = FlatGrid.fill(1, 1, 1, { emission: { color: 0x1f6feb, light: 0.6 } });
  const bit = g.at(0, 0, 0)!;
  bit.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
  bit.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  return { g, bit };
}

test("latencyStats: percentiles by rank, empty is NaN", () => {
  assert.deepEqual(latencyStats([5, 1, 4, 2, 3]), { n: 5, p50: 3, p95: 5, max: 5 });
  assert.deepEqual(latencyStats([7]), { n: 1, p50: 7, p95: 7, max: 7 });
  assert.ok(Number.isNaN(latencyStats([]).p50));
});

test("parseFramePost refuses the wrong shape and accepts a record with a map", () => {
  const { bit } = referenceBit();
  const good = {
    format: LED_FRAME_FORMAT,
    bit: bit.id,
    time: 1,
    ...bit.record(),
    map: defaultLedMap(),
  };
  assert.equal(parseFramePost(JSON.stringify(good)).bit, bit.id);
  assert.throws(() => parseFramePost(JSON.stringify({ ...good, format: "x" })), /format/);
  assert.throws(() => parseFramePost(JSON.stringify({ ...good, time: "now" })), /time/);
  assert.throws(
    () => parseFramePost(JSON.stringify({ ...good, map: { format: "vpb-led-map/1" } })),
    /led map/,
  );
});

test("DdpSender sends one packet per frame to the display and sequences 1..15", async () => {
  const display = await fakeDisplay();
  const sender = new DdpSender("127.0.0.1", display.port);
  const map = defaultLedMap();
  for (let i = 0; i < 16; i++) await sender.send(new Uint8Array(map.leds * 3).fill(i));
  await display.waitFor(16);
  sender.close();
  display.close();
  const seqs = display.packets.map((p) => decodeDdp(p).header.sequence);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1]);
  assert.ok(display.packets.every((p) => decodeDdp(p).header.push));
  assert.deepEqual(ledRangeOf(decodeDdp(display.packets[0]!).header), { start: 0, stop: 68 });
});

test("overlapping sends never interleave a multi-packet frame; results carry the sequence", async () => {
  const display = await fakeDisplay();
  const sender = new DdpSender("127.0.0.1", display.port);
  try {
    const a = new Uint8Array(600 * 3).fill(0xaa);
    const b = new Uint8Array(600 * 3).fill(0xbb);
    const [ra, rb] = await Promise.all([sender.send(a), sender.send(b)]);
    assert.equal(ra.sequence, 1);
    assert.equal(rb.sequence, 3);
    await display.waitFor(4);
    const got = display.packets.map((p) => decodeDdp(p));
    assert.deepEqual(
      got.map((g) => [g.header.sequence, g.header.push, g.data[0]]),
      [
        [1, false, 0xaa],
        [2, true, 0xaa],
        [3, false, 0xbb],
        [4, true, 0xbb],
      ],
    );
  } finally {
    sender.close();
    display.close();
  }
});

test("a dry-run sender keeps the hex instead of opening a socket", async () => {
  const sender = new DdpSender("192.0.2.1", 4048, { dryRun: true });
  const sent = await sender.send(new Uint8Array([1, 2, 3]));
  assert.equal(sent.packets, 1);
  // flags 0x41 (v1, push), sequence 1, type 0x0b RGB24, id 1, offset 0, length 3, then the data
  assert.equal(sender.dryPackets[0], "41010b0100000000" + "0003" + "010203");
  sender.close();
});

test("the bridge: the demo posts a bit, the display gets its bytes, the latency is recorded", async () => {
  const display = await fakeDisplay();
  const bridge = await startBridge({ host: "127.0.0.1", port: display.port, listen: 0 });
  try {
    const { g, bit } = referenceBit();
    const post = (time: number): LedFramePost => ({
      format: LED_FRAME_FORMAT,
      bit: bit.id,
      time,
      ...bit.record(),
    });
    const t0 = Date.now();
    const res = await fetch(`${bridge.url}/frame`, {
      method: "POST",
      body: JSON.stringify(post(t0)),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; packets: number; eventToPacket: number };
    assert.equal(body.ok, true);
    assert.equal(body.packets, 1);
    await display.waitFor(1);
    const { header, data } = decodeDdp(display.packets[0]!);
    assert.equal(header.push, true);
    assert.deepEqual(ledRangeOf(header), { start: 0, stop: 68 });
    assert.deepEqual([...data.subarray(0, 3)], [19, 67, 141], "face 0, blue at 0.6");
    assert.deepEqual([...data.subarray(60 * 3, 60 * 3 + 3)], [255, 255, 255], "corner 18 white");

    // Carve it: the next post is dark.
    g.setPresent(bit, false);
    await fetch(`${bridge.url}/frame`, { method: "POST", body: JSON.stringify(post(Date.now())) });
    await display.waitFor(2);
    assert.ok(decodeDdp(display.packets[1]!).data.every((v) => v === 0));

    // A hundred more, for the distribution.
    g.setPresent(bit, true);
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${bridge.url}/frame`, {
        method: "POST",
        body: JSON.stringify(post(Date.now())),
      });
      assert.equal(r.status, 200);
    }
    await display.waitFor(102);
    const stats = bridge.stats();
    assert.equal(stats.eventToPacket.n, 102);
    const first = bridge.samples[0]!;
    assert.equal(first.sequence, 1, "samples carry the DDP sequence");
    assert.equal(first.eventTime, t0);
    assert.ok(first.sentAt >= first.eventTime);
    assert.deepEqual(
      bridge.samples.slice(0, 16).map((s) => s.sequence),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1],
    );
    // Event times are Date.now() at millisecond resolution and the packet stamp is a
    // wall-aligned high-resolution clock, so a post answered within a millisecond can
    // read a fraction negative. Tolerate the alignment, not more.
    assert.ok(stats.eventToPacket.p50 >= -1, `p50 ${stats.eventToPacket.p50}`);
    assert.ok(
      stats.receiptToPacket.max < 1000,
      `receipt to packet max ${stats.receiptToPacket.max} ms`,
    );
    const viaHttp = (await (await fetch(`${bridge.url}/stats`)).json()) as typeof stats;
    assert.equal(viaHttp.eventToPacket.n, 102);
    console.log(
      `  bridge latency over ${stats.eventToPacket.n} posts: event→packet p50 ${stats.eventToPacket.p50.toFixed(1)} ms, p95 ${stats.eventToPacket.p95.toFixed(1)} ms, max ${stats.eventToPacket.max.toFixed(1)} ms; receipt→packet p50 ${stats.receiptToPacket.p50.toFixed(2)} ms, p95 ${stats.receiptToPacket.p95.toFixed(2)} ms`,
    );

    // Bad posts are 400 with a reason; other paths 404; preflight 204.
    const bad = await fetch(`${bridge.url}/frame`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /format/);
    assert.equal((await fetch(`${bridge.url}/nope`)).status, 404);
    const pre = await fetch(`${bridge.url}/frame`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  } finally {
    await bridge.close();
    display.close();
  }
});
