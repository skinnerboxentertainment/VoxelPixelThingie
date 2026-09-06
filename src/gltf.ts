/**
 * glTF interchange (PLAN-4.md Phase 23, ADR 0017): a scene in the 3D
 * format Blender, game engines, and browsers open, with each bit's
 * identity riding along in `extras`.
 *
 * Export: one node per bit, translated to its position; one shared unit
 * cube; one material per distinct (color, light) with the emission in
 * `emissiveFactor` (and `KHR_materials_emissive_strength` when the light
 * exceeds one). The node's `extras.vpb` carries the bit's id, presence,
 * color, 26 emissions, and passport; the scene's `extras.vpb.pack`
 * carries the whole packed scene (gzip, base64) by default, so history
 * travels too and an import gives the exported scene back exactly.
 *
 * Import: with the pack, unpack and open it, then apply any translation
 * that differs from the bit's position as one `moved` event under actor
 * `gltf:import`; without it, rebuild the bits from the nodes.
 */
import type { BitHandle, BitRecord, Container } from "./container.ts";
import type { EventSink } from "./events.ts";
import { FlatGrid } from "./flat-grid.ts";
import type { JsonObject } from "./json.ts";
import { packFromText, packScene, packToText, type ScenePack, unpackScene } from "./pack.ts";
import { openScene } from "./scene.ts";
import { FACE_SLOTS } from "./slots.ts";
import { type FileStore, MemoryStore } from "./store.ts";
import type { Emission, Vec3 } from "./vpb.ts";

export const GLTF_FORMAT = "vpb-gltf/1";
export const EMISSIVE_STRENGTH = "KHR_materials_emissive_strength";

export interface GltfJson {
  asset: { version: "2.0"; generator: string };
  scene: number;
  scenes: { name?: string; nodes: number[]; extras?: Record<string, unknown> }[];
  nodes: {
    name?: string;
    translation?: [number, number, number];
    mesh?: number;
    extras?: Record<string, unknown>;
  }[];
  meshes: {
    name?: string;
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: Record<string, unknown>[];
  accessors: Record<string, unknown>[];
  bufferViews: Record<string, unknown>[];
  buffers: { byteLength: number; uri?: string }[];
  extensionsUsed?: string[];
}

export interface NodeExtras {
  id: string;
  present: boolean;
  color: number;
  emissions: Emission[];
  passport: JsonObject;
}

export interface SceneExtras {
  format: typeof GLTF_FORMAT;
  scene: string;
  bits: number;
  /** The packed scene, gzip then base64, when the export carried the ledgers. */
  pack?: string;
}

export interface ExportOptions {
  /** Carry the whole packed scene so history survives the round trip. Default true; needs `store`. */
  ledgers?: boolean;
  /** The store the scene was opened from, for the pack. */
  store?: FileStore;
  /** Cube edge length. Default 1: adjacent bits touch. */
  size?: number;
}

// ---------------------------------------------------------------- geometry

/** A unit cube as 24 vertices (4 per face, flat normals) and 36 indices. */
function cube(size: number): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
} {
  const h = size / 2;
  const faces: {
    n: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
  }[] = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);
  faces.forEach((f, fi) => {
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    corners.forEach(([a, b], ci) => {
      const vi = fi * 4 + ci;
      for (let k = 0; k < 3; k++) {
        positions[vi * 3 + k] = h * (f.n[k] + a * f.u[k] + b * f.v[k]);
        normals[vi * 3 + k] = f.n[k];
      }
    });
    const base = fi * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], fi * 6);
  });
  return { positions, normals, indices };
}

const pad4 = (n: number) => (n + 3) & ~3;

