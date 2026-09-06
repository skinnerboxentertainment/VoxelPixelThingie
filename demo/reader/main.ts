/**
 * The reader (PLAN-4.md Phase 17, ADR 0012): a scene, its bits, and the
 * proof, in a page that needs nothing else. A scene, the SPEC text, and
 * the container's DID document can be embedded as JSON script blocks
 * (scripts/reader-scene.ts does that); otherwise `?scene=` names a folder
 * URL, a .json pack URL, or `builtin`.
 *
 * Verification is src/verify.ts, the same code the repository runs. The
 * signature is checked by resolving the DID when the network allows and
 * against the embedded document when it does not, and the page says
 * which.
 */
import {
  type BitEvent,
  type DidDocument,
  type Emission,
  FetchStore,
  type FileStore,
  kindOf,
  ledgerPath,
  MemoryStore,
  NODE_COUNT,
  openScene,
  PackedStore,
  type PassportFile,
  packFromText,
  parseLedger,
  passportPath,
  readManifest,
  resolveDidWeb,
  type ScenePack,
  SceneSink,
  sceneDigest,
  sealScene,
  signsOf,
  type VerifyReport,
  VPB_NS,
  verifyScene,
} from "../../src/index.ts";
import { referenceScene } from "../shared/scene.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const embedded = <T>(id: string): T | undefined => {
  const el = document.getElementById(id);
  if (!el?.textContent) return undefined;
  return JSON.parse(el.textContent) as T;
};
const embeddedPackGz = document.getElementById("vpb-pack-gz")?.textContent?.trim() || undefined;
const embeddedPack = embeddedPackGz ? "gz" : embedded<unknown>("vpb-pack");

/** The gzipped, base64 pack inflated by the browser itself. */
async function inflatePack(b64: string): Promise<ScenePack> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return packFromText(await new Response(stream).text());
}
const embeddedSpec = embedded<{ text: string }>("vpb-spec");
const embeddedDid = embedded<DidDocument>("vpb-did");

const sceneInput = $<HTMLInputElement>("scene");
sceneInput.value = params.get("scene") ?? "";
$<HTMLFormElement>("open").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = new URLSearchParams();
  if (sceneInput.value.trim()) q.set("scene", sceneInput.value.trim());
  location.search = q.toString();
});

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const swatch = (n: number) =>
  `<span class="swatch" style="background:${hex(n)}" aria-hidden="true"></span><span class="mono">${hex(n)}</span>`;
const nodeName = (slot: number) => {
  const signs = signsOf(slot);
  const axes = ["x", "y", "z"];
  return `${kindOf(slot)} ${signs.map((s, i) => (s === null ? "" : `${s ? "+" : "-"}${axes[i]}`)).join("")}`;
};

function detail(e: BitEvent): string {
  switch (e.type) {
    case "created":
      return `at ${e.position.join(",")}, color ${hex(e.color)}`;
    case "presence":
      return e.present ? "present" : "absent";
    case "moved":
      return `${e.from.join(",")} to ${e.to.join(",")}`;
    case "emitted":
      return `slot ${e.slot}: ${JSON.stringify(e.emission)}`;
    case "passport":
      return JSON.stringify(e.passport).slice(0, 80);
    case "annotated":
      return `${e.key} = ${JSON.stringify(e.value)}`;
    case "linked":
      return `slot ${e.slot} to ${e.neighbor.slice(0, 8)} slot ${e.partner}`;
    case "unlinked":
      return `slot ${e.slot} from ${e.neighbor.slice(0, 8)}`;
    default:
      return "";
  }
}

type ResolvedBy = "resolved" | "embedded" | "none";

interface Opened {
  store: FileStore;
  source: string;
  sceneId: string;
  ids: string[];
  digest: string;
  passports: Map<string, PassportFile>;
}

let opened: Opened | undefined;
let report: (VerifyReport & { resolvedBy: ResolvedBy }) | undefined;
let selected: string | undefined;

const status = (text: string, cls = "") => {
  const el = $("status");
  el.textContent = text;
  el.className = cls;
};

