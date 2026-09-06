/**
 * Pin one file to IPFS through Pinata's v3 Files API and print its CID.
 *
 *   PINATA_JWT_FILE=<path to a file holding the JWT> npm run scene:pin -- <file> [name]
 *
 * The token is read from the file named by PINATA_JWT_FILE, or from the
 * PINATA_JWT environment variable, and is never printed. Keep the file
 * outside the repository.
 */
import { promises as fs } from "node:fs";
import { basename } from "node:path";

const [file, name] = process.argv.slice(2);
if (!file) {
  console.error("usage: pin-pinata <file> [name]");
  process.exit(2);
}

async function token(): Promise<string> {
  const fromFile = process.env.PINATA_JWT_FILE;
  const raw = fromFile ? await fs.readFile(fromFile, "utf8") : (process.env.PINATA_JWT ?? "");
  const jwt = raw.trim();
  if (!jwt) {
    console.error("no token: set PINATA_JWT_FILE to a file holding the Pinata JWT");
    process.exit(2);
  }
  return jwt;
}

const jwt = await token();
const bytes = await fs.readFile(file);
const form = new FormData();
form.append("file", new Blob([bytes], { type: "application/json" }), basename(file));
form.append("network", "public");
form.append("name", name ?? basename(file));

const res = await fetch("https://uploads.pinata.cloud/v3/files", {
  method: "POST",
  headers: { Authorization: `Bearer ${jwt}` },
  body: form,
});
const body = (await res.json().catch(() => ({}))) as { data?: { cid?: string; id?: string; size?: number } ; error?: unknown };
if (!res.ok || !body.data?.cid) {
  console.error(`upload failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`cid ${body.data.cid}`);
console.log(`size ${body.data.size ?? bytes.length} bytes, id ${body.data.id ?? "?"}`);
console.log(`gateway https://gateway.pinata.cloud/ipfs/${body.data.cid}`);
console.log(`gateway https://ipfs.io/ipfs/${body.data.cid}`);
