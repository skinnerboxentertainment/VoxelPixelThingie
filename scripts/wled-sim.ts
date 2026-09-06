/**
 * A WLED emulator for the physical bit (ADR 0009), in the terminal.
 *
 * Until the strip exists, this is what the driver and the bridge talk to.
 * It listens for DDP on UDP 4048 with WLED's rules, read from its source on
 * 2026-09-06 (wled00/e131.cpp, udp.cpp, json.cpp, cfg.cpp): control ids and
 * query/reply flags are ignored, a storage flag needs push, RGBW is told by
 * the data-type bits, the first LED is offset divided by channels, pixels
 * past the strip are dropped one by one, entering realtime blanks the
 * strip, the display renders on push or on every packet until a push has
 * been seen, global brightness still scales realtime pixels, and realtime
 * ends after a timeout (2.5 s by default; 65000 ms means never). The JSON
 * API answers what a driver reads: /json/info, /json/state, /json,
 * /json/si, POST /json/state, /json/cfg.
 *
 * What it is not: hardware. No Wi-Fi jitter, no strip timing, no color
 * order, no power. The latency it can stamp ends at the terminal write,
 * a lower bound on click-to-photon, and it is named that way.
 *
 *   node --experimental-strip-types scripts/wled-sim.ts [--udp 4048] [--http 8790]
 *        [--bind 127.0.0.1] [--map file] [--timeout 2500] [--name vpb-sim] [--no-tty] [--sensors]
 *
 * The first stdout line is JSON with the bound ports, for a test to read.
 */
import dgram from "node:dgram";
import { promises as fs } from "node:fs";
import http from "node:http";
import { channelsPerLed, DDP_ID, DDP_PORT, decodeDdp, ledRangeOf } from "../src/ddp.ts";
import { defaultLedMap, LED_CHANNELS, type LedMap, ledMapFromJson } from "../src/led-map.ts";
import { cubeNetCells, type NetCell, renderCubeNet } from "./cube-net.ts";
import { latencyStats, type LatencyStats, wallNow } from "./led-bridge.ts";

export const WLED_DEFAULT_BRI = 128;
export const WLED_DEFAULT_COLOR = 0xffa000;
export const WLED_DEFAULT_TIMEOUT_MS = 2500;
/** A timeout of 65000 ms, or a cfg value of 650, means realtime never ends. */
export const WLED_NEVER_MS = 65000;
export const WLED_SYNC_PORT = 21324;
export const WLED_SHOW_INTERVAL_MS = 15;
export const SIM_VERSION = "0.15.0-vpb-sim";

export interface SimState {
  on: boolean;
  bri: number;
  /** Live override: 0 none, 1 until realtime ends, 2 until restart. */
  lor: 0 | 1 | 2;
  live: boolean;
  /** Realtime mode name as WLED reports it: "DDP" or "". */
  lm: string;
  /** Realtime source address. */
  lip: string;
  timeoutMs: number;
  forceMaxBri: boolean;
}

export interface SimSample {
  /** DDP sequence of the last packet folded into this frame. */
  sequence: number;
  /** Arrival of that packet, ms since the epoch. */
  receivedAt: number;
  /** When the frame's bytes were accepted by the output, ms since the epoch. */
  writtenAt: number;
}

export interface SimView {
  name: string;
  state: SimState;
  map: LedMap;
  frames: number;
  lastLatencyMs: number | undefined;
  timeoutLeftMs: number | undefined;
}

export interface SimOptions {
  udpPort?: number;
  httpPort?: number;
  /** Address to listen on. Default loopback; 0.0.0.0 lets a driver on another machine reach it. */
  bind?: string;
  map?: LedMap;
  timeoutMs?: number;
  name?: string;
  /** Minimum ms between renders; WLED shows at most every 15 ms. 0 renders every push. */
  showIntervalMs?: number;
  /** Where frames go. Default: the terminal. Resolve when the bytes are accepted. */
  render?: (frame: Uint8Array, view: SimView) => Promise<void> | void;
  /**
   * Report fake senses in `info.sensor`, the draft shape WLED usermods use
   * (PLAN-4.md Phase 21): a board temperature and an ambient illuminance
   * that drift with uptime so successive readings differ.
   */
  sensors?: boolean | { temperature?: number; illuminance?: number };
}

export interface WledSim {
  udpPort: number;
  httpPort: number;
  map: LedMap;
  /** Raw pixel bytes as received, before brightness. */
  buffer: Uint8Array;
  state: SimState;
  samples: SimSample[];
  frames: number;
  stats(): { receiveToWrite: LatencyStats };
  close(): Promise<void>;
}

