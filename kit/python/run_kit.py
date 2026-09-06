"""Run the conformance kit against the Python implementation (PLAN-4.md Phase 25).

    python kit/python/run_kit.py <kit dir>

Prints one line per case and exits non-zero if any tier 1 or tier 2 case
fails. Tier 3 (render self-tests) is reported as skipped: this
implementation does not attempt it.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vpb import Canon, Grid, load_slots, open_pack, sha256_hex, verify_pack  # noqa: E402


def read(kit: str, rel: str):
    with open(os.path.join(kit, rel), encoding="utf-8") as f:
        return json.load(f)


def run_ops(grid: Grid, ops: list[dict]) -> None:
    for op in ops:
        kind = op["op"]
        if kind == "add":
            grid.add(op["position"], op["id"], op.get("color", 0xFFFFFF), op.get("emission"))
        elif kind == "emit":
            grid.emit(op["id"], op["slot"], op["emission"])
        elif kind == "emitAll":
            for s in op["slots"]:
                grid.emit(op["id"], s, op["emission"])
        elif kind == "setPresent":
            grid.set_present(op["id"], op["present"])
        elif kind == "move":
            grid.move(op["id"], op["to"])
        elif kind == "setPassport":
            grid.set_passport(op["id"], op["passport"])
        elif kind == "annotate":
            grid.annotate(op["id"], op["key"], op.get("value"))
        elif kind == "remove":
            grid.remove(op["id"])
        elif kind == "wrangle":
            context = {k: op[k] for k in ("actor", "cause") if k in op}
            grid.wrangle(context, lambda: run_ops(grid, op["ops"]))
        else:
            raise ValueError(f"unknown op {kind}")


def same(a, b) -> bool:
    return Canon.dumps(a) == Canon.dumps(b)


def main(kit: str) -> int:
    manifest = read(kit, "manifest.json")
    if manifest.get("format") != "vpb-conformance/1":
        print(f"not a conformance kit: {manifest.get('format')}")
        return 2
    slots = load_slots(kit)
    failed = 0
    passed = 0
    skipped = 0

    for name in manifest["tiers"]["1"]["cases"]:
        pack = read(kit, f"tier1/{name}/pack.json")
        expected = read(kit, f"tier1/{name}/expected.json")
        doc = None
        did_path = os.path.join(kit, "tier1", name, "did.json")
        if os.path.exists(did_path):
            doc = read(kit, f"tier1/{name}/did.json")
        grid = open_pack(pack, slots)
        problems = []
        if grid.state_digest() != expected["stateDigest"]:
            problems.append("state digest differs")
        if not same(grid.state(), expected["state"]):
            problems.append("state differs")
        if len(grid.bits) != expected["bits"]:
            problems.append(f"bit count {len(grid.bits)} != {expected['bits']}")
        if sum(1 for b in grid.bits.values() if b.present) != expected["present"]:
            problems.append("present count differs")
        v = verify_pack(pack, doc)
        if v["ok"] != expected["seal"]["ok"] or not same(v["mismatches"], expected["seal"]["mismatches"]):
            problems.append(f"seal verdict differs: {v['ok']} {v['mismatches']}")
        if v["signature"] != expected["signature"]["state"]:
            problems.append(f"signature verdict {v['signature']} != {expected['signature']['state']}")
        status = "FAIL" if problems else "pass"
        print(f"tier 1  {name:24} {status}  digest {grid.state_digest()[:16]}...  seal {v['signature']}{'  ' + '; '.join(problems) if problems else ''}")
        if problems:
            failed += 1
        else:
            passed += 1

    for name in manifest["tiers"]["2"]["cases"]:
        case = read(kit, f"tier2/{name}.json")
        n = [0]

        def clock(c=case["clock"]):
            t = c["start"] + c["step"] * n[0]
            n[0] += 1
            return t

        grid = Grid(case["scene"], slots, clock)
        run_ops(grid, case["ops"])
        problems = []
        if not same(grid.events, case["expected"]["events"]):
            first = next((i for i, (a, b) in enumerate(zip(grid.events, case["expected"]["events"])) if Canon.dumps(a) != Canon.dumps(b)), None)
            problems.append(f"events differ at index {first} ({len(grid.events)} vs {len(case['expected']['events'])})")
        if not same(grid.state(), case["expected"]["state"]):
            problems.append("state differs")
        if grid.state_digest() != case["expected"]["stateDigest"]:
            problems.append("state digest differs")
        if not same(grid.link_counts(), case["expected"]["linkCounts"]):
            problems.append("link counts differ")
        status = "FAIL" if problems else "pass"
        print(f"tier 2  {name:24} {status}  {len(grid.events)} events, digest {grid.state_digest()[:16]}...{'  ' + '; '.join(problems) if problems else ''}")
        if problems:
            failed += 1
        else:
            passed += 1

    for name in manifest["tiers"]["3"]["cases"]:
        print(f"tier 3  {name:24} skipped  render self-tests are not implemented in Python")
        skipped += 1

    print(f"{passed} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "conformance"))
