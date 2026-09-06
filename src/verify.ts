/**
 * Integrity for scenes on stores that do not address content by hash
 * (SPEC.md §10.3, §10.9). sealScene writes a SHA-256 per file into the
 * manifest; verifyScene recomputes and compares. sceneDigest is one hash
 * over everything a round trip must reproduce, for comparing a scene opened
 * from two stores.
 */
import type { Grid } from "./grid.ts";
import { ledgerPath, mapLimit, passportPath, readManifest } from "./scene.ts";
import type { FileStore } from "./store.ts";
import type { Camera } from "./vpb.ts";

const subtle = () => {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!c) throw new Error("no WebCrypto available");
  return c;
};

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle().digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Write a SHA-256 per passport and ledger into manifest.hashes. Call at publish time. */
export async function sealScene(store: FileStore): Promise<number> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  const hashes: Record<string, { passport: string; events: string }> = {};
  await mapLimit(ids, 64, async (id) => {
    const [p, l] = await Promise.all([store.read(passportPath(id)), store.read(ledgerPath(id))]);
    hashes[id] = { passport: await sha256Hex(p ?? ""), events: await sha256Hex(l ?? "") };
  });
  const sealed = { ...manifest, ids: [...ids].sort(), hashes: sortKeys(hashes) };
  await store.write("manifest.json", `${JSON.stringify(sealed, null, 2)}\n`);
  return ids.length;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  mismatches: { id: string; file: "passport" | "events" }[];
  reason?: string;
}

/** Recompute every hash in manifest.hashes and report what differs. */
export async function verifyScene(store: FileStore): Promise<VerifyReport> {
  const manifest = await readManifest(store);
  if (!manifest) return { ok: false, checked: 0, mismatches: [], reason: "not a scene" };
  if (!manifest.hashes)
    return { ok: false, checked: 0, mismatches: [], reason: "scene is not sealed" };
  const mismatches: VerifyReport["mismatches"] = [];
  const entries = Object.entries(manifest.hashes);
  await mapLimit(entries, 64, async ([id, expected]) => {
    const [p, l] = await Promise.all([store.read(passportPath(id)), store.read(ledgerPath(id))]);
    if ((await sha256Hex(p ?? "")) !== expected.passport) mismatches.push({ id, file: "passport" });
    if ((await sha256Hex(l ?? "")) !== expected.events) mismatches.push({ id, file: "events" });
  });
  mismatches.sort((a, b) => (a.id + a.file < b.id + b.file ? -1 : 1));
  return { ok: mismatches.length === 0, checked: entries.length, mismatches };
}

/** Everything SPEC.md §10.9 says a round trip must reproduce, in a stable shape. */
export function sceneCanonical(grid: Grid, camera: Camera = { position: [20, 10, 30] }) {
  grid.evaluate(camera);
  return {
    scene: grid.id,
    bits: [...grid.bits()]
      .map((b) => ({
        id: b.id,
        position: b.position,
        present: b.present,
        color: b.color,
        passport: b.passport,
        emissions: b.nodes.map((n) => n.emission),
        links: b.nodes.map((n) => n.links.map((l) => `${l.bit.id}:${l.slot}`).sort()),
        renderCycle: b.renderCycle,
        renderEnabled: b.nodes.map((n) => n.renderEnabled),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** One hash over sceneCanonical. Equal digests from two stores mean the same bits. */
export async function sceneDigest(grid: Grid, camera?: Camera): Promise<string> {
  return sha256Hex(JSON.stringify(sceneCanonical(grid, camera)));
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}
