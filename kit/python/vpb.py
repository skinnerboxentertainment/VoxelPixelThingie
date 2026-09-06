"""VoxelPixelBit, tiers 1 and 2, in Python (PLAN-4.md Phase 25, ADR 0018).

Standard library only. A second implementation of the model's state:
packed scenes, ledger replay, the canonical state and its digest, seal
hashes, Ed25519 signature verification, and the container operations
with links derived from geometry. The render self-tests (tier 3) are not
implemented here.

The canonical text must match the reference byte for byte: JSON with no
spaces, keys in insertion order, floats that are whole numbers printed as
integers (JavaScript prints 1.0 as 1), non-ASCII left as it is.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from typing import Any

from ed25519 import verify as ed25519_verify

NODE_COUNT = 26


class Canon:
    """JSON the way JSON.stringify writes it."""

    @staticmethod
    def dumps(value: Any) -> str:
        return json.dumps(Canon._norm(value), separators=(",", ":"), ensure_ascii=False)

    @staticmethod
    def _norm(v: Any) -> Any:
        if isinstance(v, float):
            if math.isfinite(v) and v == int(v) and abs(v) < 1e21:
                return int(v)
            return v
        if isinstance(v, list):
            return [Canon._norm(x) for x in v]
        if isinstance(v, dict):
            return {k: Canon._norm(x) for k, x in v.items()}
        return v


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- slots

class Slots:
    """The slot tables read from slots.json: partner slot per neighbor offset."""

    def __init__(self, table: dict[str, Any]):
        assert table["nodeCount"] == NODE_COUNT
        self.offsets: list[tuple[tuple[int, int, int], list[int]]] = [
            (tuple(o["offset"]), o["partners"]) for o in table["offsets"]
        ]


# ---------------------------------------------------------------- container

class Bit:
    def __init__(self, id: str, position: list[int], color: int, emission: dict | None):
        self.id = id
        self.position = list(position)
        self.present = True
        self.color = color
        self.passport: dict = {}
        self.emissions: list[dict] = [dict(emission) if emission else {} for _ in range(NODE_COUNT)]


class Grid:
    """FlatGrid's semantics: cells by position, ids, derived links, events stamped in order."""

    def __init__(self, scene: str, slots: Slots, clock=None):
        self.id = scene
        self.slots = slots
        self.bits: dict[str, Bit] = {}
        self.cells: dict[tuple[int, int, int], str] = {}
        self.order: list[str] = []
        self.seq = 0
        self.clock = clock or (lambda: 0)
        self.events: list[dict] = []
        self.wrangler: dict = {}

    # -- events
    def _stamp(self, bit: str, body: dict) -> None:
        self.seq += 1
        ev = dict(body)
        ev["bit"] = bit
        ev["seq"] = self.seq
        ev["time"] = self.clock()
        ev["frame"] = self.id
        if "actor" in self.wrangler:
            ev["actor"] = self.wrangler["actor"]
        if "cause" in self.wrangler:
            ev["cause"] = self.wrangler["cause"]
        self.events.append(ev)

    def wrangle(self, context: dict, fn) -> None:
        previous = self.wrangler
        self.wrangler = dict(context)
        try:
            fn()
        finally:
            self.wrangler = previous

    # -- operations (report, then apply)
    def add(self, position, id: str, color: int = 0xFFFFFF, emission: dict | None = None) -> Bit:
        key = tuple(position)
        if key in self.cells:
            raise ValueError(f"cell {key} is occupied")
        if id in self.bits:
            raise ValueError(f"id {id} is already in this grid")
        body = {"type": "created", "position": list(position), "color": color}
        if emission is not None:
            body["emission"] = dict(emission)
        self._stamp(id, body)
        bit = Bit(id, position, color, emission)
        self.bits[id] = bit
        self.cells[key] = id
        self.order.append(id)
        return bit

    def emit(self, id: str, slot: int, emission: dict) -> None:
        if slot < 0 or slot >= NODE_COUNT:
            raise ValueError(f"slot out of range: {slot}")
        self._stamp(id, {"type": "emitted", "slot": slot, "emission": dict(emission)})
        self.bits[id].emissions[slot] = dict(emission)

    def set_present(self, id: str, present: bool) -> None:
        bit = self.bits[id]
        if bit.present == present:
            return
        self._stamp(id, {"type": "presence", "present": present})
        bit.present = present

    def move(self, id: str, to) -> None:
        bit = self.bits[id]
        src = tuple(bit.position)
        dst = tuple(to)
        if src == dst:
            return
        if dst in self.cells:
            raise ValueError(f"cell {dst} is occupied")
        self._stamp(id, {"type": "moved", "from": list(src), "to": list(dst)})
        del self.cells[src]
        bit.position = list(dst)
        self.cells[dst] = id

    def set_passport(self, id: str, passport: dict) -> None:
        self._stamp(id, {"type": "passport", "passport": passport})
        self.bits[id].passport = passport

    def annotate(self, id: str, key: str, value: Any) -> None:
        self._stamp(id, {"type": "annotated", "key": key, "value": value})

    def remove(self, id: str) -> bool:
        bit = self.bits.get(id)
        if bit is None:
            return False
        self._stamp(id, {"type": "destroyed"})
        del self.cells[tuple(bit.position)]
        del self.bits[id]
        self.order.remove(id)
        return True

    # -- state
    def links_of(self, bit: Bit) -> list[list[str]]:
        links: list[list[str]] = [[] for _ in range(NODE_COUNT)]
        if not bit.present:
            return links
        x, y, z = bit.position
        for (dx, dy, dz), partners in self.slots.offsets:
            j = self.cells.get((x + dx, y + dy, z + dz))
            if j is None or not self.bits[j].present:
                continue
            for s in range(NODE_COUNT):
                if partners[s] >= 0:
                    links[s].append(f"{j}:{partners[s]}")
        for l in links:
            l.sort()
        return links

    def record(self, bit: Bit) -> dict:
        return {
            "id": bit.id,
            "position": list(bit.position),
            "present": bit.present,
            "color": bit.color,
            "passport": bit.passport,
            "emissions": [dict(e) for e in bit.emissions],
            "links": self.links_of(bit),
        }

    def state(self) -> dict:
        bits = sorted(self.bits.values(), key=lambda b: b.id)
        return {"scene": self.id, "bits": [self.record(b) for b in bits]}

    def state_digest(self) -> str:
        return sha256_hex(Canon.dumps(self.state()))

    def link_counts(self) -> dict[str, list[int]]:
        return {b.id: [len(l) for l in self.links_of(b)] for b in sorted(self.bits.values(), key=lambda b: b.id)}


