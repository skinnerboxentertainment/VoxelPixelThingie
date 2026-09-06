/**
 * The reader as one file (PLAN-4.md Phase 17): every script and style
 * inlined, so the page opens from disk with nothing else. The plugin is a
 * build-time dependency only; the page has none at runtime.
 */
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const demo = resolve(import.meta.dirname, "demo");

export default defineConfig({
  root: demo,
  base: "./",
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: resolve(import.meta.dirname, "dist-reader"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { reader: resolve(demo, "reader/index.html") } },
  },
  logLevel: "warn",
});
