import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  fullyParallel: false,
  // The three.js specs carry timing gates (save under 3 s). Two GPU-heavy
  // spec files sharing a CI runner doubled the save time; one worker there.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  },
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    stdout: "ignore",
    stderr: "pipe",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  // Playwright's bundled headless Chromium exposes no WebGPU adapter (probed
  // 2026-09-06: headed and the system Chrome do). The GPU spec runs on the
  // system Chrome, headless, and skips with an annotation where no adapter
  // exists, as on a CI runner without a GPU.
  projects: [
    { name: "chromium", use: { browserName: "chromium" }, testIgnore: /three-gpu/ },
    { name: "gpu", use: { browserName: "chromium", channel: "chrome" }, testMatch: /three-gpu/ },
  ],
});
