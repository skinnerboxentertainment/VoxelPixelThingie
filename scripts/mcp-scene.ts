/**
 * The scene as an MCP server (PLAN-3.md Phase 14). Any agent runtime that
 * speaks the Model Context Protocol attaches to a scene through this and
 * gets tools to read and change bits and ask them for work, and resources
 * that carry the documents an agent needs to orient: SPEC sections, ADRs,
 * the named oracles, the manifest. Every change goes through the model's
 * own API under a wrangler context whose actor is the client's name, so
 * the ledger records an agent the way it records a person.
 *
 * This module builds the server over any container; scripts/mcp-server.ts
 * serves it over stdio.
 */
import { promises as fs } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InProcessPool, WORKLOADS } from "../src/actor.ts";
import type { BitHandle, Container } from "../src/container.ts";
import type { BitEvent, RecordingSink } from "../src/events.ts";
import { type JobAudit, jobsOf } from "../src/jobs.ts";
import type { JsonObject } from "../src/json.ts";
import { isAgent, type Policy, policyOf } from "../src/policy.ts";
import { ledgerPath, parseLedger, readManifest } from "../src/scene.ts";
import { MemoryStorage, type Storage } from "../src/storage.ts";
import type { FileStore } from "../src/store.ts";
import { uuidv7 } from "../src/uuid.ts";