function concatBin(parts: Uint8Array[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let total = 0;
  for (const p of parts) {
    offsets.push(total);
    total = pad4(total + p.length);
  }
  const bin = new Uint8Array(total);
  for (const [i, p] of parts.entries()) bin.set(p, offsets[i]!);
  return { bin, offsets };
}

// ---------------------------------------------------------------- gzip

async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gunzipBase64(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// ---------------------------------------------------------------- export

const rgb = (color: number): [number, number, number] => [
  ((color >>> 16) & 0xff) / 255,
  ((color >>> 8) & 0xff) / 255,
  (color & 0xff) / 255,
];

/** The light a bit's faces emit: the mean of the face slots that say, else 1. */
export function faceLight(rec: BitRecord): number {
  const lights = FACE_SLOTS.map((s) => rec.emissions[s]?.light).filter(
    (l): l is number => l !== undefined,
  );
  return lights.length ? lights.reduce((a, b) => a + b, 0) / lights.length : 1;
}

export async function toGltf(
  grid: Container,
  opts: ExportOptions = {},
): Promise<{ json: GltfJson; bin: Uint8Array }> {
  const size = opts.size ?? 1;
  const geometry = cube(size);
  const { bin, offsets } = concatBin([
    new Uint8Array(geometry.positions.buffer),
    new Uint8Array(geometry.normals.buffer),
    new Uint8Array(geometry.indices.buffer),
  ]);
  const h = size / 2;
  const json: GltfJson = {
    asset: { version: "2.0", generator: "VoxelPixelThingie" },
    scene: 0,
    scenes: [{ name: grid.id, nodes: [], extras: {} }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: "VEC3",
        min: [-h, -h, -h],
        max: [h, h, h],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: offsets[0],
        byteLength: geometry.positions.byteLength,
        target: 34962,
      },
      { buffer: 0, byteOffset: offsets[1], byteLength: geometry.normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: geometry.indices.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const materialIndex = new Map<string, number>();
  let strength = false;
  const materialFor = (color: number, light: number): number => {
    const key = `${color}:${light}`;
    let i = materialIndex.get(key);
    if (i !== undefined) return i;
    const base = rgb(color);
    const clamped = Math.min(light, 1);
    const material: Record<string, unknown> = {
      name: `bit ${color.toString(16).padStart(6, "0")} light ${light}`,
      pbrMetallicRoughness: {
        baseColorFactor: [...base, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      emissiveFactor: base.map((c) => c * clamped),
    };
    if (light > 1) {
      material.extensions = { [EMISSIVE_STRENGTH]: { emissiveStrength: light } };
      strength = true;
    }
    i = json.materials.length;
    json.materials.push(material);
    json.meshes.push({
      name: `cube ${i}`,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: i }],
    });
    materialIndex.set(key, i);
    return i;
  };
  const records = grid.snapshot();
  for (const rec of records) {
    const extras: NodeExtras = {
      id: rec.id,
      present: rec.present,
      color: rec.color,
      emissions: rec.emissions,
      passport: rec.passport,
    };
    const node: GltfJson["nodes"][number] = {
      name: rec.id,
      translation: [rec.position[0] * size, rec.position[1] * size, rec.position[2] * size],
      extras: { vpb: extras },
    };
    if (rec.present) node.mesh = materialFor(rec.color, faceLight(rec));
    json.scenes[0]!.nodes.push(json.nodes.length);
    json.nodes.push(node);
  }
  if (strength) json.extensionsUsed = [EMISSIVE_STRENGTH];
  const sceneExtras: SceneExtras = { format: GLTF_FORMAT, scene: grid.id, bits: records.length };
  if (opts.ledgers ?? true) {
    if (!opts.store)
      throw new Error(
        "carrying the ledgers needs the store the scene was opened from (or ledgers: false)",
      );
    sceneExtras.pack = await gzipBase64(packToText(await packScene(opts.store)));
  }
  json.scenes[0]!.extras = { vpb: sceneExtras };
  return { json, bin };
}

/** Pack JSON and binary into one GLB. */
export function toGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const binLen = pad4(bin.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  const binAt = 20 + jsonLen;
  view.setUint32(binAt, binLen, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // BIN
  out.set(bin, binAt + 8);
  return out;
}

export function parseGlb(bytes: Uint8Array): { json: GltfJson; bin?: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  if (view.getUint32(4, true) !== 2) throw new Error("GLB version is not 2");
  let at = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  while (at < bytes.length) {
    const len = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
    else if (type === 0x004e4942) bin = chunk;
    at += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, ...(bin ? { bin } : {}) };
}

// ---------------------------------------------------------------- import

export interface ImportOptions {
  /** Where the carried pack is unpacked, or where a rebuilt scene's events land. Default a MemoryStore. */
  store?: FileStore;
  sink?: EventSink;
  now?: () => number;
  /** Cube edge length the export used. Default 1. */
  size?: number;
}

export interface ImportResult {
  grid: FlatGrid;
  store: FileStore;
  /** "pack": the carried scene, opened; "nodes": rebuilt from the nodes alone. */
  source: "pack" | "nodes";
  /** Bits whose node translation differed from their position, moved on import. */
  moved: string[];
}

export function sceneExtrasOf(json: GltfJson): SceneExtras | undefined {
  const vpb = (json.scenes[json.scene ?? 0]?.extras as { vpb?: SceneExtras } | undefined)?.vpb;
  return vpb?.format === GLTF_FORMAT ? vpb : undefined;
}

export function nodeExtrasOf(node: GltfJson["nodes"][number]): NodeExtras | undefined {
  const vpb = (node.extras as { vpb?: NodeExtras } | undefined)?.vpb;
  return vpb && typeof vpb.id === "string" ? vpb : undefined;
}

export async function fromGltf(json: GltfJson, opts: ImportOptions = {}): Promise<ImportResult> {
  const size = opts.size ?? 1;
  const extras = sceneExtrasOf(json);
  if (!extras) throw new Error("not a VoxelPixelThingie glTF: no vpb extras on the scene");
  const store = opts.store ?? new MemoryStore();
  const positionOf = (n: GltfJson["nodes"][number]): Vec3 => {
    const t = n.translation ?? [0, 0, 0];
    return [Math.round(t[0] / size), Math.round(t[1] / size), Math.round(t[2] / size)];
  };
  const moved: string[] = [];
  if (extras.pack) {
    const pack: ScenePack = packFromText(await gunzipBase64(extras.pack));
    await unpackScene(pack, store);
    const grid = await openScene(store, {
      ...(opts.sink ? { attach: opts.sink } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    for (const node of json.nodes) {
      const ne = nodeExtrasOf(node);
      if (!ne) continue;
      const bit = grid.get(ne.id);
      if (!bit) continue;
      const to = positionOf(node);
      if (bit.position[0] !== to[0] || bit.position[1] !== to[1] || bit.position[2] !== to[2]) {
        grid.wrangle({ actor: "gltf:import", cause: "moved in glTF" }, () => grid.move(bit, to));
        moved.push(ne.id);
      }
    }
    return { grid, store, source: "pack", moved };
  }
  const grid = new FlatGrid({
    id: extras.scene,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  grid.wrangle({ actor: "gltf:import", cause: "rebuilt from glTF nodes" }, () => {
    for (const node of json.nodes) {
      const ne = nodeExtrasOf(node);
      if (!ne) continue;
      const bit: BitHandle = grid.add(positionOf(node), {
        id: ne.id,
        color: ne.color,
        present: ne.present,
      });
      ne.emissions.forEach((e, slot) => {
        if (e && (e.color !== undefined || e.light !== undefined || e.data !== undefined))
          bit.emit(slot, e);
      });
      if (ne.passport && Object.keys(ne.passport).length) bit.setPassport(ne.passport);
    }
  });
  return { grid, store, source: "nodes", moved };
}
