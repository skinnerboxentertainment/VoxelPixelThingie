/**
 * Retire a container key in favour of a new one (PLAN-4.md Phase 18, ADR
 * 0013).
 *
 *   npm run key:rotate -- --old <old.jwk> --new <new.jwk> --did-doc <did.json> [--retired <ISO time>]
 *
 * Makes the new key (refusing to overwrite), writes a rotation statement
 * signed by the old key into the DID document's `rotations`, and makes the
 * new key the one the document asserts with. Seals made with the old key
 * before `retired` keep verifying through the chain; seal new scenes with
 * the new key. Neither private key is printed.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { type DidDocument, rotateKey } from "../src/did.ts";
import { generateKeyPair, keyId, type PrivateKeyJwk, publicOf } from "../src/keys.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? undefined : args[i + 1];
};
const oldPath = flag("old");
const newPath = flag("new");
const docPath = flag("did-doc");
if (!oldPath || !newPath || !docPath) {
  console.error("usage: rotate-key --old <old.jwk> --new <new.jwk> --did-doc <did.json> [--retired <ISO time>]");
  process.exit(2);
}
try {
  await fs.access(newPath);
  console.error(`${newPath} exists; refusing to overwrite a key`);
  process.exit(1);
} catch {
  // absent, as it should be
}
const oldKey = JSON.parse(await fs.readFile(oldPath, "utf8")) as PrivateKeyJwk;
if (oldKey.kty !== "OKP" || oldKey.crv !== "Ed25519" || !oldKey.d) {
  console.error("the old key file is not an Ed25519 private JWK");
  process.exit(1);
}
const doc = JSON.parse(await fs.readFile(docPath, "utf8")) as DidDocument;
const retired = flag("retired") ? Date.parse(flag("retired")!) : Date.now();
if (Number.isNaN(retired)) {
  console.error("--retired must be an ISO time");
  process.exit(1);
}
const oldKid = await keyId(publicOf(oldKey));
const current = doc.verificationMethod.find((m) => m.id.endsWith(`#${oldKid}`));
if (!current || !doc.assertionMethod.includes(current.id)) {
  console.error(`the document does not assert with key ${oldKid}; nothing to rotate`);
  process.exit(1);
}
const fresh = await generateKeyPair();
const statement = await rotateKey(oldKey, fresh.publicKey, retired);
const newKid = statement.to;
const vm = `${doc.id}#${newKid}`;
doc.verificationMethod = [
  ...doc.verificationMethod.filter((m) => m.id !== vm),
  { id: vm, type: "JsonWebKey2020", controller: doc.id, publicKeyJwk: { ...fresh.publicKey, kid: newKid } },
];
doc.assertionMethod = [vm];
doc.rotations = [...(doc.rotations ?? []), statement];
await fs.mkdir(dirname(newPath), { recursive: true });
await fs.writeFile(newPath, `${JSON.stringify(fresh.privateKey, null, 2)}\n`, { mode: 0o600 });
await fs.writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`retired ${oldKid} at ${new Date(retired).toISOString()}; the document now asserts with ${newKid}`);
console.log(`new private key written to ${newPath} (not printed); rotations in the document: ${doc.rotations.length}`);
console.log(`publish ${docPath} where the DID resolves, then seal new scenes with ${newPath}`);
