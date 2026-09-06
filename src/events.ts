/**
 * Events: the VPB's history. SPEC.md §9.2, ADR 0005.
 *
 * Bits emit event bodies. The container stamps them with the bit id, a
 * sequence number, and a time, and hands them to a sink. The default sink
 * discards. Nothing in the render path reads events.
 */

import type { Container, ContainerOptions } from "./container.ts";
import { FlatGrid } from "./flat-grid.ts";
import type { JsonObject } from "./json.ts";
import type { Offset, Slot } from "./slots.ts";
import type { Emission, Vec3 } from "./vpb.ts";

export type BitEventBody =
  | { type: "created"; position: Vec3; color: number; emission?: Emission }
  | { type: "presence"; present: boolean }
  | { type: "emitted"; slot: Slot; emission: Emission }
  | { type: "linked"; neighbor: string; slot: Slot; partner: Slot; offset: Offset }
  | { type: "unlinked"; neighbor: string; slot: Slot }
  | { type: "moved"; from: Vec3; to: Vec3 }
  | { type: "annotated"; key: string; value: unknown }
  | { type: "passport"; passport: JsonObject }
  | { type: "destroyed" };

export type BitEvent = BitEventBody & {
  /** Id of the bit the event belongs to. */
  readonly bit: string;
  /** Monotonic within one container. */
  readonly seq: number;
  /** Supplied by the container's clock. */
  readonly time: number;
  /** The container's id: where this happened (SPEC.md §9.2). */
  readonly frame: string;
  /** Who or what made the change, from the wrangler context (§9.6). */
  readonly actor?: string;
  /** Why, from the wrangler context (§9.6). */
  readonly cause?: string;
};

/** Who is changing bits and why. Stamped onto events while active (§9.6). */
export interface WranglerContext {
  actor?: string;
  cause?: string;
}

export interface EventSink {
  record(event: BitEvent): void;
}

export const NULL_SINK: EventSink = { record() {} };

export class RecordingSink implements EventSink {
  readonly events: BitEvent[] = [];
  record(event: BitEvent): void {
    this.events.push(event);
  }
}

/**
 * Fold a log into a fresh Grid. `linked` and `unlinked` are derived by the
 * grid from the other events and are skipped. Ids are preserved, including
 * the container's, so replayed events carry the original frame. Replayed
 * events are stamped actor "replay" and keep the original cause.
 */
export interface ReplayOptions<C extends Container = FlatGrid> extends ContainerOptions {
  /** Which container to rebuild into. Default: FlatGrid (ADR 0007). */
  factory?: (opts?: ContainerOptions) => C;
}

export function replay<C extends Container = FlatGrid>(
  events: Iterable<BitEvent>,
  opts: ReplayOptions<C> = {},
): C {
  const { factory, ...rest } = opts;
  const make = factory ?? ((o?: ContainerOptions) => new FlatGrid(o) as unknown as C);
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const frame = rest.id ?? ordered[0]?.frame;
  const grid = make(frame ? { ...rest, id: frame } : rest);
  for (const e of ordered) {
    grid.wrangle({ actor: "replay", ...(e.cause !== undefined ? { cause: e.cause } : {}) }, () =>
      apply(grid, e),
    );
  }
  return grid;
}

function apply(grid: Container, e: BitEvent): void {
  switch (e.type) {
    case "created":
      grid.add(e.position, { id: e.bit, color: e.color, emission: e.emission });
      break;
    case "presence":
      grid.setPresent(need(grid, e.bit), e.present);
      break;
    case "emitted":
      need(grid, e.bit).emit(e.slot, e.emission);
      break;
    case "moved":
      grid.move(need(grid, e.bit), e.to);
      break;
    case "annotated":
      need(grid, e.bit).annotate(e.key, e.value);
      break;
    case "passport":
      need(grid, e.bit).setPassport(e.passport);
      break;
    case "destroyed":
      grid.remove(need(grid, e.bit));
      break;
    case "linked":
    case "unlinked":
      break;
  }
}

function need(grid: Container, id: string) {
  const b = grid.get(id);
  if (!b) throw new Error(`replay: no bit ${id} in grid`);
  return b;
}