export interface SceneServerOptions {
  grid: Container;
  /** New events land here; history reads from it and, when given, from the store's ledgers. */
  recorder: RecordingSink;
  store?: FileStore;
  storage?: Storage;
  /** Repository root for the docs resources. Default: the working directory. */
  root?: string;
  name?: string;
  version?: string;
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: (typeof value === "object" && value !== null ? value : { value }) as Record<string, unknown>,
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createSceneServer(opts: SceneServerOptions): McpServer {
  const { grid, recorder } = opts;
  const root = opts.root ?? process.cwd();
  const storage = opts.storage ?? new MemoryStorage();
  const server = new McpServer({ name: opts.name ?? "vpb-scene", version: opts.version ?? "0.4.0" });
  const actorName = () => `mcp:${server.server.getClientVersion()?.name ?? "client"}`;
  const wrangle = <T>(cause: string, fn: () => T): T => grid.wrangle({ actor: actorName(), cause }, fn);
  const bitOr = (id: string): BitHandle | undefined => grid.get(id);
  const summary = (b: BitHandle) => {
    const r = b.record();
    return { id: r.id, position: r.position, present: r.present, color: r.color, passport: r.passport, emissions: r.emissions };
  };
  const history = async (id: string): Promise<BitEvent[]> => {
    const stored = opts.store ? parseLedger(await opts.store.read(ledgerPath(id))) : [];
    const fresh = recorder.events.filter((e) => e.bit === id);
    const seen = new Set(stored.map((e) => e.seq));
    return [...stored, ...fresh.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
  };
  const pool = () =>
    new InProcessPool(grid, {
      storage,
      name: actorName(),
      history: () => recorder.events,
      workloads: WORKLOADS,
    });

  // ---------------------------------------------------------------- tools

  server.registerTool(
    "list_bits",
    {
      title: "List bits",
      description: "Ids and positions of bits in the scene, present ones by default.",
      inputSchema: { present: z.boolean().optional(), limit: z.number().int().positive().max(100000).optional() },
    },
    async ({ present, limit }) => {
      const all = [...grid.bits()].filter((b) => (present ?? true ? b.present : true));
      const out = all.slice(0, limit ?? 100).map((b) => ({ id: b.id, position: b.position, present: b.present }));
      return text({ scene: grid.id, total: all.length, bits: out });
    },
  );

  server.registerTool(
    "get_bit",
    { title: "Get a bit", description: "A bit's record: position, presence, color, passport, 26 emissions.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const b = bitOr(id);
      return b ? text(summary(b)) : fail(`no bit ${id}`);
    },
  );

  server.registerTool(
    "get_history",
    {
      title: "Get a bit's history",
      description: "The bit's events in sequence order, from the scene's ledger and this session.",
      inputSchema: { id: z.string(), limit: z.number().int().positive().optional() },
    },
    async ({ id, limit }) => {
      const events = await history(id);
      const tail = limit ? events.slice(-limit) : events;
      return text({ id, total: events.length, events: tail });
    },
  );

  server.registerTool(
    "emit",
    {
      title: "Emit on a node",
      description: "Set what one of the bit's 26 nodes emits: color (0xRRGGBB), light (0..1), data (any JSON).",
      inputSchema: {
        id: z.string(),
        slot: z.number().int().min(0).max(25),
        color: z.number().int().min(0).max(0xffffff).optional(),
        light: z.number().optional(),
        data: z.unknown().optional(),
        cause: z.string().optional(),
      },
    },
    async ({ id, slot, color, light, data, cause }) => {
      const b = bitOr(id);
      if (!b) return fail(`no bit ${id}`);
      try {
        wrangle(cause ?? `emit on slot ${slot}`, () =>
          b.emit(slot, { ...(color !== undefined ? { color } : {}), ...(light !== undefined ? { light } : {}), ...(data !== undefined ? { data } : {}) }),
        );
      } catch (err) {
        return fail((err as Error).message);
      }
      return text({ id, slot, emission: b.emissionOf(slot) });
    },
  );

  server.registerTool(
    "set_passport",
    { title: "Set a bit's passport", description: "Replace the bit's passport, a JSON object, whole.", inputSchema: { id: z.string(), passport: z.record(z.unknown()), cause: z.string().optional() } },
    async ({ id, passport, cause }) => {
      const b = bitOr(id);
      if (!b) return fail(`no bit ${id}`);
      try {
        wrangle(cause ?? "set passport", () => b.setPassport(passport as JsonObject));
      } catch (err) {
        return fail((err as Error).message);
      }
      return text({ id, passport: b.passport });
    },
  );

  server.registerTool(
    "remove_bit",
    { title: "Remove a bit", description: "Carve the bit out: it becomes absent and its neighbors re-expose.", inputSchema: { id: z.string(), cause: z.string().optional() } },
    async ({ id, cause }) => {
      const b = bitOr(id);
      if (!b) return fail(`no bit ${id}`);
      try {
        wrangle(cause ?? "remove bit", () => grid.setPresent(b, false));
      } catch (err) {
        return fail((err as Error).message);
      }
      return text({ id, present: b.present });
    },
  );

  server.registerTool(
    "get_policy",
    {
      title: "Get a bit's policy",
      description: "The policy under the passport's reserved `policy` key (SPEC.md §9.8): who may change the bit, what work it accepts, whether agents may act. Null when the bit carries none.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const b = bitOr(id);
      if (!b) return fail(`no bit ${id}`);
      let policy: Policy | null;
      try {
        policy = policyOf(b.passport) ?? null;
      } catch (err) {
        return fail((err as Error).message);
      }
      return text({ id, policy, agent: actorName(), agentIsAgent: isAgent(actorName()) });
    },
  );

  server.registerTool(
    "request_job",
    {
      title: "Ask a bit for work",
      description: `Run a workload on the bit through the actor contract; request, result, audit, and reward land in its ledger. Kinds: ${Object.keys(WORKLOADS).join(", ")}.`,
      inputSchema: { id: z.string(), kind: z.string(), params: z.record(z.unknown()).optional() },
    },
    async ({ id, kind, params }) => {
      if (!bitOr(id)) return fail(`no bit ${id}`);
      const jobId = uuidv7();
      let audit: JobAudit;
      try {
        audit = await pool().actor(id).run({ id: jobId, kind, ...(params ? { params: params as JsonObject } : {}) });
      } catch (err) {
        return fail((err as Error).message);
      }
      const job = jobsOf(recorder.events.filter((e) => e.bit === id)).find((j) => j.id === jobId);
      return text({ id, job: jobId, audit, result: job?.result, reward: job?.reward ?? null });
    },
  );

  server.registerTool(
    "get_audit",
    { title: "Get a job's records", description: "Request, result, audit, and reward for one job of a bit.", inputSchema: { id: z.string(), jobId: z.string() } },
    async ({ id, jobId }) => {
      const job = jobsOf(await history(id)).find((j) => j.id === jobId);
      return job ? text(job) : fail(`no job ${jobId} on bit ${id}`);
    },
  );

  // ---------------------------------------------------------------- resources

  const read = (rel: string) => fs.readFile(`${root}/${rel}`, "utf8");
  const sections = async () => {
    const spec = await read("SPEC.md");
    const out: { id: string; title: string; body: string }[] = [];
    const parts = spec.split(/^(?=##+ )/m);
    for (const part of parts) {
      const m = /^(#{2,3}) ([\d.]+)\.?\s*(.*)$/m.exec(part);
      if (!m) continue;
      out.push({ id: m[2]!.replace(/\.$/, ""), title: m[3]!.trim(), body: part });
    }
    return out;
  };

  server.registerResource(
    "manifest",
    "scene://manifest",
    { title: "Scene manifest", description: "The scene's manifest, or the live container's summary when there is no store.", mimeType: "application/json" },
    async (uri) => {
      const manifest = opts.store ? await readManifest(opts.store) : undefined;
      const body = manifest ?? { scene: grid.id, bits: grid.size, seq: grid.eventCount, live: true };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    "spec",
    new ResourceTemplate("spec://{section}", {
      list: async () => ({
        resources: (await sections()).map((s) => ({ uri: `spec://${s.id}`, name: `SPEC.md §${s.id} ${s.title}`, mimeType: "text/markdown" })),
      }),
    }),
    { title: "SPEC.md sections", description: "The model specification, one section per resource; source SPEC.md." },
    async (uri, { section }) => {
      const s = (await sections()).find((x) => x.id === String(section));
      if (!s) throw new Error(`no SPEC section ${String(section)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `<!-- source: SPEC.md §${s.id} -->\n${s.body}` }] };
    },
  );

  const adrs = async () => (await fs.readdir(`${root}/docs/adr`)).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
  server.registerResource(
    "adr",
    new ResourceTemplate("adr://{number}", {
      list: async () => ({
        resources: (await adrs()).map((f) => ({ uri: `adr://${f.slice(0, 4)}`, name: `ADR ${f.slice(0, 4)}: ${f.slice(5, -3).replace(/-/g, " ")}`, mimeType: "text/markdown" })),
      }),
    }),
    { title: "Architecture decision records", description: "Why the decisions were made; source docs/adr/." },
    async (uri, { number }) => {
      const f = (await adrs()).find((x) => x.startsWith(String(number).padStart(4, "0")));
      if (!f) throw new Error(`no ADR ${String(number)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `<!-- source: docs/adr/${f} -->\n${await read(`docs/adr/${f}`)}` }] };
    },
  );

  server.registerResource(
    "oracles",
    "oracles://all",
    { title: "Named oracles", description: "Every named test in the unit and end-to-end suites, one line each; source tests/.", mimeType: "text/plain" },
    async (uri) => {
      const lines: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(`${root}/${dir}`, { withFileTypes: true })) {
          const rel = `${dir}/${entry.name}`;
          if (entry.isDirectory()) await walk(rel);
          else if (/\.(test|spec)\.ts$/.test(entry.name)) {
            const src = await read(rel);
            for (const m of src.matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)) lines.push(`${rel}: ${m[1]}`);
          }
        }
      };
      await walk("tests");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `${lines.join("\n")}\n` }] };
    },
  );

  return server;
}
