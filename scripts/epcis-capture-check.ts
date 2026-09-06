/**
 * Capture an EPCIS document into a running EPCIS 2.0 repository (OpenEPCIS
 * Community Edition by default), then query the events back and compare
 * counts. The stretch oracle of PLAN-2.md Phase 9.
 *
 *   npm run scene:epcis:capture -- <epcis.json> [baseUrl=http://localhost:8080] [chunkBytes=90000]
 *
 * The document is sent in chunks under `chunkBytes` serialized, each a
 * complete EPCISDocument: OpenEPCIS CE refuses captures over 100,000 bytes.
 * Chunks go one at a time by default. EPCIS_CONCURRENCY raises the number
 * in flight, and against OpenEPCIS CE that loses events: with 16 in flight
 * the log showed SRMSG00034 backpressure drops and a
 * ConcurrentModificationException while serializing to Kafka, and 16 jobs
 * stayed "running" with zero events for good. One at a time, every job
 * finished and every event came back.
 */
import { promises as fs } from "node:fs";
import { type EpcisDocument, type EpcisEvent, VPB_NS } from "../src/epcis.ts";

const [file, baseArg, chunkArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: epcis-capture-check <epcis.json> [baseUrl] [chunk]");
  process.exit(2);
}
const base = (baseArg ?? "http://localhost:8080").replace(/\/$/, "");
let firstJobLogged = false;

