/**
 * Make a container key (PLAN-3.md Phase 11).
 *
 *   npm run key:gen -- <out.jwk>
 *
 * Writes the private JWK to the path given, which should be outside the
 * repository (the Pinata token lives in ~/.config/vpb; keys belong beside
 * it), and prints only the public half and the key id. The private key is
 * never printed.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, keyId } from "../src/keys.ts";

const [out] = process.argv.slice(2);
if (!out) {
  console.error("usage: keygen <out.jwk>");
  process.exit(2);
}
try {
  await fs.access(out);
  console.error(`${out} exists; refusing to overwrite a key`);
  process.exit(1);
} catch {
  // absent, as it should be
}
const { publicKey, privateKey } = await generateKeyPair();
await fs.mkdir(dirname(out), { recursive: true });
await fs.writeFile(out, `${JSON.stringify(privateKey, null, 2)}\n`, { mode: 0o600 });
console.log(`private key written to ${out} (keep it there; it is not printed)`);
console.log(`key id ${await keyId(publicKey)}`);
console.log(`public JWK ${JSON.stringify(publicKey)}`);
