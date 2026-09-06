/**
 * The scene as words (PLAN-4.md Phase 24): deterministic lines in reading
 * order, absent bits included, passports shown; the terminal script prints
 * the same lines.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { referenceScene } from "../demo/shared/scene.ts";
import { bitLine, sceneTextLines } from "../demo/shared/text.ts";
import { SceneSink } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";

test("lines: a header, then every bit by z, y, x; absent and passported bits say so; the script prints the same", async () => {
  const folder = mkdtempSync(join(tmpdir(), "vpb-text-"));
  const store = new NodeFsStore(folder);
  const sink = new SceneSink(store);
  const grid = referenceScene(4, sink);
  grid.setPresent(grid.at(1, 0, 0)!, false);
  grid.at(0, 0, 0)!.setPassport({ name: "origin" });
  await sink.flush();
  const lines = sceneTextLines(grid);
  const total = [...grid.bits()].length;
  assert.equal(lines.length, total + 1);
  assert.equal(lines[0], `scene ${grid.id}: ${total - 1} present bits of ${total}`);
  assert.match(
    lines[1]!,
    /^bit [0-9a-f-]{36} at 0,0,0: present, color #ffffff, 26 of 26 nodes lit passport {"name":"origin"}$/,
  );
  assert.match(lines[2]!, /at 1,0,0: absent, color #ffffff/);
  assert.equal(lines[1], bitLine(grid.at(0, 0, 0)!));
  const positions = lines.slice(1).map((l) => /at (\d+),(\d+),(\d+)/.exec(l)!.slice(1).map(Number));
  for (let i = 1; i < positions.length; i++) {
    const [px, py, pz] = positions[i - 1]!;
    const [x, y, z] = positions[i]!;
    assert.ok(pz! < z! || (pz === z && (py! < y! || (py === y && px! < x!))), "reading order");
  }
  const out = execFileSync(
    "node",
    ["--experimental-strip-types", "scripts/scene-text.ts", folder, "--limit", "3"],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(/\r?\n/);
  assert.deepEqual(out.slice(0, 4), lines.slice(0, 4));
  assert.equal(out[4], `… ${total - 3} more`);
});
