import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  fullyParallel: false,
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
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
