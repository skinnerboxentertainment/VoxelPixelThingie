/**
 * Containers as bodies for a scene's actors (ADR 0011). This runs on the
 * host and drives the Docker CLI: build the worker image, run the durable
 * engine's dev server as a container on a private network, start and kill
 * worker containers over a scene folder mounted as a volume. The worker
 * inside is scripts/durable-worker.ts unchanged, so the actor contract,
 * the workflow ids, and the idempotent record steps carry over, and a
 * killed container's job finishes once on the next one.
 *
 *   npm run docker:worker -- --scene <folder> [--name vpb-worker-1] [--task-queue vpb-bits]
 *   npm run docker:worker -- --down
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const NETWORK = "vpb";
export const ENGINE_CONTAINER = "vpb-temporal";
export const ENGINE_IMAGE = "temporalio/temporal:latest";
export const WORKER_IMAGE = "vpb-worker";
/** The engine's port on the host, mapped from the container. */
export const ENGINE_PORT = 7233;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureNetwork(): Promise<void> {
  const names = (await docker(["network", "ls", "--format", "{{.Name}}"])).split("\n");
  if (!names.includes(NETWORK)) await docker(["network", "create", NETWORK]);
}

/** Build the worker image from the repository root. Returns the build time in ms. */
export async function buildImage(root = process.cwd()): Promise<number> {
  const t0 = performance.now();
  await docker(["build", "-q", "-f", resolve(root, "docker/worker.Dockerfile"), "-t", WORKER_IMAGE, root]);
  return performance.now() - t0;
}

async function running(name: string): Promise<boolean> {
  const out = await docker(["ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]);
  return out.split("\n").includes(name);
}

/** The engine's dev server as a container, reachable as temporal:7233 inside the network and localhost:7233 outside. */
export async function startEngine(): Promise<{ address: string; started: boolean }> {
  await ensureNetwork();
  if (await running(ENGINE_CONTAINER)) return { address: `127.0.0.1:${ENGINE_PORT}`, started: false };
  await docker(["rm", "-f", ENGINE_CONTAINER]).catch(() => "");
  await docker([
    "run",
    "-d",
    "--name",
    ENGINE_CONTAINER,
    "--network",
    NETWORK,
    "--network-alias",
    "temporal",
    "-p",
    `${ENGINE_PORT}:7233`,
    ENGINE_IMAGE,
    "server",
    "start-dev",
    "--ip",
    "0.0.0.0",
    "--db-filename",
    "/tmp/vpb.db",
  ]);
  return { address: `127.0.0.1:${ENGINE_PORT}`, started: true };
}

export interface WorkerContainer {
  name: string;
  id: string;
}

/** A worker container over a scene folder. Resolves once the worker says it is ready. */
export async function startWorker(opts: {
  scene: string;
  name?: string;
  taskQueue?: string;
  readyTimeoutMs?: number;
}): Promise<WorkerContainer> {
  await ensureNetwork();
  const name = opts.name ?? `vpb-worker-${Date.now().toString(36)}`;
  await docker(["rm", "-f", name]).catch(() => "");
  const id = await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    NETWORK,
    "-v",
    `${resolve(opts.scene)}:/scene`,
    "-e",
    "TEMPORAL_ADDRESS=temporal:7233",
    "-e",
    `VPB_TASK_QUEUE=${opts.taskQueue ?? "vpb-bits"}`,
    WORKER_IMAGE,
  ]);
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const logs = await docker(["logs", name]).catch(() => "");
    if (logs.includes("worker ready")) return { name, id };
    if (!(await running(name))) throw new Error(`worker ${name} exited: ${logs.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker ${name} did not become ready`);
}

/** SIGKILL the container: the process dies mid-step, exactly like a crashed host. */
export async function killWorker(name: string): Promise<void> {
  await docker(["kill", "-s", "KILL", name]).catch(() => "");
  await docker(["rm", "-f", name]).catch(() => "");
}

export async function stopWorker(name: string): Promise<void> {
  await docker(["stop", "-t", "5", name]).catch(() => "");
  await docker(["rm", "-f", name]).catch(() => "");
}

export async function stopEngine(): Promise<void> {
  await docker(["rm", "-f", ENGINE_CONTAINER]).catch(() => "");
}

export async function workerLogs(name: string): Promise<string> {
  return docker(["logs", name]).catch(() => "");
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && /docker-host\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? undefined : args[i + 1];
  };
  if (args.includes("--down")) {
    const names = (await docker(["ps", "-a", "--filter", "name=^vpb-worker", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
    for (const n of names) await stopWorker(n);
    await stopEngine();
    console.log(`stopped ${names.length} worker(s) and the engine`);
  } else {
    const scene = flag("scene");
    if (!scene) {
      console.error("usage: docker-host --scene <folder> [--name n] [--task-queue q] | --down");
      process.exit(2);
    }
    if (!(await dockerAvailable())) {
      console.error("docker is not available");
      process.exit(1);
    }
    const built = await buildImage();
    const engine = await startEngine();
    const worker = await startWorker({ scene, ...(flag("name") ? { name: flag("name")! } : {}), ...(flag("task-queue") ? { taskQueue: flag("task-queue")! } : {}) });
    console.log(`image built in ${(built / 1000).toFixed(1)} s; engine at ${engine.address}${engine.started ? " (started)" : " (already up)"}; worker ${worker.name} ready over ${scene}`);
  }
}