const now = wallNow;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export async function startWledSim(opts: SimOptions = {}): Promise<WledSim> {
  const map = opts.map ?? defaultLedMap();
  const name = opts.name ?? "vpb-sim";
  const showInterval = opts.showIntervalMs ?? WLED_SHOW_INTERVAL_MS;
  const render = opts.render ?? terminalRenderer(map, name);
  const startedAt = Date.now();
  const buffer = new Uint8Array(map.leds * LED_CHANNELS);
  const state: SimState = {
    on: true,
    bri: WLED_DEFAULT_BRI,
    lor: 0,
    live: false,
    lm: "",
    lip: "",
    timeoutMs: opts.timeoutMs ?? WLED_DEFAULT_TIMEOUT_MS,
    forceMaxBri: false,
  };
  const samples: SimSample[] = [];
  const sim = {
    udpPort: 0,
    httpPort: 0,
    map,
    buffer,
    state,
    samples,
    frames: 0,
    stats: () => ({ receiveToWrite: latencyStats(samples.map((s) => s.writtenAt - s.receivedAt)) }),
    close,
  };

  let seenPush = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let timeoutAt: number | undefined;
  let lastShowAt = 0;
  let pending: { sequence: number; receivedAt: number } | undefined;
  let showTimer: NodeJS.Timeout | undefined;
  let showing: Promise<void> = Promise.resolve();
  let lastLatency: number | undefined;

  // ---------------------------------------------------------------- realtime

  function realtimeLock(timeoutMs: number, mode: "DDP" | "", ip: string): void {
    if (!state.live && state.lor === 0) buffer.fill(0); // WLED: strip.fill(BLACK) on entry
    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    timeoutAt = undefined;
    if (timeoutMs !== WLED_NEVER_MS) {
      timeoutAt = now() + timeoutMs;
      timeoutTimer = setTimeout(exitRealtime, timeoutMs);
      timeoutTimer.unref();
    }
    state.live = true;
    state.lm = mode;
    state.lip = ip;
  }

  function exitRealtime(): void {
    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    timeoutAt = undefined;
    state.live = false;
    state.lm = "";
    state.lip = "";
    seenPush = false;
    if (state.lor === 1) state.lor = 0;
    show(0, now());
  }

  /** The bytes the strip would show: the live buffer, or the idle color, scaled by brightness. */
  function outputFrame(): Uint8Array {
    const out = new Uint8Array(buffer.length);
    if (!state.on) return out;
    const bri = state.forceMaxBri ? 255 : state.bri;
    if (state.live) {
      for (let i = 0; i < out.length; i++) out[i] = Math.round((buffer[i]! * bri) / 255);
      return out;
    }
    const r = Math.round((((WLED_DEFAULT_COLOR >>> 16) & 0xff) * bri) / 255);
    const g = Math.round((((WLED_DEFAULT_COLOR >>> 8) & 0xff) * bri) / 255);
    const b = Math.round(((WLED_DEFAULT_COLOR & 0xff) * bri) / 255);
    for (let i = 0; i < map.leds; i++) {
      out[i * LED_CHANNELS] = r;
      out[i * LED_CHANNELS + 1] = g;
      out[i * LED_CHANNELS + 2] = b;
    }
    return out;
  }

  /** Ask for a render; renders are spaced by the show interval and the last request wins. */
  function show(sequence: number, receivedAt: number): void {
    pending = { sequence, receivedAt };
    if (showTimer) return;
    const wait = Math.max(0, showInterval - (now() - lastShowAt));
    showTimer = setTimeout(() => {
      showTimer = undefined;
      const p = pending!;
      pending = undefined;
      showing = showing.then(async () => {
        await render(outputFrame(), view());
        const writtenAt = now();
        lastShowAt = writtenAt;
        sim.frames++;
        lastLatency = writtenAt - p.receivedAt;
        samples.push({ sequence: p.sequence, receivedAt: p.receivedAt, writtenAt });
      });
    }, wait);
  }

  function view(): SimView {
    return {
      name,
      state,
      map,
      frames: sim.frames,
      lastLatencyMs: lastLatency,
      timeoutLeftMs: timeoutAt === undefined ? undefined : Math.max(0, timeoutAt - now()),
    };
  }

  // ---------------------------------------------------------------- DDP in

  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, rinfo) => {
    let decoded: ReturnType<typeof decodeDdp>;
    try {
      decoded = decodeDdp(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    } catch {
      return; // too short, or data shorter than its declared range
    }
    const { header, data } = decoded;
    if (header.id === DDP_ID.CONTROL || header.id === DDP_ID.STATUS || header.id === DDP_ID.CONFIG) return;
    if (header.query || header.reply) return;
    if (!header.push && header.storage) return;
    const receivedAt = now();
    const cpl = channelsPerLed(header.type);
    const { start, stop } = ledRangeOf(header);
    if (state.lm !== "DDP") seenPush = false; // just starting, no push yet
    realtimeLock(state.timeoutMs, "DDP", rinfo.address);
    if (state.lor === 0) {
      let c = 0;
      for (let i = start; i < stop; i++, c += cpl) {
        if (i >= map.leds) break; // pixels past the strip are dropped
        buffer[i * LED_CHANNELS] = data[c]!;
        buffer[i * LED_CHANNELS + 1] = data[c + 1]!;
        buffer[i * LED_CHANNELS + 2] = data[c + 2]!;
      }
    }
    seenPush ||= header.push;
    if (!seenPush || header.push) show(header.sequence, receivedAt);
  });
  await new Promise<void>((resolve) => udp.bind(opts.udpPort ?? DDP_PORT, opts.bind ?? "127.0.0.1", resolve));
  sim.udpPort = udp.address().port;

  // ---------------------------------------------------------------- JSON API

  const info = () => ({
    ver: SIM_VERSION,
    vid: 2609060,
    leds: { count: map.leds, rgbw: false, pwr: 0, maxpwr: 0, maxseg: 1, fps: 0 },
    name,
    udpport: WLED_SYNC_PORT,
    live: state.live,
    lm: state.lm,
    lip: state.lip,
    ws: -1,
    fxcount: 1,
    palcount: 1,
    arch: "node",
    ip: "127.0.0.1",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    brand: "WLED",
    product: "VoxelPixelBit simulator",
    ...(opts.sensors ? { sensor: sensors() } : {}),
  });
  const sensors = () => {
    const base = typeof opts.sensors === "object" ? opts.sensors : {};
    const up = (Date.now() - startedAt) / 1000;
    const drift = Math.sin(up / 30);
    return [
      { type: "T", n: "board", val: Math.round(((base.temperature ?? 24) + drift * 0.5) * 10) / 10, unit: "°C", tm: Math.floor(up) },
      { type: "L", n: "ambient", val: Math.round((base.illuminance ?? 320) + drift * 20), unit: "lx", tm: Math.floor(up) },
    ];
  };
  const stateJson = () => ({
    on: state.on,
    bri: state.bri,
    transition: 7,
    ps: -1,
    pl: -1,
    lor: state.lor,
    mainseg: 0,
    seg: [
      {
        id: 0,
        start: 0,
        stop: map.leds,
        len: map.leds,
        on: true,
        bri: 255,
        col: [
          [(WLED_DEFAULT_COLOR >>> 16) & 0xff, (WLED_DEFAULT_COLOR >>> 8) & 0xff, WLED_DEFAULT_COLOR & 0xff],
          [0, 0, 0],
          [0, 0, 0],
        ],
        fx: 0,
      },
    ],
  });
  const cfgJson = () => ({ if: { live: { timeout: Math.round(state.timeoutMs / 100), maxbri: state.forceMaxBri } } });

  function applyState(body: Record<string, unknown>): void {
    if (typeof body.on === "boolean") state.on = body.on;
    if (typeof body.bri === "number") state.bri = clamp(Math.round(body.bri), 0, 255);
    if (typeof body.lor === "number") state.lor = clamp(Math.round(body.lor), 0, 2) as 0 | 1 | 2;
    if (body.live === true) realtimeLock(WLED_NEVER_MS, "", "");
    else if (body.live === false) exitRealtime();
    else show(0, now()); // brightness or power changed what the strip shows
  }

  function applyCfg(body: Record<string, unknown>): void {
    const live = (body.if as { live?: Record<string, unknown> } | undefined)?.live;
    if (!live) return;
    if (typeof live.timeout === "number") state.timeoutMs = Math.round(live.timeout) * 100;
    if (typeof live.maxbri === "boolean") state.forceMaxBri = live.maxbri;
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(body));
    };
    const readBody = (fn: (body: Record<string, unknown>) => void) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          fn(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
        } catch (err) {
          json(400, { error: (err as Error).message });
        }
      });
    };
    if (req.method === "GET") {
      if (url === "/json/info") return json(200, info());
      if (url === "/json/state") return json(200, stateJson());
      if (url === "/json/si") return json(200, { state: stateJson(), info: info() });
      if (url === "/json") return json(200, { state: stateJson(), info: info(), effects: ["Solid"], palettes: ["Default"] });
      if (url === "/json/cfg") return json(200, cfgJson());
      if (url === "/vpb/stats") return json(200, { frames: sim.frames, samples: samples.slice(-1000), ...sim.stats() });
      return json(404, { error: "not found" });
    }
    if (req.method === "POST" && (url === "/json/state" || url === "/json")) {
      return readBody((body) => {
        applyState(body);
        json(200, body.v === true ? stateJson() : { success: true });
      });
    }
    if (req.method === "POST" && url === "/json/cfg") {
      return readBody((body) => {
        applyCfg(body);
        json(200, { success: true });
      });
    }
    return json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(opts.httpPort ?? 8790, "127.0.0.1", resolve));
  const address = server.address();
  sim.httpPort = typeof address === "object" && address ? address.port : 0;

  async function close(): Promise<void> {
    clearTimeout(timeoutTimer);
    clearTimeout(showTimer);
    await showing;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => udp.close(() => resolve()));
  }

  show(0, now()); // the idle frame, so a fresh simulator shows WLED's orange
  return sim;
}

