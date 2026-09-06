/**
 * The unfolded-cube view of a physical bit, for a terminal (ADR 0009).
 *
 * The net is the classic cross: +Y above, then −X, +Z, +X, −Z in a row,
 * then −Y below. Each face is an N×N tile of cells. Every cell is placed
 * on the cube's surface by a per-face (u, v) basis and classified by its
 * coordinate signs with `slotOf`, so a cell on a tile's border belongs to
 * the edge or vertex it really touches, and a shared edge or corner shows
 * the same LEDs on every tile that has it. Nothing here is hand-tabled.
 *
 * Inside a face tile the face's LEDs sit at the inner corners; the inner
 * middle cells average their neighbors. That part is a stylization, a
 * stand-in for a diffuser, and is labeled as such.
 */
import { LED_CHANNELS, type LedMap } from "../src/led-map.ts";
import {
  type Axis,
  kindOf,
  type NodeKind,
  type NodeSigns,
  type Sign,
  type Slot,
  slotOf,
  X,
  Y,
  Z,
} from "../src/slots.ts";

/** Cells per tile side. Corners and three edge cells per side need five. */
export const TILE = 5;

export interface NetCell {
  /** Row and column in the whole net, in cells. */
  row: number;
  col: number;
  slot: Slot;
  kind: NodeKind;
  /** Strip LED indices this cell shows, averaged. Empty means the slot has no LEDs. */
  leds: number[];
}

interface FaceBasis {
  axis: Axis;
  sign: Sign;
  /** Tile position in the net, in tiles. */
  tileRow: number;
  tileCol: number;
  /** Unit vectors for the tile's u (right) and v (up) directions. */
  u: readonly [number, number, number];
  v: readonly [number, number, number];
}

/** The six faces as they unfold, with the in-plane axes that keep neighbors continuous. */
const FACES: readonly FaceBasis[] = [
  { axis: Y, sign: 1, tileRow: 0, tileCol: 1, u: [1, 0, 0], v: [0, 0, -1] },
  { axis: X, sign: 0, tileRow: 1, tileCol: 0, u: [0, 0, 1], v: [0, 1, 0] },
  { axis: Z, sign: 1, tileRow: 1, tileCol: 1, u: [1, 0, 0], v: [0, 1, 0] },
  { axis: X, sign: 1, tileRow: 1, tileCol: 2, u: [0, 0, -1], v: [0, 1, 0] },
  { axis: Z, sign: 0, tileRow: 1, tileCol: 3, u: [-1, 0, 0], v: [0, 1, 0] },
  { axis: Y, sign: 0, tileRow: 2, tileCol: 1, u: [1, 0, 0], v: [0, 0, 1] },
];

/** Net size in cells: three tile rows, four tile columns. */
export const NET_ROWS = 3 * TILE;
export const NET_COLS = 4 * TILE;

/** The LED in a range for a position t in 0..1, nearest. */
function sample(start: number, count: number, t: number): number[] {
  if (count <= 0) return [];
  return [start + Math.round(t * (count - 1))];
}

/**
 * Every cell of the net, with the strip LEDs it shows under `map`.
 * Border cells resolve to edges and vertices by their signs; inner cells
 * to the face. Deterministic and pure.
 */
