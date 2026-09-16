import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * The three build targets.
 *
 * `@cte2/extractor`, `@cte2/schema` and `@cte2/engine` are deliberately **not** externalised.
 * They are ESM-only workspace packages, and this package builds its main and preload output as
 * CommonJS (there is no `"type": "module"` in its package.json) because that is the Electron
 * configuration with the fewest sharp edges around preload scripts. A CJS bundle cannot
 * `require()` an ESM package, so they are bundled in instead — which they should be anyway,
 * since a packaged app has no workspace symlinks to follow.
 */
const workspacePackages = ["@cte2/extractor", "@cte2/schema", "@cte2/engine"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      // `root` is overridden above, so the default `out/renderer` would resolve relative to
      // `src/renderer` and land outside the package. Pin it.
      outDir: resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
