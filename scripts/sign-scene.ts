/**
 * Re-seal a scene with the container's signature and write its DID
 * document (PLAN-3.md Phase 11).
 *
 *   npm run scene:sign -- <folder> --key <private.jwk> --host <host> --path <path>
 *        [--manifest-url <url>] [--passport-url <url>] [--epcis-url <url>]
 *        [--witness notary:<jwk> | rfc3161:<url>]...
 *
 * The DID is did:web:<host>:<path>:frame:<container id>; the document is
 * written to <folder>/did.json and, unless --no-doc, printed with the URL
 * it must be served from for the DID to resolve. Packs are made from the
 * folder afterwards with scene:pack, so the signature travels with them.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildDidDocument, didWebUrl, frameDid } from "../src/did.ts";
import { type PrivateKeyJwk, publicOf } from "../src/keys.ts";
import { readManifest } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";
import { sealScene, verifyScene } from "../src/verify.ts";
import { NotaryWitness, Rfc3161Witness, type Witness } from "../src/witness.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const folder = args[0];
const keyFile = flag("key");
const host = flag("host");
const path = flag("path") ?? "";
if (!folder || folder.startsWith("--") || !keyFile || !host) {
  console.error("usage: sign-scene <folder> --key <private.jwk> --host <host> [--path <path>] [--manifest-url u] [--passport-url u] [--epcis-url u]");
  process.exit(2);
}

const privateKey = JSON.parse(await fs.readFile(keyFile, "utf8")) as PrivateKeyJwk;
if (privateKey.kty !== "OKP" || privateKey.crv !== "Ed25519" || !privateKey.d) {
  console.error("the key file is not an Ed25519 private JWK");
  process.exit(1);
}
const store = new NodeFsStore(folder);
const manifest = await readManifest(store);
if (!manifest) {
  console.error("not a scene");
  process.exit(1);
}
const did = frameDid(host, path, manifest.scene);
const witnesses: Witness[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--witness") continue;
  const spec = args[i + 1] ?? "";
  if (spec.startsWith("notary:")) {
    const notary = JSON.parse(await fs.readFile(spec.slice(7), "utf8")) as PrivateKeyJwk;
    witnesses.push(new NotaryWitness(notary));
  } else if (spec.startsWith("rfc3161:")) {
    witnesses.push(new Rfc3161Witness(spec.slice(8)));
  } else {
    console.error(`--witness takes notary:<jwk> or rfc3161:<url>, not ${spec}`);
    process.exit(2);
  }
}
const sealed = await sealScene(store, { did, privateKey }, { witnesses });
const doc = await buildDidDocument(did, publicOf(privateKey), {
  services: {
    ...(flag("manifest-url") ? { manifest: flag("manifest-url")! } : {}),
    ...(flag("passport-url") ? { passport: flag("passport-url")! } : {}),
    ...(flag("epcis-url") ? { epcis: flag("epcis-url")! } : {}),
  },
});
await fs.writeFile(join(folder, "did.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
const report = await verifyScene(store, { resolve: async () => doc });
console.log(`sealed ${sealed} bits, signature ${report.signature}, ${report.ok ? "ok" : "FAILED"}`);
for (const w of report.witnesses ?? [])
  console.log(
    `witness ${w.witness}: ${w.ok ? `attested ${new Date(w.time!).toISOString()}` : `FAILED (${w.reason})`}`,
  );
console.log(`did ${did}`);
console.log(`serve ${join(folder, "did.json")} at ${didWebUrl(did)}`);