// ---------------------------------------------------------------- terminal

/** The parts of a terminal stream the renderer touches, so a test can hand in a fake. */
export interface TerminalLike {
  isTTY?: boolean;
  getColorDepth?(): number;
  write(text: string, cb?: () => void): boolean;
  on(event: "resize", listener: () => void): unknown;
}

/** Renders to a terminal: alternate screen, cursor home per frame, one write per frame. Silent when piped. */
export function terminalRenderer(
  map: LedMap,
  _name: string,
  out: TerminalLike = process.stdout,
): (frame: Uint8Array, view: SimView) => Promise<void> | undefined {
  const tty = out.isTTY === true;
  const depth = tty ? (out.getColorDepth?.() ?? 8) : 1;
  let cells: NetCell[] = cubeNetCells(map);
  let entered = false;
  const enter = () => {
    if (entered || !tty) return;
    entered = true;
    out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    const restore = () => {
      if (!entered) return;
      entered = false;
      out.write("\x1b[?25h\x1b[?1049l");
    };
    // Restore the screen first on any way out; whoever owns the process decides when to exit.
    process.on("exit", restore);
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.prependListener(sig, restore);
    out.on("resize", () => {
      cells = cubeNetCells(map);
      out.write("\x1b[2J");
    });
  };
  return (frame, view) => {
    if (!tty) return; // piped: frames stay silent, the ports line and the summary are enough
    enter();
    const s = view.state;
    const header = [
      `${view.name}  ${s.live ? `LIVE ${s.lm} from ${s.lip}` : "idle"}  bri ${s.bri}${s.forceMaxBri ? " (max)" : ""}  lor ${s.lor}  on ${s.on ? "yes" : "no"}`,
      `frames ${view.frames}  last receive→write ${view.lastLatencyMs === undefined ? "–" : `${view.lastLatencyMs.toFixed(1)} ms`}  timeout ${view.timeoutLeftMs === undefined ? (s.live ? "never" : "–") : `${(view.timeoutLeftMs / 1000).toFixed(1)} s`}  ${map.leds} LEDs`,
      "",
    ];
    const text = `\x1b[H${renderCubeNet(cells, frame, { colorDepth: depth, header })}\x1b[J`;
    return new Promise<void>((resolve) => out.write(text, () => resolve()));
  };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && /wled-sim\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const map = flag("map") ? ledMapFromJson(await fs.readFile(flag("map")!, "utf8")) : undefined;
  const noTty = args.includes("--no-tty");
  const sim = await startWledSim({
    udpPort: Number(flag("udp") ?? DDP_PORT),
    httpPort: Number(flag("http") ?? 8790),
    timeoutMs: Number(flag("timeout") ?? WLED_DEFAULT_TIMEOUT_MS),
    ...(flag("bind") ? { bind: flag("bind")! } : {}),
    ...(map ? { map } : {}),
    ...(flag("name") ? { name: flag("name")! } : {}),
    ...(noTty ? { render: () => {} } : {}),
    ...(args.includes("--sensors") ? { sensors: true } : {}),
  });
  process.stdout.write(`${JSON.stringify({ udp: sim.udpPort, http: sim.httpPort })}\n`);
  const bye = async () => {
    const s = sim.stats().receiveToWrite;
    process.stderr.write(`\n${sim.frames} frames; receive→write p50 ${s.p50.toFixed(2)} ms, p95 ${s.p95.toFixed(2)} ms\n`);
    await sim.close();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