async function builtinStore(): Promise<FileStore> {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  referenceScene(8, sink);
  await sink.flush();
  await sealScene(mem);
  return mem;
}

async function storeFor(scene: string): Promise<{ store: FileStore; source: string }> {
  if (embeddedPackGz && !scene)
    return {
      store: new PackedStore(await inflatePack(embeddedPackGz)),
      source: "embedded in this file",
    };
  if (embeddedPack && !scene)
    return { store: new PackedStore(embeddedPack as ScenePack), source: "embedded in this file" };
  if (!scene || scene === "builtin")
    return { store: await builtinStore(), source: "built in this page" };
  if (scene.endsWith(".json")) return { store: await PackedStore.fromUrl(scene), source: scene };
  return { store: new FetchStore(scene), source: scene };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function verify(): Promise<void> {
  if (!opened) return;
  const state: { resolvedBy: ResolvedBy } = { resolvedBy: "none" };
  const resolve = async (did: string): Promise<DidDocument> => {
    try {
      const doc = await withTimeout(resolveDidWeb(did), 4000);
      state.resolvedBy = "resolved";
      return doc;
    } catch (err) {
      if (embeddedDid && embeddedDid.id === did) {
        state.resolvedBy = "embedded";
        return embeddedDid;
      }
      throw err;
    }
  };
  const r = await verifyScene(opened.store, { resolve });
  const { resolvedBy } = state;
  report = { ...r, resolvedBy };
  const seal = $("s-seal");
  if (r.ok) {
    seal.innerHTML = `<span class="good">ok</span>, ${r.checked} bits checked`;
  } else {
    const first = r.mismatches[0];
    seal.innerHTML = `<span class="bad">FAILED</span>: ${esc(r.reason ?? `${r.mismatches.length} file(s) differ from the seal`)}${first ? `, first at bit <span class="mono">${esc(first.id)}</span> (${first.file})` : ""}`;
  }
  const sig = $("s-signature");
  const how =
    resolvedBy === "resolved"
      ? "by resolving the DID over the network"
      : resolvedBy === "embedded"
        ? "against the DID document embedded in this file (not resolved)"
        : "";
  switch (r.signature) {
    case "unsigned":
      sig.textContent = "unsigned: the hashes stand on their own";
      break;
    case "unresolved":
      sig.innerHTML = `<span class="muted">unresolved</span>: ${esc(r.did ?? "")} could not be fetched and no document is embedded; the hashes still stand`;
      break;
    case "verified":
      sig.innerHTML = `<span class="good">verified</span> ${how}: <span class="mono">${esc(r.did ?? "")}</span>`;
      break;
    case "forged":
      sig.innerHTML = `<span class="bad">forged</span>: the signature by <span class="mono">${esc(r.did ?? "")}</span> does not match this manifest (checked ${how})`;
      break;
  }
  status(
    r.ok && r.signature !== "forged"
      ? `verified: ${r.checked} bits, seal ok, signature ${r.signature}`
      : `verification FAILED: ${r.reason ?? `${r.mismatches.length} mismatch(es)`}${r.mismatches[0] ? ` at bit ${r.mismatches[0].id}` : ""}`,
    r.ok ? "good" : "bad",
  );
}

function renderList(filter = ""): void {
  if (!opened) return;
  const q = filter.trim().toLowerCase();
  const items: string[] = [];
  for (const id of opened.ids) {
    const p = opened.passports.get(id);
    const pos = p ? p.position.join(",") : "";
    const line = `${id} ${pos}`;
    if (q && !line.toLowerCase().includes(q)) continue;
    const absent = p ? !p.present : false;
    items.push(
      `<li><button type="button" data-id="${esc(id)}" class="${absent ? "absent" : ""}" aria-current="${id === selected ? "true" : "false"}">${esc(id)} <span class="muted">${esc(pos)}${absent ? " absent" : ""}</span></button></li>`,
    );
  }
  $("bits").innerHTML = items.join("");
}

async function show(id: string): Promise<void> {
  if (!opened) return;
  const p = opened.passports.get(id);
  if (!p) return;
  selected = id;
  for (const b of $("bits").querySelectorAll("button"))
    b.setAttribute("aria-current", b.dataset.id === id ? "true" : "false");
  const events = parseLedger(await opened.store.read(ledgerPath(id)));
  $("f-id").textContent = p.id;
  $("f-position").textContent = p.position.join(", ");
  $("f-state").innerHTML = p.destroyed
    ? '<span class="badge absent">destroyed</span>'
    : p.present
      ? '<span class="badge present">present</span>'
      : '<span class="badge absent">absent</span>';
  $("f-color").innerHTML = swatch(p.color);
  $("f-seq").textContent = `seq ${p.seq}, ${new Date(p.time).toISOString()}`;
  $("f-epc").textContent = `${VPB_NS}bit/${p.id}`;
  $("f-passport").textContent = JSON.stringify(p.passport, null, 2);
  const rows: string[] = [];
  for (let slot = 0; slot < NODE_COUNT; slot++) {
    const e: Emission = p.emissions[slot] ?? {};
    rows.push(
      `<tr><td class="mono">${slot}</td><td>${nodeName(slot)}</td><td>${e.color === undefined ? '<span class="muted">none</span>' : swatch(e.color)}</td><td class="mono">${e.light ?? '<span class="muted">none</span>'}</td><td class="mono">${e.data === undefined ? '<span class="muted">none</span>' : esc(JSON.stringify(e.data))}</td></tr>`,
    );
  }
  $("f-emissions").querySelector("tbody")!.innerHTML = rows.join("");
  $("f-events").querySelector("tbody")!.innerHTML = events
    .map(
      (e) =>
        `<tr><td class="mono">${e.seq}</td><td>${e.type}</td><td class="mono">${new Date(e.time).toISOString()}</td><td>${esc(detail(e))}</td><td>${esc(e.actor ?? "")}</td><td>${esc(e.cause ?? "")}</td></tr>`,
    )
    .join("");
  $("bit-heading").textContent = `Bit ${id}`;
  $("bit").hidden = false;
}

async function open(): Promise<void> {
  const scene = params.get("scene") ?? "";
  status("opening");
  const { store, source } = await storeFor(scene);
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = manifest.ids ?? (await store.list("bits"));
  const passports = new Map<string, PassportFile>();
  for (const id of ids) {
    const text = await store.read(passportPath(id));
    if (text) passports.set(id, JSON.parse(text) as PassportFile);
  }
  const grid = await openScene(store);
  const digest = await sceneDigest(grid);
  opened = { store, source, sceneId: manifest.scene, ids, digest, passports };
  $("s-id").textContent = manifest.scene;
  $("s-source").textContent = source;
  $("s-bits").textContent = `${ids.length} (${grid.size} present)`;
  $("s-digest").textContent = digest;
  $("scene-section").hidden = false;
  renderList();
  if (embeddedDid) {
    $("did-doc").textContent = JSON.stringify(embeddedDid, null, 2);
    $("did-details").hidden = false;
  }
  if (embeddedSpec) {
    $("spec-text").textContent = embeddedSpec.text;
    $("spec-details").hidden = false;
  }
  await verify();
}

$("bits").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (b?.dataset.id) void show(b.dataset.id);
});
$<HTMLInputElement>("filter").addEventListener("input", (ev) =>
  renderList((ev.target as HTMLInputElement).value),
);
$("verify").addEventListener("click", () => void verify());

(window as unknown as { __vpb: unknown }).__vpb = {
  scene: () =>
    opened && {
      id: opened.sceneId,
      source: opened.source,
      bits: opened.ids.length,
      digest: opened.digest,
      embedded: { pack: !!embeddedPack, spec: !!embeddedSpec, did: !!embeddedDid },
    },
  report: () => report,
  selected: () => selected,
  show: (id: string) => show(id),
};

try {
  await open();
} catch (err) {
  status((err as Error).message, "bad");
}
document.body.setAttribute("data-ready", "1");
