/**
 * Local first (PLAN-3.md Phase 13): the WebGPU LED-frame kernel is
 * byte-equal to the CPU path, the whole scene's frames go in one dispatch,
 * and a job runs in the browser through the actor contract with its four
 * records landing in the ledger. A browser without WebGPU skips the GPU
 * assertions and says so in the annotations.
 */
import { expect, type Page, test } from "@playwright/test";

type Hook = {
  gpuInfo(): { available: boolean; ms?: number; bits: number };
  gpuCheck(n: number): Promise<{ mismatches: number; first?: string; ms: number }>;
  gpuAllFrames(): Promise<{ ms?: number; bits: number }>;
  runJob(
    kind: string,
  ): Promise<
    | { audit: { passed: boolean; check: string; detail?: string }; seqs: number[]; cid?: string }
    | undefined
  >;
  jobRecords(id: string): {
    id: string;
    request?: unknown;
    result?: unknown;
    audit?: { passed: boolean };
    reward?: unknown;
    seqs: number[];
  }[];
  selectFirstFaceBit(): string | undefined;
  loadSize(n: number): void;
};

const hook = <T>(page: Page, fn: (h: Hook) => T): Promise<T> =>
  page.evaluate(
    (src: string) =>
      new Function("h", `return (${src})(h)`)((window as unknown as { __vpb: Hook }).__vpb) as T,
    fn.toString(),
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/three/");
  await page.waitForSelector("body[data-ready='1']", { timeout: 60_000 });
});

test("a hundred random bits: the GPU frame equals the CPU frame byte for byte; the scene dispatches in one call at 8³ and 16³", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const info = await hook(page, (h) => h.gpuInfo());
  test
    .info()
    .annotations.push({ type: "webgpu", description: info.available ? "available" : "absent" });
  test.skip(!info.available, "this browser has no WebGPU; the GPU oracle did not run here");
  const check = await hook(page, (h) => h.gpuCheck(100));
  expect(check.mismatches, check.first ?? "").toBe(0);
  test
    .info()
    .annotations.push({ type: "gpu check, 100 bits ms", description: check.ms.toFixed(2) });
  const eight = await hook(page, (h) => h.gpuAllFrames());
  expect(eight.bits).toBe(485);
  test
    .info()
    .annotations.push({ type: "gpu dispatch 8³ ms", description: (eight.ms ?? -1).toFixed(2) });
  await hook(page, (h) => h.loadSize(16));
  await page.waitForSelector("body[data-ready='1']");
  const sixteen = await hook(page, (h) => h.gpuAllFrames());
  expect(sixteen.bits).toBe(4069);
  test
    .info()
    .annotations.push({ type: "gpu dispatch 16³ ms", description: (sixteen.ms ?? -1).toFixed(2) });
  console.log(
    `gpu: 100-bit check ${check.ms.toFixed(2)} ms; 8³ ${eight.ms?.toFixed(2)} ms; 16³ ${sixteen.ms?.toFixed(2)} ms`,
  );
  await expect(page.locator("#hud")).toContainText("LED frames");
});

test("a job runs in the browser through the actor contract: four records land, the GPU frame audit passes or names the reason", async ({
  page,
}) => {
  const id = await hook(page, (h) => h.selectFirstFaceBit());
  expect(id).toBeTruthy();
  const info = await hook(page, (h) => h.gpuInfo());
  const gpuRun = await hook(page, (h) => h.runJob("led-frame-gpu"));
  expect(gpuRun).toBeTruthy();
  if (info.available) {
    expect(gpuRun!.audit.passed, gpuRun!.audit.detail).toBe(true);
    expect(gpuRun!.cid).toMatch(/^bafkrei/);
    expect(gpuRun!.seqs.length).toBe(4);
  } else {
    expect(gpuRun!.audit.passed).toBe(false);
    expect(gpuRun!.audit.detail).toContain("no WebGPU");
    expect(gpuRun!.seqs.length).toBe(3);
  }
  const cpuRun = await hook(page, (h) => h.runJob("led-frame"));
  expect(cpuRun!.audit.passed).toBe(true);
  const linksRun = await hook(page, (h) => h.runJob("links"));
  expect(linksRun!.audit.passed, linksRun!.audit.detail).toBe(true);
  const records = await page.evaluate(
    (bit) => (window as unknown as { __vpb: Hook }).__vpb.jobRecords(bit),
    id!,
  );
  expect(records.length).toBe(3);
  for (const r of records) {
    expect(r.request).toBeTruthy();
    expect(r.result).toBeTruthy();
    expect(r.audit).toBeTruthy();
    expect(Boolean(r.reward)).toBe(r.audit!.passed);
  }
  await expect(page.locator("#job-audit")).toContainText("audit");
  await page.click("#run-job");
  await expect(page.locator("#job-audit")).toContainText("led-frame-gpu");
});
