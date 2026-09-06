/**
 * Compaction (SPEC.md §10.7): a passport is a snapshot at its seq, so events
 * at or below it are derivable and may be dropped, keeping a tail of recent
 * events per bit. Link events are derivable within a scene and go first.
 * The manifest records that the ledger is no longer complete. A sink
 * operation, run on demand, never inside evaluate.
 */
import type { BitEvent } from "./events.ts";
import {
  ledgerPath,
  mapLimit,
  type PassportFile,
  parseLedger,
  passportPath,
  readManifest,
} from "./scene.ts";
import { isSenseKey } from "./senses.ts";
import type { FileStore } from "./store.ts";

export interface CompactOptions {
  /** Events kept per bit beyond what the passport covers. Default 64. */
  tail?: number;
  /** Also drop link events inside the tail. Default true. */
  dropLinks?: boolean;
  now?: () => number;
}

export interface CompactReport {
  bits: number;
  before: number;
  after: number;
  dropped: number;
}

const isLink = (e: BitEvent) => e.type === "linked" || e.type === "unlinked";

/** Decide what a bit's ledger keeps. Pure; exported for tests. */
export function compactLedger(
  events: BitEvent[],
  passport: PassportFile | undefined,
  opts: { tail: number; dropLinks: boolean },
): BitEvent[] {
  let kept = opts.dropLinks ? events.filter((e) => !isLink(e)) : events.slice();
  if (!passport) return kept; // no snapshot: nothing is derivable
  const covered = kept.filter((e) => e.seq <= passport.seq);
  const beyond = kept.filter((e) => e.seq > passport.seq);
  // Keep the last `tail` of the covered events so recent history reads without the passport.
  kept = [...covered.slice(Math.max(0, covered.length - opts.tail)), ...beyond];
  // A bit keeps its last reading per quantity (SPEC.md §9.9): senses are state the passport does not hold.
  const lastReading = new Map<string, BitEvent>();
  for (const e of events)
    if (e.type === "annotated" && isSenseKey(e.key)) lastReading.set(e.key, e);
  const have = new Set(kept.map((e) => e.seq));
  for (const e of lastReading.values()) if (!have.has(e.seq)) kept.push(e);
  kept.sort((a, b) => a.seq - b.seq);
  return kept;
}

export async function compact(store: FileStore, opts: CompactOptions = {}): Promise<CompactReport> {
  const tail = opts.tail ?? 64;
  const dropLinks = opts.dropLinks ?? true;
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  let before = 0;
  let after = 0;
  await mapLimit(ids, 64, async (id) => {
    const [l, p] = await Promise.all([store.read(ledgerPath(id)), store.read(passportPath(id))]);
    const events = parseLedger(l);
    const passport = p ? (JSON.parse(p) as PassportFile) : undefined;
    const kept = compactLedger(events, passport, { tail, dropLinks });
    before += events.length;
    after += kept.length;
    if (kept.length !== events.length) {
      await store.write(
        ledgerPath(id),
        kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
      );
    }
  });
  const now = opts.now ?? Date.now;
  await store.write(
    "manifest.json",
    `${JSON.stringify({ ...manifest, compacted: true, updated: now() }, null, 2)}\n`,
  );
  return { bits: ids.length, before, after, dropped: before - after };
}
