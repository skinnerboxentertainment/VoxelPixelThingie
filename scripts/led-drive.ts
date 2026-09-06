/**
 * Drive a physical bit (PLAN-2.md Phase 10).
 *
 *   npm run led:drive -- --host <wled ip> --scene <folder|pack.json> [--bit <id>]
 *       light one bit from a scene, once
 *   npm run led:drive -- --host <wled ip> --listen [port]
 *       run the bridge the Three.js demo posts to (demo/three/?led=http://127.0.0.1:4049&bit=<id>)
 *   add --dry-run to print the packets instead of sending them
 *   add --map <led-map.json> to use a map other than the bit's passport or the default
 *
 * The map comes from, in order: --map, the bit's passport `ledMap`, the
 * plan's 68-LED default.
 */
import { promises as fs } from "node:fs";
import { DDP_PORT } from "../src/ddp.ts";
import { defaultLedMap, ledFrame, type LedMap, ledMapFromJson, ledMapOf } from "../src/led-map.ts";
import { PackedStore } from "../src/pack.ts";
import { openScene } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { DdpSender, startBridge } from "./led-bridge.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
};
const has = (name: string) => args.includes(`--${name}`);

const host = flag("host") ?? "127.0.0.1";
const port = Number(flag("port") ?? DDP_PORT);
const dryRun = has("dry-run");
const mapFile = flag("map");
const mapArg: LedMap | undefined = mapFile ? ledMapFromJson(await fs.readFile(mapFile, "utf8")) : undefined;

if (has("listen")) {
  const listen = Number(flag("listen") || 4049);
  const bridge = await startBridge({
    host,
    port,
    dryRun,
    listen,
    ...(mapArg ? { map: mapArg } : {}),
    log: (line) => console.log(line),
  });
  console.log(`bridge at ${bridge.url}; DDP to ${host}:${port}${dryRun ? " (dry run)" : ""}`);
  console.log(`open the demo with ?led=${bridge.url}&bit=<bit id>; GET ${bridge.url}/stats for latency`);
  const stop = async () => {
    const s = bridge.stats();
    console.log(`\n${s.eventToPacket.n} frames; event→packet p50 ${s.eventToPacket.p50.toFixed(1)} ms, p95 ${s.eventToPacket.p95.toFixed(1)} ms, max ${s.eventToPacket.max.toFixed(1)} ms`);
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const scene = flag("scene");
  if (!scene) {
    console.error("usage: led-drive --host <ip> (--scene <folder|pack.json> [--bit <id>] | --listen [port]) [--dry-run] [--map file]");
    process.exit(2);
  }
  const store = scene.endsWith(".json") ? PackedStore.fromText(await fs.readFile(scene, "utf8")) : new NodeFsStore(scene);
  const grid = await openScene(store);
  const wanted = flag("bit");
  const bit = wanted ? grid.get(wanted) : [...grid.bits()].find((b) => b.present);
  if (!bit) {
    console.error(wanted ? `no bit ${wanted} in the scene` : "no present bit in the scene");
    process.exit(1);
  }
  const map = mapArg ?? ledMapOf(bit.passport) ?? defaultLedMap();
  const frame = ledFrame(bit.record(), map);
  const lit = Array.from({ length: map.leds }, (_, i) => frame[i * 3]! | frame[i * 3 + 1]! | frame[i * 3 + 2]!).filter(Boolean).length;
  const sender = new DdpSender(host, port, { dryRun });
  const sent = await sender.send(frame);
  sender.close();
  console.log(`bit ${bit.id} at ${bit.key}: ${map.leds} LEDs, ${lit} lit, ${sent.packets} packet(s), ${sent.bytes} bytes${dryRun ? " (dry run)" : ` to ${host}:${port}`}`);
  if (dryRun) for (const p of sender.dryPackets) console.log(p);
}
