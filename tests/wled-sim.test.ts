import assert from "node:assert/strict";
import dgram from "node:dgram";
import { test } from "node:test";
import { DdpSender } from "../scripts/led-bridge.ts";
import {
  SIM_VERSION,
  type SimView,
  startWledSim,
  terminalRenderer,
  WLED_DEFAULT_BRI,
  WLED_NEVER_MS,
  WLED_SYNC_PORT,
} from "../scripts/wled-sim.ts";
import { DDP_FLAGS, DDP_ID, DDP_TYPE, encodeDdp } from "../src/ddp.ts";
import { defaultLedMap } from "../src/led-map.ts";

/** A simulator with a render spy, free ports, no show throttle, and a short timeout. */
async function sim(timeoutMs = 200) {
  const rendered: { frame: Uint8Array; view: SimView }[] = [];
  const s = await startWledSim({
    udpPort: 0,
    httpPort: 0,
    timeoutMs,
    showIntervalMs: 0,
    render: (frame, view) => {
      rendered.push({ frame: new Uint8Array(frame), view: { ...view, state: { ...view.state } } });
    },
  });
  const until = async (pred: () => boolean, ms = 3000, what = "condition") => {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(pred(), `timed out waiting for ${what}`);
  };
  const last = () => rendered[rendered.length - 1]!;
  const px = (f: Uint8Array, i: number) => [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${s.httpPort}${path}`, init);
  const post = (path: string, body: unknown) =>
    api(path, { method: "POST", body: JSON.stringify(body) }).then(
      (r) => r.json() as Promise<Record<string, unknown>>,
    );
  return { s, rendered, until, last, px, api, post };
}

const ORANGE_AT_128 = [128, 80, 0];

test("a fresh simulator shows WLED's idle orange at brightness 128 and answers the JSON API", async () => {
  const t = await sim();
  try {
    await t.until(() => t.rendered.length >= 1, 3000, "the idle frame");
    assert.deepEqual(t.px(t.last().frame, 0), ORANGE_AT_128);
    assert.deepEqual(t.px(t.last().frame, 67), ORANGE_AT_128);
    const info = (await (await t.api("/json/info")).json()) as Record<string, unknown>;
    assert.equal(info.ver, SIM_VERSION);
    assert.deepEqual((info.leds as { count: number }).count, 68);
    assert.equal(info.live, false);
    assert.equal(info.lm, "");
    assert.equal(info.udpport, WLED_SYNC_PORT);
    assert.equal(info.product, "VoxelPixelBit simulator");
    const state = (await (await t.api("/json/state")).json()) as Record<string, unknown>;
    assert.equal(state.on, true);
    assert.equal(state.bri, WLED_DEFAULT_BRI);
    assert.equal(state.lor, 0);
    assert.ok(!("live" in state), "WLED's state has no live key; info has it");
    const both = (await (await t.api("/json")).json()) as Record<string, unknown>;
    assert.ok(both.state && both.info && Array.isArray(both.effects));
    const si = (await (await t.api("/json/si")).json()) as Record<string, unknown>;
    assert.ok(si.state && si.info);
    assert.equal((await t.api("/nope")).status, 404);
    const cfg = (await (await t.api("/json/cfg")).json()) as {
      if: { live: { timeout: number; maxbri: boolean } };
    };
    assert.equal(cfg.if.live.timeout, 2);
  } finally {
    await t.s.close();
  }
});

test("DDP lands scaled by brightness, enters live black, renders on push, times out to idle", async () => {
  const t = await sim(200);
  const sender = new DdpSender("127.0.0.1", t.s.udpPort);
  try {
    await t.until(() => t.rendered.length >= 1);
    const frame = new Uint8Array(68 * 3);
    frame.set([255, 0, 0], 0); // LED 0 red
    frame.set([0, 0, 255], 67 * 3); // LED 67 blue
    await sender.send(frame);
    await t.until(() => t.rendered.length >= 2, 3000, "the live frame");
    const f = t.last().frame;
    assert.deepEqual(t.px(f, 0), [128, 0, 0], "red at global brightness 128");
    assert.deepEqual(t.px(f, 67), [0, 0, 128]);
    assert.deepEqual(t.px(f, 1), [0, 0, 0], "entering live blanked the orange");
    assert.deepEqual(t.px(t.s.buffer, 0), [255, 0, 0], "the buffer keeps the raw bytes");
    assert.equal(t.s.state.live, true);
    assert.equal(t.s.state.lm, "DDP");
    assert.equal(t.s.state.lip, "127.0.0.1");
    const info = (await (await t.api("/json/info")).json()) as Record<string, unknown>;
    assert.equal(info.live, true);
    assert.equal(info.lm, "DDP");
    // A sample per rendered live frame, with the sender's sequence.
    assert.equal(t.s.samples[t.s.samples.length - 1]!.sequence, 1);
    assert.ok(t.s.stats().receiveToWrite.n >= 1);

    // No packets for 200 ms: realtime ends, idle orange again, blanking on the next entry.
    await t.until(() => t.s.state.live === false, 2000, "the timeout");
    await t.until(
      () => t.px(t.last().frame, 0).join() === ORANGE_AT_128.join(),
      2000,
      "idle orange",
    );
    assert.equal(t.s.state.lm, "");
    assert.equal(t.s.state.lip, "");
  } finally {
    sender.close();
    await t.s.close();
  }
});

test("push semantics as WLED: render every packet until a push is seen, then only on push", async () => {
  const t = await sim(2000);
  const socket = dgram.createSocket("udp4");
  const send = (p: Uint8Array) =>
    new Promise<void>((res, rej) =>
      socket.send(p, t.s.udpPort, "127.0.0.1", (e) => (e ? rej(e) : res())),
    );
  try {
    await t.until(() => t.rendered.length >= 1);
    const base = t.rendered.length;
    await send(encodeDdp(new Uint8Array([10, 0, 0]), { push: false, sequence: 1 }));
    await t.until(() => t.rendered.length >= base + 1, 2000, "a render with no push yet seen");
    await send(encodeDdp(new Uint8Array([20, 0, 0]), { push: true, sequence: 2 }));
    await t.until(() => t.rendered.length >= base + 2, 2000, "a render on push");
    await send(encodeDdp(new Uint8Array([30, 0, 0]), { push: false, sequence: 3 }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(t.rendered.length, base + 2, "no render for a non-push packet after a push");
    assert.equal(t.s.buffer[0], 30, "the buffer took the bytes anyway");
    await send(encodeDdp(new Uint8Array([40, 0, 0]), { push: true, sequence: 4 }));
    await t.until(() => t.rendered.length >= base + 3);
    assert.equal(t.last().frame[0], Math.round((40 * 128) / 255));
    assert.equal(t.s.samples[t.s.samples.length - 1]!.sequence, 4);
  } finally {
    socket.close();
    await t.s.close();
  }
});

test("WLED's rejection rules: control ids, query and reply flags, storage without push, short data; pixels past the strip drop", async () => {
  const t = await sim(2000);
  const socket = dgram.createSocket("udp4");
  const send = (p: Uint8Array) =>
    new Promise<void>((res, rej) =>
      socket.send(p, t.s.udpPort, "127.0.0.1", (e) => (e ? rej(e) : res())),
    );
  try {
    await t.until(() => t.rendered.length >= 1);
    const data = new Uint8Array([9, 9, 9]);
    await send(encodeDdp(data, { id: DDP_ID.CONTROL }));
    await send(encodeDdp(data, { id: DDP_ID.STATUS }));
    await send(encodeDdp(data, { id: DDP_ID.CONFIG }));
    const query = encodeDdp(data);
    query[0] = DDP_FLAGS.VERSION_1 | DDP_FLAGS.QUERY;
    await send(query);
    const reply = encodeDdp(data);
    reply[0] = DDP_FLAGS.VERSION_1 | DDP_FLAGS.REPLY | DDP_FLAGS.PUSH;
    await send(reply);
    const storage = encodeDdp(data, { push: false });
    storage[0] = DDP_FLAGS.VERSION_1 | DDP_FLAGS.STORAGE;
    await send(storage);
    const short = encodeDdp(new Uint8Array(6)).subarray(0, 13); // header says 6 bytes, 3 present
    await send(short);
    await send(new Uint8Array([0x41, 0, 0x0b])); // shorter than a header
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(t.s.state.live, false, "nothing above entered realtime");
    assert.equal(t.s.buffer[0], 0);

    // Storage with push is accepted; RGBW data type is read as four channels.
    const storagePush = encodeDdp(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      type: DDP_TYPE.RGBW32,
    });
    storagePush[0] = DDP_FLAGS.VERSION_1 | DDP_FLAGS.STORAGE | DDP_FLAGS.PUSH;
    await send(storagePush);
    await t.until(() => t.s.state.live, 2000, "live after storage+push");
    assert.deepEqual(t.px(t.s.buffer, 0), [1, 2, 3]);
    assert.deepEqual(t.px(t.s.buffer, 1), [5, 6, 7]);

    // Offset at LED 66 with data for five LEDs: 66 and 67 land, 68..70 drop, no throw.
    const tail = new Uint8Array(15).fill(200);
    await send(encodeDdp(tail, { offset: 66 * 3 }));
    await t.until(() => t.s.buffer[67 * 3] === 200, 2000, "the last LED");
    assert.equal(t.s.buffer.length, 68 * 3);
    assert.deepEqual(t.px(t.s.buffer, 66), [200, 200, 200]);
  } finally {
    socket.close();
    await t.s.close();
  }
});

test("state and cfg: lor blocks pixel writes and clears on exit; live:true never times out; bri, on, maxbri, timeout", async () => {
  const t = await sim(200);
  const sender = new DdpSender("127.0.0.1", t.s.udpPort);
  try {
    await t.until(() => t.rendered.length >= 1);
    assert.deepEqual(await t.post("/json/state", { lor: 1 }), { success: true });
    const frame = new Uint8Array(68 * 3).fill(255);
    await sender.send(frame);
    await t.until(() => t.s.state.live, 2000, "live under override");
    assert.equal(t.s.buffer[0], 0, "override skips pixel writes");
    assert.equal(t.s.state.lor, 1);
    await t.until(() => !t.s.state.live, 2000, "timeout under override");
    assert.equal(t.s.state.lor, 0, "lor 1 clears when realtime ends");

    // live:true locks realtime with no timeout; live:false exits.
    const v = await t.post("/json/state", { live: true, v: true });
    assert.equal(v.on, true, "v:true returns the state");
    assert.equal(t.s.state.live, true);
    assert.equal(t.s.state.lm, "");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(t.s.state.live, true, "no timeout for a JSON live lock");
    await t.post("/json/state", { live: false });
    assert.equal(t.s.state.live, false);

    // Brightness and power change what the strip shows, live or idle.
    await t.post("/json/state", { bri: 255 });
    await t.until(() => t.px(t.last().frame, 0).join() === "255,160,0", 2000, "full orange");
    await t.post("/json/state", { on: false });
    await t.until(() => t.last().frame.every((b) => b === 0), 2000, "dark when off");
    await t.post("/json/state", { on: true, bri: 64 });
    await sender.send(frame);
    await t.until(() => t.s.state.live && t.last().frame[0] === 64, 2000, "live at bri 64");

    // cfg: timeout in 100 ms units; maxbri forces 255 on live frames.
    assert.deepEqual(await t.post("/json/cfg", { if: { live: { timeout: 5, maxbri: true } } }), {
      success: true,
    });
    const cfg = (await (await t.api("/json/cfg")).json()) as {
      if: { live: { timeout: number; maxbri: boolean } };
    };
    assert.deepEqual(cfg.if.live, { timeout: 5, maxbri: true });
    assert.equal(t.s.state.timeoutMs, 500);
    await sender.send(frame);
    await t.until(() => t.last().frame[0] === 255, 2000, "max brightness on live");
    // 650 means never.
    await t.post("/json/cfg", { if: { live: { timeout: 650 } } });
    assert.equal(t.s.state.timeoutMs, WLED_NEVER_MS);
    await sender.send(frame);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(t.s.state.live, true, "no timeout at 650");

    const stats = (await (await t.api("/vpb/stats")).json()) as {
      frames: number;
      receiveToWrite: { n: number };
    };
    assert.ok(stats.frames >= 5);
    assert.ok(stats.receiveToWrite.n >= 1);
    assert.equal((await t.api("/json/state", { method: "POST", body: "{" })).status, 400);
  } finally {
    sender.close();
    await t.s.close();
  }
});

test("the terminal renderer: silent when piped; on a TTY it takes the alternate screen, homes the cursor, and writes one frame with a header", async () => {
  const map = defaultLedMap();
  const view: SimView = {
    name: "tty-test",
    state: {
      on: true,
      bri: 128,
      lor: 0,
      live: true,
      lm: "DDP",
      lip: "127.0.0.1",
      timeoutMs: 2500,
      forceMaxBri: false,
    },
    map,
    frames: 3,
    lastLatencyMs: 1.25,
    timeoutLeftMs: 1800,
  };
  const frame = new Uint8Array(map.leds * 3).fill(0x40);
  const piped: string[] = [];
  const quiet = terminalRenderer(map, "x", {
    isTTY: false,
    write: (t) => (piped.push(t), true),
    on: () => {},
  });
  assert.equal(await quiet(frame, view), undefined);
  assert.deepEqual(piped, [], "nothing is written to a pipe");

  const writes: string[] = [];
  const tty = terminalRenderer(map, "x", {
    isTTY: true,
    getColorDepth: () => 24,
    write: (t, cb) => {
      writes.push(t);
      cb?.();
      return true;
    },
    on: () => {},
  });
  await tty(frame, view);
  assert.ok(writes[0]!.startsWith("[?1049h[?25l"), "alternate screen and hidden cursor on entry");
  const first = writes[1]!;
  assert.ok(first.startsWith("[H"), "cursor home, no clear, per frame");
  assert.ok(first.includes("tty-test  LIVE DDP from 127.0.0.1  bri 128"));
  assert.ok(first.includes("frames 3  last receive→write 1.3 ms  timeout 1.8 s  68 LEDs"));
  assert.ok(first.includes("[48;2;64;64;64m"), "the frame's bytes are painted");
  await tty(frame, { ...view, state: { ...view.state, live: false }, timeoutLeftMs: undefined });
  assert.ok(writes[2]!.includes("idle") && writes[2]!.includes("timeout –"));
  assert.equal(writes.length, 3, "one write per frame");
});