export function cubeNetCells(map: LedMap): NetCell[] {
  const cells: NetCell[] = [];
  for (const f of FACES) {
    const normal: [number, number, number] = [0, 0, 0];
    normal[f.axis] = f.sign ? 1 : -1;
    for (let r = 0; r < TILE; r++) {
      for (let c = 0; c < TILE; c++) {
        const u = -1 + (2 * c) / (TILE - 1);
        const v = 1 - (2 * r) / (TILE - 1);
        const p: [number, number, number] = [
          normal[0] + u * f.u[0] + v * f.v[0],
          normal[1] + u * f.u[1] + v * f.v[1],
          normal[2] + u * f.u[2] + v * f.v[2],
        ];
        const signs = p.map((x) => (Math.abs(x) >= 1 - 1e-9 ? (x > 0 ? 1 : 0) : null)) as [
          Sign | null,
          Sign | null,
          Sign | null,
        ];
        const slot = slotOf(signs as NodeSigns);
        const kind = kindOf(slot);
        const range = map.slots[slot] ?? { start: 0, count: 0 };
        let leds: number[];
        if (kind === "vertex") {
          leds = sample(range.start, range.count, 0);
        } else if (kind === "edge") {
          // The free axis runs the edge; LED 0 sits at its negative end. The
          // edge's cells are the border cells between the two corners, so
          // they span the edge from end to end once the corner step is removed.
          const free = signs.findIndex((s) => s === null);
          const step = 2 / (TILE - 1);
          const t = Math.min(1, Math.max(0, (p[free]! + 1 - step) / (2 - 2 * step)));
          leds = sample(range.start, range.count, t);
        } else {
          // Inner 3×3: the four face LEDs at the inner corners, middles averaged.
          const iu = Math.abs(u) > 0.25 ? (u > 0 ? 1 : 0) : null;
          const iv = Math.abs(v) > 0.25 ? (v > 0 ? 1 : 0) : null;
          const corners: number[] = [];
          for (const su of iu === null ? [0, 1] : [iu]) {
            for (const sv of iv === null ? [0, 1] : [iv]) {
              // Face LED order: 0 (−u,−v), 1 (+u,−v), 2 (−u,+v), 3 (+u,+v), resampled to the count.
              const t = (sv * 2 + su) / 3;
              corners.push(...sample(range.start, range.count, t));
            }
          }
          leds = [...new Set(corners)];
        }
        cells.push({ row: f.tileRow * TILE + r, col: f.tileCol * TILE + c, slot, kind, leds });
      }
    }
  }
  return cells;
}

export interface RenderOptions {
  /** 24 for truecolor, 8 for the 256-color cube, anything else for plain text. */
  colorDepth?: number;
  /** Lines printed above the net. */
  header?: string[];
}

/** Dark LEDs print as a dot so a mapped cell never looks like empty space. */
const PLAIN_RAMP = ".:-=+*#%@";

function averageColor(frame: Uint8Array, leds: number[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of leds) {
    r += frame[i * LED_CHANNELS] ?? 0;
    g += frame[i * LED_CHANNELS + 1] ?? 0;
    b += frame[i * LED_CHANNELS + 2] ?? 0;
  }
  const n = leds.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function cell(rgb: [number, number, number] | null, depth: number): string {
  if (rgb === null) {
    // No LED mapped here: grey, so it never reads as a dark LED.
    if (depth >= 24) return "\x1b[48;2;48;48;48m  \x1b[0m";
    if (depth >= 8) return "\x1b[48;5;238m  \x1b[0m";
    return "??";
  }
  const [r, g, b] = rgb;
  if (depth >= 24) return `\x1b[48;2;${r};${g};${b}m  \x1b[0m`;
  if (depth >= 8) {
    const q = (x: number) => Math.round((x / 255) * 5);
    return `\x1b[48;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m  \x1b[0m`;
  }
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const ch = PLAIN_RAMP[Math.min(PLAIN_RAMP.length - 1, Math.round(lum * (PLAIN_RAMP.length - 1)))]!;
  return ch + ch;
}

/**
 * The net as text, one line per cell row, two characters per cell, tiles
 * separated by a space. Cells outside the cross are blank.
 */
export function renderCubeNet(cells: readonly NetCell[], frame: Uint8Array, opts: RenderOptions = {}): string {
  const depth = opts.colorDepth ?? 1;
  const byPos = new Map<string, NetCell>();
  for (const c of cells) byPos.set(`${c.row},${c.col}`, c);
  const lines: string[] = [...(opts.header ?? [])];
  for (let row = 0; row < NET_ROWS; row++) {
    let line = "";
    for (let col = 0; col < NET_COLS; col++) {
      if (col > 0 && col % TILE === 0) line += " ";
      const c = byPos.get(`${row},${col}`);
      if (!c) {
        line += "  ";
        continue;
      }
      line += cell(c.leds.length ? averageColor(frame, c.leds) : null, depth);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return `${lines.join("\n")}\n`;
}
