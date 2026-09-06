/**
 * Sign and witness a release manifest (PLAN-4.md Phase 22).
 *
 *   npm run release:attest -- --key <container.jwk> --did <did:web:...>
 *        [--manifest release/release.json] [--out release/release.sig.json]
 *        [--witness notary:<jwk> | rfc3161:<url>]...
 *
 * The signature covers the manifest's digest; witnesses attest the
 * signature's SHA-256, as they do for a scene seal (ADR 0013). The key is
 * never printed. A public provenance attestation is a Decision (PLAN-4.md)
 * and is not made here.
 */
import { promises as fs } from "node:fs";
import type { PrivateKeyJwk } from "../src/keys.ts";
import { NotaryWitness, Rfc3161Witness, type Witness } from "../src/witness.ts";
import { attestRelease, type ReleaseManifest } from "./release.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const keyFile = flag("key");
const did = flag("did");
if (!keyFile || !did) {
  console.error("usage: release-attest --key <jwk> --did <did:web:...> [--manifest release/release.json] [--out release/release.sig.json] [--witness notary:<jwk>|rfc3161:<url>]...");
  process.exit(2);
}
const manifestPath = flag("manifest") ?? "release/release.json";
const out = flag("out") ?? "release/release.sig.json";
const privateKey = JSON.parse(await fs.readFile(keyFile, "utf8")) as PrivateKeyJwk;
if (privateKey.kty !== "OKP" || privateKey.crv !== "Ed25519" || !privateKey.d) {
  console.error("the key file is not an Ed25519 private JWK");
  process.exit(1);
}
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ReleaseManifest;
const witnesses: Witness[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--witness") continue;
  const spec = args[i + 1] ?? "";
  if (spec.startsWith("notary:")) witnesses.push(new NotaryWitness(JSON.parse(await fs.readFile(spec.slice(7), "utf8")) as PrivateKeyJwk));
  else if (spec.startsWith("rfc3161:")) witnesses.push(new Rfc3161Witness(spec.slice(8)));
  else {
    console.error(`--witness takes notary:<jwk> or rfc3161:<url>, not ${spec}`);
    process.exit(2);
  }
}
const sig = await attestRelease(manifest, { did, privateKey }, witnesses);
await fs.writeFile(out, `${JSON.stringify(sig, null, 2)}\n`, "utf8");
console.log(`signed digest ${manifest.digest.slice(0, 16)}… of ${manifest.version} at ${manifest.commit.slice(0, 12)} with key ${sig.keyId} of ${did}`);
for (const w of sig.witness ?? []) console.log(`witness ${w.witness}: attested ${new Date(w.time).toISOString()}`);
console.log(`written ${out}`);
