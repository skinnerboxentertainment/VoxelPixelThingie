/**
 * The passport page (PLAN-2.md Phase 10, ADR 0009): one bit, read from a
 * published scene by id, with a QR code of this page's own address so a
 * physical bit can carry a label that opens its history.
 *
 *   ?scene=<url>&id=<bit id>
 *
 * The scene is a folder URL (read through FetchStore, listed by
 * manifest.ids), a .json pack URL, or `builtin`, which builds the reference
 * scene in the page; with builtin, id=first opens its first bit. With no
 * scene, the published reference scene on GitHub is used.
 */
import QRCode from "qrcode";
import {
  type BitEvent,
  type Emission,
  FetchStore,
  type FileStore,
  kindOf,
  ledgerPath,
  NODE_COUNT,
  PackedStore,
  type PassportFile,
  parseLedger,
  passportPath,
  RecordingSink,
  readManifest,
  signsOf,
  VPB_NS,
} from "../../src/index.ts";
import { referenceScene } from "../shared/scene.ts";

export const DEFAULT_SCENE =
  "https://raw.githubusercontent.com/skinnerboxentertainment/VoxelPixelThingie-scenes/main/scenes/reference-8/";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const sceneInput = $<HTMLInputElement>("scene");
const idInput = $<HTMLInputElement>("id");
sceneInput.value = params.get("scene") ?? "";
idInput.value = params.get("id") ?? "";

$<HTMLFormElement>("open").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = new URLSearchParams();
  if (sceneInput.value.trim()) q.set("scene", sceneInput.value.trim());
  if (idInput.value.trim()) q.set("id", idInput.value.trim());
  location.search = q.toString();
});

interface Shown {
  passport: PassportFile;
  events: BitEvent[];
  sceneId: string;
}

async function fromStore(store: FileStore, id: string): Promise<Shown> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json at that scene URL");
  let bitId = id;
  if (bitId === "first") {
    const ids = await store.list("bits");
    if (!ids[0]) throw new Error("the scene has no bits");
    bitId = ids[0];
  }
  const text = await store.read(passportPath(bitId));
  if (!text) throw new Error(`no bit ${bitId} in scene ${manifest.scene}`);
  const passport = JSON.parse(text) as PassportFile;
  const events = parseLedger(await store.read(ledgerPath(bitId)));
  return { passport, events, sceneId: manifest.scene };
}

function fromBuiltin(id: string): Shown {
  const sink = new RecordingSink();
  const grid = referenceScene(8, sink);
  const bit = id === "first" ? [...grid.bits()].find((b) => b.present) : grid.get(id);
  if (!bit) throw new Error(`no bit ${id} in the built-in scene`);
  const rec = bit.record();
  const events = sink.events.filter((e) => e.bit === bit.id);
  const last = events[events.length - 1];
  const passport: PassportFile = {
    format: "vpb-passport/1",
    id: bit.id,
    frame: grid.id,
    seq: last?.seq ?? 0,
    time: last?.time ?? Date.now(),
    present: rec.present,
    position: rec.position,
    color: rec.color,
    emissions: rec.emissions,
    passport: rec.passport,
  };
  return { passport, events, sceneId: grid.id };
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const swatch = (n: number) =>
  `<span class="swatch" style="background:${hex(n)}"></span><span class="mono">${hex(n)}</span>`;
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
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
      return `${e.from.join(",")} → ${e.to.join(",")}`;
    case "emitted":
      return `slot ${e.slot}: ${JSON.stringify(e.emission)}`;
    case "passport":
      return JSON.stringify(e.passport).slice(0, 80);
    case "annotated":
      return `${e.key} = ${JSON.stringify(e.value)}`;
    case "linked":
      return `slot ${e.slot} to ${e.neighbor.slice(0, 8)}… slot ${e.partner}`;
    case "unlinked":
      return `slot ${e.slot} from ${e.neighbor.slice(0, 8)}…`;
    default:
      return "";
  }
}

function render(shown: Shown, canonical: string): void {
  const p = shown.passport;
  $("f-id").textContent = p.id;
  $("f-frame").textContent = p.frame;
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
      `<tr><td class="mono">${slot}</td><td>${nodeName(slot)}</td><td>${e.color === undefined ? '<span class="muted">—</span>' : swatch(e.color)}</td><td class="mono">${e.light ?? '<span class="muted">—</span>'}</td><td class="mono">${e.data === undefined ? '<span class="muted">—</span>' : esc(JSON.stringify(e.data))}</td></tr>`,
    );
  }
  $("f-emissions").querySelector("tbody")!.innerHTML = rows.join("");
  $("f-events").querySelector("tbody")!.innerHTML = shown.events
    .map(
      (e) =>
        `<tr><td class="mono">${e.seq}</td><td>${e.type}</td><td class="mono">${new Date(e.time).toISOString()}</td><td>${esc(detail(e))}</td><td>${esc(e.actor ?? "")}</td><td>${esc(e.cause ?? "")}</td></tr>`,
    )
    .join("");
  $("qr-url").textContent = canonical;
  $("bit").hidden = false;
  void QRCode.toCanvas($<HTMLCanvasElement>("qr"), canonical, {
    width: 200,
    margin: 1,
    errorCorrectionLevel: "M",
  }).then(
    () => document.body.setAttribute("data-qr", "1"),
    (err: Error) => {
      $("error").textContent = `QR: ${err.message}`;
    },
  );
}

let shown: Shown | undefined;
async function main(): Promise<void> {
  const scene = params.get("scene") ?? DEFAULT_SCENE;
  const id = params.get("id");
  if (!id) {
    $("error").textContent = "";
    return;
  }
  try {
    if (scene === "builtin") shown = fromBuiltin(id);
    else if (scene.endsWith(".json")) shown = await fromStore(await PackedStore.fromUrl(scene), id);
    else shown = await fromStore(new FetchStore(scene), id);
    const q = new URLSearchParams({ id: shown.passport.id });
    if (scene !== DEFAULT_SCENE) q.set("scene", scene);
    const canonical = `${location.origin}${location.pathname}?${q}`;
    render(shown, canonical);
  } catch (err) {
    $("error").textContent = (err as Error).message;
  }
}

(window as unknown as { __vpb: unknown }).__vpb = {
  shown: () =>
    shown && {
      id: shown.passport.id,
      frame: shown.passport.frame,
      present: shown.passport.present,
      emissions: shown.passport.emissions.filter((e) => e.color !== undefined).length,
      events: shown.events.length,
      qr: document.body.getAttribute("data-qr") === "1",
    },
  error: () => $("error").textContent,
};

await main();
document.body.setAttribute("data-ready", "1");
