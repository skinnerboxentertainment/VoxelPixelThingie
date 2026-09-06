/**
 * Serve a scene over the Model Context Protocol on stdio (PLAN-3.md
 * Phase 14; see scripts/mcp-scene.ts for the tools and resources).
 *
 *   npm run mcp                         the built-in reference scene, in memory
 *   npm run mcp -- --scene <folder>     a scene folder, opened for writing
 *
 * .mcp.json at the repository root points Claude Code and other clients
 * at this. Logs go to stderr; stdout is the protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { referenceScene } from "../demo/shared/scene.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import { openScene, SceneSink } from "../src/scene.ts";
import { FolderStorage } from "../src/storage-node.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { createSceneServer } from "./mcp-scene.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const folder = flag("scene");
const recorder = new RecordingSink();
let grid: ReturnType<typeof referenceScene> | Awaited<ReturnType<typeof openScene>>;
let store: NodeFsStore | undefined;
let sink: SceneSink | undefined;
if (folder) {
  store = new NodeFsStore(folder);
  sink = await SceneSink.resume(store);
  grid = await openScene(store, { attach: new TeeSink([sink, recorder]) /* the ledger's sink first: a refusal there never reaches the recorder */ });
} else {
  grid = referenceScene(8, recorder);
}
const server = createSceneServer({
  grid,
  recorder,
  ...(store ? { store, storage: new FolderStorage(`${folder}/results`) } : {}),
});
await server.connect(new StdioServerTransport());
process.stderr.write(`vpb-scene mcp server: ${folder ?? "built-in reference scene"}, ${grid.size} bits\n`);
const bye = async () => {
  await sink?.flush();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
