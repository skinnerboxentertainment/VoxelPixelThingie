import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSceneServer } from "../scripts/mcp-scene.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { JOB_KEYS } from "../src/jobs.ts";
import { SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";

async function connected() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const recorder = new RecordingSink();
  const grid = FlatGrid.fill(3, 3, 3, {
    emission: { color: 0x1f6feb, light: 0.6 },
    sink: new TeeSink([
      sink,
      recorder,
    ]) /* the ledger's sink first: a refusal there never reaches the recorder */,
  });
  for (const b of grid.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  await sink.flush();
  const server = createSceneServer({ grid, recorder, store: mem });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: { type: string; text?: string }[];
    };
    return r;
  };
  return {
    grid,
    recorder,
    server,
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("an agent lists the tools, reads a bit and its history, changes it, and the ledger names the agent", async () => {
  const t = await connected();
  try {
    const tools = (await t.client.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, [
      "emit",
      "get_audit",
      "get_bit",
      "get_history",
      "get_policy",
      "list_bits",
      "remove_bit",
      "request_job",
      "set_passport",
    ]);
    const list = await t.call("list_bits", { limit: 5 });
    const bits = list.structuredContent as { total: number; bits: { id: string }[] };
    assert.equal(bits.total, 27);
    assert.equal(bits.bits.length, 5);
    const id = bits.bits[0]!.id;
    const bit = (await t.call("get_bit", { id })).structuredContent as {
      present: boolean;
      emissions: unknown[];
    };
    assert.equal(bit.present, true);
    assert.equal(bit.emissions.length, 26);
    const before = (await t.call("get_history", { id })).structuredContent as { total: number };
    assert.ok(before.total >= 1 + 20, "created plus the edge and vertex emissions");

    const emitted = await t.call("emit", {
      id,
      slot: 0,
      color: 0xff0000,
      light: 0.5,
      cause: "paint it red",
    });
    assert.equal(emitted.isError, undefined);
    const last = t.recorder.events[t.recorder.events.length - 1]!;
    assert.equal(last.type, "emitted");
    assert.equal(last.actor, "mcp:test-agent", "the ledger names the agent");
    assert.equal(last.cause, "paint it red");
    await t.call("set_passport", { id, passport: { name: "agent's pick" } });
    assert.deepEqual(t.grid.get(id)!.passport, { name: "agent's pick" });
    const bad = await t.call("set_passport", { id, passport: { fn: "x".repeat(300 * 1024) } });
    assert.equal(bad.isError, true, "the sink's passport limit reaches the agent as an error");
    const gone = await t.call("get_bit", { id: "no-such-bit" });
    assert.equal(gone.isError, true);

    const removed = (await t.call("remove_bit", { id, cause: "carve" })).structuredContent as {
      present: boolean;
    };
    assert.equal(removed.present, false);
    assert.equal(t.grid.get(id)!.present, false);
    const presence = t.recorder.events.filter((e) => e.type === "presence" && e.bit === id).at(-1)!;
    assert.equal(presence.actor, "mcp:test-agent");
    const after = (await t.call("get_history", { id, limit: 3 })).structuredContent as {
      total: number;
      events: { type: string }[];
    };
    assert.equal(after.events.length, 3);
    assert.ok(after.total > before.total);
  } finally {
    await t.close();
  }
});

test("an agent asks a bit for work and reads the audit back", async () => {
  const t = await connected();
  try {
    const id = [...t.grid.bits()][13]!.id;
    const run = (await t.call("request_job", { id, kind: "links" })).structuredContent as {
      job: string;
      audit: { passed: boolean; check: string };
      result: { value: { checked: number; broken: number } };
      reward: unknown;
    };
    assert.equal(run.audit.passed, true, run.audit.check);
    assert.equal(run.result.value.broken, 0);
    assert.ok(run.reward);
    const again = (await t.call("get_audit", { id, jobId: run.job })).structuredContent as {
      request: { kind: string };
      audit: { passed: boolean };
    };
    assert.equal(again.request.kind, "links");
    assert.equal(again.audit.passed, true);
    const req = t.recorder.events.find(
      (e) => e.type === "annotated" && e.key === JOB_KEYS.request && e.bit === id,
    )!;
    assert.equal(req.actor, "mcp:test-agent");
    const nope = await t.call("request_job", { id, kind: "no-such-workload" });
    const audit = (nope.structuredContent as { audit: { passed: boolean } }).audit;
    assert.equal(audit.passed, false, "an unknown workload is a failed audit, not an error");
    assert.equal((await t.call("get_audit", { id, jobId: "missing" })).isError, true);
  } finally {
    await t.close();
  }
});

test("resources: the manifest, every SPEC section, every ADR, and the oracle list, each naming its source", async () => {
  const t = await connected();
  try {
    const statics = (await t.client.listResources()).resources.map((r) => r.uri).sort();
    assert.ok(statics.includes("scene://manifest"));
    assert.ok(statics.includes("oracles://all"));
    const templates = (await t.client.listResourceTemplates()).resourceTemplates
      .map((r) => r.uriTemplate)
      .sort();
    assert.deepEqual(templates, ["adr://{number}", "spec://{section}"]);
    const specs = statics.filter((u) => u.startsWith("spec://"));
    assert.ok(specs.length >= 40, `SPEC sections listed: ${specs.length}`);
    const adrs = statics.filter((u) => u.startsWith("adr://"));
    assert.ok(adrs.length >= 10, `ADRs listed: ${adrs.length}`);
    for (const uri of [...specs, ...adrs]) {
      const r = await t.client.readResource({ uri });
      const body = (r.contents[0] as { text: string }).text;
      assert.ok(body.length > 40, `${uri} is not empty`);
      assert.match(body, /^<!-- source: (SPEC\.md|docs\/adr\/)/, `${uri} names its source`);
    }
    const nine = (await t.client.readResource({ uri: "spec://9.7" })).contents[0] as {
      text: string;
    };
    assert.match(nine.text, /### 9\.7 Work/);
    const adr10 = (await t.client.readResource({ uri: "adr://0010" })).contents[0] as {
      text: string;
    };
    assert.match(adr10.text, /Work is recorded, audited, then rewarded/);
    const oracles = (await t.client.readResource({ uri: "oracles://all" })).contents[0] as {
      text: string;
    };
    const lines = oracles.text.trim().split("\n");
    assert.ok(lines.length >= 100, `oracles listed: ${lines.length}`);
    assert.ok(
      lines.some((l) => l.startsWith("tests/mcp-scene.test.ts: an agent asks a bit for work")),
    );
    const manifest = (await t.client.readResource({ uri: "scene://manifest" })).contents[0] as {
      text: string;
    };
    assert.equal(JSON.parse(manifest.text).scene, t.grid.id);
    await assert.rejects(t.client.readResource({ uri: "spec://99.9" }), /no SPEC section/);
  } finally {
    await t.close();
  }
});

test("policy over MCP: a bit that refuses agents turns the agent away with the rule, stays unchanged, and records the refusal; work outside the policy fails its audit", async () => {
  const t = await connected();
  try {
    const id = [...t.grid.bits()][5]!.id;
    const none = (await t.call("get_policy", { id })).structuredContent as {
      policy: unknown;
      agentIsAgent: boolean;
    };
    assert.equal(none.policy, null);
    assert.equal(none.agentIsAgent, true, "mcp:test-agent is an agent");
    // The agent may still set the passport (no controllers yet), and locks itself out.
    await t.call("set_passport", { id, passport: { policy: { version: 1, agents: false } } });
    const before = (await t.call("get_bit", { id })).structuredContent as { emissions: unknown[] };
    const refused = await t.call("emit", { id, slot: 0, color: 0xff0000, cause: "paint" });
    assert.equal(refused.isError, true);
    assert.match(
      refused.content[0]!.text!,
      /policy on bit .* refuses emitted by mcp:test-agent: agents: false/,
    );
    const after = (await t.call("get_bit", { id })).structuredContent as { emissions: unknown[] };
    assert.deepEqual(after.emissions, before.emissions, "the bit is unchanged");
    const history = (await t.call("get_history", { id, limit: 1 })).structuredContent as {
      events: {
        type: string;
        key?: string;
        actor?: string;
        value?: { actor?: string; rule?: string };
      }[];
    };
    const last = history.events[0]!;
    assert.equal(last.key, "policy:refused");
    assert.equal(last.actor, "policy");
    assert.equal(last.value?.actor, "mcp:test-agent");
    assert.equal(last.value?.rule, "agents: false");
    assert.ok(
      !t.recorder.events.some(
        (e) =>
          e.type === "emitted" &&
          e.bit === id &&
          e.seq === (last as unknown as { seq: number }).seq,
      ),
      "the recorder never saw the refused event",
    );
    // The agent can no longer replace the policy either: agents: false covers passport events.
    const locked = await t.call("set_passport", { id, passport: {} });
    assert.equal(locked.isError, true);
    assert.equal(
      ((await t.call("get_policy", { id })).structuredContent as { policy: { agents: boolean } })
        .policy.agents,
      false,
    );

    // Work: another bit accepts links only.
    const id2 = [...t.grid.bits()][6]!.id;
    await t.call("set_passport", {
      id: id2,
      passport: { policy: { version: 1, work: ["links"] } },
    });
    const denied = (await t.call("request_job", { id: id2, kind: "epcis" })).structuredContent as {
      audit: { passed: boolean; check: string; detail?: string };
      result: unknown;
    };
    assert.equal(denied.audit.passed, false);
    assert.equal(denied.audit.check, "policy allows the work");
    assert.match(denied.audit.detail!, /work does not include epcis/);
    assert.equal(denied.result, undefined);
    const ok = (await t.call("request_job", { id: id2, kind: "links" })).structuredContent as {
      audit: { passed: boolean };
    };
    assert.equal(ok.audit.passed, true);
  } finally {
    await t.close();
  }
});
