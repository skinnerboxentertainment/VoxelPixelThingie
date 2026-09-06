/**
 * Local compute (PLAN-3.md Phase 13): a WebGPU kernel that produces the
 * LED frames of many bits in one dispatch, and the browser-side actor
 * workloads that use it. The check on a GPU frame is the CPU path: a
 * frame that differs from `ledFrame` by one byte fails its audit.
 *
 * Rounding follows the CPU's `Math.round` (half up), written as
 * floor(x + 0.5); WGSL's `round` is half to even and would disagree on
 * every exact half.
 */
import {
  type BitRecord,
  defaultLedMap,
  LED_CHANNELS,
  type LedMap,
  ledFrame,
  ledMapOf,
  NODE_COUNT,
  type Outcome,
  type Workload,
} from "../../src/index.ts";

const SHADER = /* wgsl */ `
struct Node { color: u32, light: f32, flags: u32, pad: u32 }
struct Bit { present: u32, color: u32, pad0: u32, pad1: u32 }
struct Params { leds: u32, bits: u32, pad0: u32, pad1: u32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bits: array<Bit>;
@group(0) @binding(2) var<storage, read> nodes: array<Node>;       // bits * 26
@group(0) @binding(3) var<storage, read> ledSlot: array<i32>;      // leds: slot per LED, -1 unmapped
@group(0) @binding(4) var<storage, read_write> out: array<u32>;    // bits * leds: packed 0x00BBGGRR

const HAS_COLOR: u32 = 1u;
const HAS_LIGHT: u32 = 2u;

fn scale(channel: u32, light: f32) -> u32 {
  // Math.round for non-negative values: floor(x + 0.5).
  return u32(floor(f32(channel) * light + 0.5));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.bits * params.leds) { return; }
  let b = i / params.leds;
  let led = i % params.leds;
  out[i] = 0u;
  let bit = bits[b];
  if (bit.present == 0u) { return; }
  let slot = ledSlot[led];
  if (slot < 0) { return; }
  let node = nodes[b * 26u + u32(slot)];
  if ((node.flags & (HAS_COLOR | HAS_LIGHT)) == 0u) { return; }
  var color = bit.color;
  if ((node.flags & HAS_COLOR) != 0u) { color = node.color; }
  var light = 1.0;
  if ((node.flags & HAS_LIGHT) != 0u) { light = clamp(node.light, 0.0, 1.0); }
  let r = scale((color >> 16u) & 255u, light);
  let g = scale((color >> 8u) & 255u, light);
  let bl = scale(color & 255u, light);
  out[i] = r | (g << 8u) | (bl << 16u);
}
`;

export interface GpuFrames {
  device: GPUDevice;
  /** Frames for the records in order, each map.leds * 3 bytes. */
  run(records: readonly BitRecord[], map?: LedMap): Promise<{ frames: Uint8Array[]; ms: number }>;
  destroy(): void;
}

/** True when this browser exposes WebGPU at all. */
export const hasWebGpu = (): boolean =>
  typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu !== undefined;

/** A device and a compiled kernel, or undefined when the browser has no WebGPU. */
export async function createGpuFrames(): Promise<GpuFrames | undefined> {
  if (!hasWebGpu()) return undefined;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return undefined;
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: SHADER });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });

  const run: GpuFrames["run"] = async (records, map = defaultLedMap()) => {
    const t0 = performance.now();
    const n = records.length;
    const leds = map.leds;
    // Per LED, which slot owns it; -1 for none.
    const ledSlot = new Int32Array(Math.max(1, leds)).fill(-1);
    map.slots.forEach((r, slot) => {
      for (let i = r.start; i < r.start + r.count; i++) ledSlot[i] = slot;
    });
    const bits = new Uint32Array(Math.max(1, n) * 4);
    const nodes = new ArrayBuffer(Math.max(1, n) * NODE_COUNT * 16);
    const nodeU32 = new Uint32Array(nodes);
    const nodeF32 = new Float32Array(nodes);
    records.forEach((rec, b) => {
      bits[b * 4] = rec.present ? 1 : 0;
      bits[b * 4 + 1] = rec.color >>> 0;
      for (let s = 0; s < NODE_COUNT; s++) {
        const e = rec.emissions[s] ?? {};
        const at = (b * NODE_COUNT + s) * 4;
        nodeU32[at] = (e.color ?? 0) >>> 0;
        nodeF32[at + 1] = e.light ?? 1;
        nodeU32[at + 2] = (e.color !== undefined ? 1 : 0) | (e.light !== undefined ? 2 : 0);
      }
    });
    const outCount = Math.max(1, n * leds);
    const mk = (usage: number, size: number) =>
      device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    const paramsBuf = mk(GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 16);
    device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([leds, n, 0, 0]));
    const bitsBuf = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, bits.byteLength);
    device.queue.writeBuffer(bitsBuf, 0, bits);
    const nodesBuf = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, nodes.byteLength);
    device.queue.writeBuffer(nodesBuf, 0, nodes);
    const slotBuf = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, ledSlot.byteLength);
    device.queue.writeBuffer(slotBuf, 0, ledSlot);
    const outBuf = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, outCount * 4);
    const readBuf = mk(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, outCount * 4);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: bitsBuf } },
        { binding: 2, resource: { buffer: nodesBuf } },
        { binding: 3, resource: { buffer: slotBuf } },
        { binding: 4, resource: { buffer: outBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(outCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, readBuf.size);
    device.queue.submit([encoder.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const packed = new Uint32Array(readBuf.getMappedRange().slice(0, outCount * 4));
    readBuf.unmap();
    for (const b of [paramsBuf, bitsBuf, nodesBuf, slotBuf, outBuf, readBuf]) b.destroy();
    const frames: Uint8Array[] = [];
    for (let b = 0; b < n; b++) {
      const f = new Uint8Array(leds * LED_CHANNELS);
      for (let led = 0; led < leds; led++) {
        const v = packed[b * leds + led]!;
        f[led * 3] = v & 0xff;
        f[led * 3 + 1] = (v >>> 8) & 0xff;
        f[led * 3 + 2] = (v >>> 16) & 0xff;
      }
      frames.push(f);
    }
    return { frames, ms: performance.now() - t0 };
  };

  return { device, run, destroy: () => device.destroy() };
}

/** Index of the first byte that differs, or -1 when the frames are equal. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/**
 * The GPU LED-frame workload. The audit is the CPU path: the frames must be
 * byte-equal. A browser without WebGPU fails the audit and says so; the job
 * is not lost.
 */
export function gpuLedFrameWorkload(gpu: () => GpuFrames | undefined): Workload {
  return async (bit): Promise<Outcome> => {
    const g = gpu();
    const rec = bit.record();
    const map = ledMapOf(rec.passport) ?? defaultLedMap();
    if (!g)
      return {
        value: null,
        check: "WebGPU is available",
        passed: false,
        detail: "no WebGPU in this browser",
      };
    const { frames, ms } = await g.run([rec], map);
    const cpu = ledFrame(rec, map);
    const diff = firstDifference(frames[0]!, cpu);
    return {
      bytes: frames[0]!,
      check: "GPU frame is byte-equal to the CPU ledFrame",
      passed: diff === -1,
      detail:
        diff === -1
          ? `${cpu.length} bytes equal, dispatch ${ms.toFixed(2)} ms`
          : `first difference at byte ${diff}`,
    };
  };
}
