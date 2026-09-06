import { resolve } from "node:path";
import { defineConfig } from "vite";

const demo = resolve(import.meta.dirname, "demo");

export default defineConfig({
  root: demo,
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(demo, "index.html"),
        canvas: resolve(demo, "canvas/index.html"),
        three: resolve(demo, "three/index.html"),
        pixi: resolve(demo, "pixi/index.html"),
        passport: resolve(demo, "passport/index.html"),
        reader: resolve(demo, "reader/index.html"),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
