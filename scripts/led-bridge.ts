/**
 * The LED bridge (PLAN-2.md Phase 10): Node-side glue between a scene, or
 * the browser demo, and a WLED strip. Browsers cannot send UDP, so the demo
 * posts a bit's state as JSON to this bridge over HTTP and the bridge
 * pushes it as DDP. Every post is timed: event time in the demo to the
 * moment the packet leaves the socket, the software half of click-to-photon.
 *
 * This file is Node-only (dgram, http) and is deliberately not exported from
 * src/index.ts, which the browser bundles.
 */
import dgram from "node:dgram";
import http from "node:http";
import { DDP_PORT, ddpFrame, nextSequence } from "../src/ddp.ts";
import {
  defaultLedMap,
  LED_CHANNELS,
  ledFrame,
  type LedMap,
  parseFramePost,
} from "../src/led-map.ts";

export { LED_FRAME_FORMAT, type LedFramePost, parseFramePost } from "../src/led-map.ts";

/**
 * Milliseconds since the epoch with sub-millisecond resolution, aligned to
 * the wall clock at startup. Node's performance.timeOrigin can sit seconds
 * away from Date.now() on Windows, and stamps from different processes
 * (the browser, the bridge, the simulator) have to share one clock.
 */
const WALL_OFFSET = Date.now() - (performance.timeOrigin + performance.now());
export const wallNow = (): number => performance.timeOrigin + performance.now() + WALL_OFFSET;

export interface SendResult {
  packets: number;
  bytes: number;
  /** DDP sequence number of the frame's first packet, 1..15. */
  sequence: number;
  /** performance.timeOrigin + performance.now() when the last packet was handed to the socket. */
  sentAt: number;
}

/** Sends frames as DDP to one display, with a running sequence number. */
export class DdpSender {
  readonly host: string;
  readonly port: number;
  #socket: dgram.Socket | undefined;
  #sequence = 1;
  /** Sends run one frame at a time so two callers never interleave a multi-packet frame. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly dryRun: boolean;
  /** Set in dry runs: the packets that would have gone out, hex. */
  readonly dryPackets: string[] = [];

  constructor(host: string, port = DDP_PORT, opts: { dryRun?: boolean; socket?: dgram.Socket } = {}) {
    this.host = host;
    this.port = port;
    this.dryRun = opts.dryRun ?? false;
    if (!this.dryRun) this.#socket = opts.socket ?? dgram.createSocket("udp4");
  }

  send(frame: Uint8Array): Promise<SendResult> {
    const run = this.#queue.then(() => this.#sendNow(frame));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #sendNow(frame: Uint8Array): Promise<SendResult> {
    const sequence = this.#sequence;
    const packets = ddpFrame(frame, { sequence });
    this.#sequence = nextSequence(this.#sequence + packets.length - 1);
    let bytes = 0;
    for (const p of packets) {
      bytes += p.length;
      if (this.dryRun) {
        this.dryPackets.push(Buffer.from(p).toString("hex"));
        continue;
      }
      await new Promise<void>((resolve, reject) =>
        this.#socket!.send(p, this.port, this.host, (err) => (err ? reject(err) : resolve())),
      );
    }
    return { packets: packets.length, bytes, sequence, sentAt: wallNow() };
  }

  close(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }
}

export interface LatencySample {
  bit: string;
  /** DDP sequence of the frame's first packet, to join with a receiver's samples. */
  sequence: number;
  /** The poster's event time, ms since the epoch. */
  eventTime: number;
  /** When the last packet was handed to the socket, ms since the epoch. */
  sentAt: number;
  /** Demo event time to the packet leaving, ms. */
  eventToPacket: number;
  /** Bridge receipt to the packet leaving, ms. */
  receiptToPacket: number;
}

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) return { n: 0, p50: Number.NaN, p95: Number.NaN, max: Number.NaN };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

export interface BridgeOptions {
  /** The DDP sender, or where to build one. */
  sender?: DdpSender;
  host?: string;
  port?: number;
  dryRun?: boolean;
  /** TCP port to listen on; 0 picks a free one. Default 4049. */
  listen?: number;
  /** Used when a post carries no map. Default the plan's 68-LED map. */
  map?: LedMap;
  log?: (line: string) => void;
}

export interface Bridge {
  url: string;
  port: number;
  sender: DdpSender;
  samples: LatencySample[];
  stats(): { eventToPacket: LatencyStats; receiptToPacket: LatencyStats };
  close(): Promise<void>;
}

/**
 * An HTTP server that turns posted frames into DDP. POST /frame with a
 * LedFramePost; GET /stats for the latency distribution; CORS is open so a
 * page on another origin can post.
 */
export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const sender =
    opts.sender ?? new DdpSender(opts.host ?? "127.0.0.1", opts.port ?? DDP_PORT, { dryRun: opts.dryRun ?? false });
  const map = opts.map ?? defaultLedMap();
  const log = opts.log ?? (() => {});
  const samples: LatencySample[] = [];
  const buffer = new Uint8Array(map.leds * LED_CHANNELS);
  const stats = () => ({
    eventToPacket: latencyStats(samples.map((s) => s.eventToPacket)),
    receiptToPacket: latencyStats(samples.map((s) => s.receiptToPacket)),
  });
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/stats") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify(stats()));
      return;
    }
    if (req.method !== "POST" || req.url !== "/frame") {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const receivedAt = wallNow();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const post = parseFramePost(Buffer.concat(chunks).toString("utf8"));
          const m = post.map ?? map;
          const frame = m === map ? ledFrame(post, m, buffer) : ledFrame(post, m);
          const sent = await sender.send(frame);
          const sample: LatencySample = {
            bit: post.bit,
            sequence: sent.sequence,
            eventTime: post.time,
            sentAt: sent.sentAt,
            eventToPacket: sent.sentAt - post.time,
            receiptToPacket: sent.sentAt - receivedAt,
          };
          samples.push(sample);
          log(`${post.bit} ${post.present ? "lit" : "dark"} ${sent.packets} packet(s) event→packet ${sample.eventToPacket.toFixed(1)} ms`);
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...sent, ...sample }));
        } catch (err) {
          res.writeHead(400, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.listen ?? 4049, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.listen ?? 4049);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sender,
    samples,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        sender.close();
      }),
  };
}
