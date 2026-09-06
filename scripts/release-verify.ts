/**
 * Check a release against its manifest and signature (PLAN-4.md Phase 22).
 *
 *   npm run release:verify [-- --manifest release/release.json] [--sig release/release.sig.json]
 *        [--dist dist] [--dist-reader dist-reader] [--did-doc <file|url>]
 *        [--trust-notary <public jwk>]... [--trust-tsa <fingerprint>]...
 *
 * Recomputes every file's hash and the digest, checks the signature
 * against the DID document (resolved, or given), checks each witness, and
 * reports each source on its own line. Exit 0 only when the files, the
 * digest, and the signature (when present) all hold.
 */
import { promises as fs } from "node:fs";
import { resolveDidWeb } from "../src/did.ts";
import type { PublicKeyJwk } from "../src/keys.ts";
import { type ReleaseManifest, type ReleaseSignature, verifyRelease } from "./release.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]!] : []));
const manifest = JSON.parse(await fs.readFile(flag("manifest") ?? "release/release.json", "utf8")) as ReleaseManifest;
let signature: ReleaseSignature | undefined;
const sigPath = flag("sig") ?? "release/release.sig.json";
try {
  signature = JSON.parse(await fs.readFile(sigPath, "utf8")) as ReleaseSignature;
} catch {
  signature = undefined;
}
const trees: Record<string, string> = {};
for (const name of ["dist", "dist-reader"]) {
  const dir = flag(name) ?? name;
  try {
    await fs.access(dir);
    trees[name] = dir;
  } catch {
    // not built here: skipped, and said so below
  }
}
const didDocArg = flag("did-doc");
const resolve = async (did: string) => {
  if (!didDocArg) return resolveDidWeb(did);
  const text = /^https?:\/\//.test(didDocArg) ? await (await fetch(didDocArg)).text() : await fs.readFile(didDocArg, "utf8");
  return JSON.parse(text);
};
const notaries: PublicKeyJwk[] = [];
for (const f of all("trust-notary")) notaries.push(JSON.parse(await fs.readFile(f, "utf8")) as PublicKeyJwk);
const v = await verifyRelease(manifest, {
  trees,
  ...(signature ? { signature, resolve } : {}),
  trust: { notaries, tsaFingerprints: all("trust-tsa") },
});
console.log(`release ${manifest.version} at ${manifest.commit.slice(0, 12)}, digest ${manifest.digest.slice(0, 16)}…`);
console.log(`files: ${Object.keys(trees).length ? `${v.mismatches.length === 0 ? "all match" : `${v.mismatches.length} differ`} in ${Object.keys(trees).join(", ")}` : "no built tree here to compare"}`);
for (const m of v.mismatches.slice(0, 5)) console.log(`  ${m.tree}/${m.path}: ${m.reason}`);
console.log(`digest: ${v.digestOk ? "recomputed and equal" : "DOES NOT MATCH the manifest's contents"}`);
console.log(`signature: ${v.signature}${signature ? ` by ${signature.did} key ${signature.keyId}` : ""}${v.rotation ? `, through ${v.rotation.via.join(" → ")}` : ""}`);
for (const w of v.witnesses ?? [])
  console.log(`witness ${w.witness}: ${w.ok ? `attested ${new Date(w.time!).toISOString()}${w.anchored ? ", anchored" : ", unanchored"}` : `FAILED (${w.reason})`}`);
console.log(`provenance: ${v.provenance} (a public attestation is a decision that has not been made)`);
if (!v.ok) for (const r of v.reasons) console.log(`  ${r}`);
process.exit(v.ok ? 0 : 1);