/** fetch that retries a network failure (not an HTTP status) with backoff; a run died once on a transient "fetch failed". */
async function fetchRetry(url: string, init?: RequestInit, tries = 6): Promise<Response> {
  for (let n = 0; ; n++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (n + 1 >= tries) throw err;
      const wait = 500 * 2 ** n;
      console.warn(`  fetch ${url.replace(base, "")} failed (${(err as Error).message}); retry ${n + 1} in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
const chunkBytes = Number(chunkArg ?? 90_000);
const concurrency = Math.max(1, Number(process.env.EPCIS_CONCURRENCY ?? 1));

const doc = JSON.parse(await fs.readFile(file, "utf8")) as EpcisDocument;
const events = doc.epcisBody.eventList;
let i = 0;
console.log(`document: ${events.length} events; capturing to ${base} in chunks under ${chunkBytes} bytes`);

// A repository that validates user extensions needs the vpb namespace's
// schema on file first (OpenEPCIS: "No JSON schema found for namespace").
// A second registration answers 500 "already mapped", which is the state
// this wants; a repository without the endpoint is fine.
{
  const schema = await fs.readFile("vendor/epcis/vpb-extension-schema.json", "utf8");
  const reg = await fetch(
    `${base}/userExtension/jsonSchema?namespace=${encodeURIComponent(VPB_NS)}&defaultPrefix=vpb`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: schema },
  ).catch(() => undefined);
  const body = reg ? await reg.text() : "";
  const state = !reg
    ? "endpoint unreachable"
    : reg.status === 201
      ? "registered"
      : /already mapped/i.test(body)
        ? "already registered"
        : `HTTP ${reg.status} ${body.slice(0, 200)}`;
  console.log(`extension schema for ${VPB_NS}: ${state}`);
}

// EPCIS_SKIP_CAPTURE=1 counts what the repository already holds without sending again.
const skipCapture = process.env.EPCIS_SKIP_CAPTURE === "1";
// The oracle is the delta: the repository may hold events from earlier runs.
const before = skipCapture ? 0 : await countEvents(base);
if (!skipCapture) console.log(`repository holds ${before} events before capture`);
const t0 = performance.now();
let sent = 0;
let captures = 0;
if (skipCapture) {
  sent = events.length;
  i = events.length;
  console.log("skipping capture; counting only");
}
const envelopeBytes = JSON.stringify({ ...doc, epcisBody: { eventList: [] } }).length + 2;
const chunks: EpcisEvent[][] = [];
while (i < events.length) {
  const list: EpcisEvent[] = [];
  let bytes = envelopeBytes;
  while (i < events.length) {
    const size = JSON.stringify(events[i]).length + 1;
    if (list.length > 0 && bytes + size > chunkBytes) break;
    list.push(events[i]!);
    bytes += size;
    i++;
  }
  chunks.push(list);
}
let next = 0;
async function worker(): Promise<void> {
  while (next < chunks.length) {
    const index = next++;
    const list = chunks[index]!;
    const part: EpcisDocument = { ...doc, epcisBody: { eventList: list } };
    const res = await fetchRetry(`${base}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "GS1-EPCIS-Version": "2.0.0",
        "GS1-CBV-Version": "2.0.0",
        "GS1-Capture-Error-Behaviour": "rollback",
      },
      body: JSON.stringify(part),
    });
    if (!(res.status === 200 || res.status === 201 || res.status === 202)) {
      console.error(`capture failed at chunk ${index}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
      process.exit(1);
    }
    // The capture is asynchronous: wait for the job before taking another
    // chunk, or the repository sheds load and drops messages (SRMSG00034).
    const location = res.headers.get("Location");
    if (location) await waitForJob(location.startsWith("http") ? location : `${base}${location}`);
    sent += list.length;
    captures++;
    if (captures % 25 === 0) console.log(`  ${sent} events sent in ${captures} captures, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
}
if (!skipCapture) {
  console.log(`${chunks.length} chunks, ${concurrency} in flight`);
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
}
const captureMs = performance.now() - t0;
if (!skipCapture) console.log(`sent ${sent} events in ${captures} captures, ${(captureMs / 1000).toFixed(1)} s`);

// Capture is asynchronous in OpenEPCIS (Kafka in the middle); poll the query
// side until the count stops growing or a deadline passes.
const deadline = Date.now() + 10 * 60_000;
let last = -1;
let stable = 0;
let counted = 0;
while (Date.now() < deadline) {
  counted = await countEvents(base);
  if (counted === last) stable++;
  else stable = 0;
  last = counted;
  if (counted - before >= sent || stable >= 3) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const gained = counted - before;
console.log(`query side reports ${counted} events, ${gained} more than before; sent ${sent}`);
const pass = gained === sent;
console.log(pass ? "PASS: the query returns exactly as many events as were sent" : "FAIL: the query count differs from the sent count");
process.exit(pass ? 0 : 1);

async function waitForJob(url: string): Promise<void> {
  for (let n = 0; n < 3000; n++) {
    // up to ten minutes; a job that never finishes is reported, not retried
    const res = await fetchRetry(url, { headers: { Accept: "application/json" } });
    if (res.status === 404 && n < 100) {
      // The job record is indexed a moment after the 202; keep polling.
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    if (!res.ok) return; // no job endpoint: nothing to wait for
    const job = (await res.json()) as { running?: boolean; success?: boolean; finishedAt?: string; captureStatus?: string; status?: string };
    if (!firstJobLogged) {
      firstJobLogged = true;
      console.log(`  first capture job: ${JSON.stringify(job).slice(0, 200)}`);
    }
    const done = job.running === false || job.finishedAt !== undefined || /(SUCCESS|FAIL|ERROR|DONE|COMPLET)/i.test(`${job.captureStatus ?? ""}${job.status ?? ""}`);
    if (done) {
      if (job.success === false || /FAIL|ERROR/i.test(`${job.captureStatus ?? ""}${job.status ?? ""}`)) {
        const errors = (job as { errors?: { detail?: string }[] }).errors ?? [];
        const allDuplicates =
          errors.length > 0 && errors.every((e) => /Duplicate EPCIS Event|already present/i.test(e.detail ?? ""));
        if (allDuplicates) {
          // A POST retried after a network failure had already landed. The
          // rollback behaviour stored nothing twice; the chunk is delivered.
          console.warn("  a retried chunk was already captured; counting it once");
          return;
        }
        console.error(`capture job failed: ${JSON.stringify(job).slice(0, 400)}`);
        process.exit(1);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`capture job did not finish: ${url}`);
  process.exit(1);
}

async function countEvents(url: string): Promise<number> {
  let total = 0;
  let token: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const q = new URLSearchParams({ perPage: "100" }); // OpenEPCIS CE allows at most 100
    if (token) q.set("nextPageToken", token);
    const res = await fetchRetry(`${url}/events?${q}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`query failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      epcisBody?: { queryResults?: { resultsBody?: { eventList?: EpcisEvent[] } } };
      eventList?: EpcisEvent[];
    };
    const list = body.epcisBody?.queryResults?.resultsBody?.eventList ?? body.eventList ?? [];
    total += list.length;
    // OpenEPCIS CE names the next page in a Link header, rel="next".
    const link = res.headers.get("Link") ?? "";
    token =
      res.headers.get("GS1-Next-Page-Token") ??
      /nextPageToken=([^>&;]+)>;\s*rel="next"/.exec(link)?.[1] ??
      undefined;
    if (!token || list.length === 0) break;
  }
  return total;
}