# ---------------------------------------------------------------- replay

def replay(events: list[dict], slots: Slots, scene: str | None = None) -> Grid:
    """Fold a ledger into a fresh grid; link events are derived and skipped."""
    # A line that is not an event (no type or seq) is ignored, as the reference's replay ignores it.
    ordered = sorted((e for e in events if "seq" in e and "type" in e), key=lambda e: e["seq"])
    frame = scene or (ordered[0]["frame"] if ordered else "")
    grid = Grid(frame, slots)
    for e in ordered:
        t = e["type"]
        if t == "created":
            grid.add(e["position"], e["bit"], e["color"], e.get("emission"))
        elif t == "presence":
            grid.set_present(e["bit"], e["present"])
        elif t == "emitted":
            grid.emit(e["bit"], e["slot"], e["emission"])
        elif t == "moved":
            grid.move(e["bit"], e["to"])
        elif t == "annotated":
            grid.annotate(e["bit"], e["key"], e.get("value"))
        elif t == "passport":
            grid.set_passport(e["bit"], e["passport"])
        elif t == "destroyed":
            grid.remove(e["bit"])
        else:
            pass  # linked and unlinked are derived; anything else is not the model's
    return grid


# ---------------------------------------------------------------- packs and seals

def parse_ledger(text: str | None) -> list[dict]:
    if not text:
        return []
    return [json.loads(line) for line in text.split("\n") if line]


def open_pack(pack: dict, slots: Slots) -> Grid:
    assert pack["format"] == "vpb-scene-pack/1", pack.get("format")
    events: list[dict] = []
    for bit in pack["bits"].values():
        events.extend(parse_ledger(bit.get("events")))
    return replay(events, slots, pack["manifest"]["scene"])


def seal_text(scene: str, ids: list[str], hashes: dict) -> str:
    return Canon.dumps({"scene": scene, "ids": sorted(ids), "hashes": {k: hashes[k] for k in sorted(hashes)}})


def b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def verify_pack(pack: dict, did_document: dict | None = None) -> dict:
    """The seal's hashes and, with a DID document, its signature: verified, forged, unresolved, unsigned."""
    manifest = pack["manifest"]
    hashes = manifest.get("hashes")
    if not hashes:
        return {"ok": False, "mismatches": [], "signature": "unsigned", "reason": "scene is not sealed"}
    mismatches = []
    for id in sorted(hashes):
        bit = pack["bits"].get(id, {})
        expected = hashes[id]
        if sha256_hex(bit.get("passport") or "") != expected["passport"]:
            mismatches.append({"id": id, "file": "passport"})
        if sha256_hex(bit.get("events") or "") != expected["events"]:
            mismatches.append({"id": id, "file": "events"})
    mismatches.sort(key=lambda m: m["id"] + m["file"])
    signature = "unsigned"
    sig = manifest.get("signature")
    if sig:
        signature = "unresolved"
        if did_document is not None:
            text = seal_text(manifest["scene"], manifest.get("ids") or list(hashes), hashes)
            good = False
            by_id = {m["id"]: m["publicKeyJwk"] for m in did_document["verificationMethod"]}
            for vm in did_document["assertionMethod"]:
                jwk = by_id.get(vm)
                if not jwk:
                    continue
                try:
                    public = b64url_decode(jwk["x"])
                    value = b64url_decode(sig["value"])
                except Exception:
                    continue
                if ed25519_verify(public, text.encode("utf-8"), value):
                    good = True
            signature = "verified" if good else "forged"
    ok = not mismatches and signature != "forged"
    out = {"ok": ok, "mismatches": mismatches, "signature": signature}
    if sig:
        out["did"] = sig["did"]
    return out


def load_slots(kit_dir: str) -> Slots:
    with open(os.path.join(kit_dir, "slots.json"), encoding="utf-8") as f:
        return Slots(json.load(f))
