import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The browser build of the renderer, for GitHub Pages.
 *
 * Same sources as the Electron renderer, same aliases, same `index.html` — the only differences
 * are that there is no main or preload target, and that `window.cte2` comes from the shim in
 * `renderer/src/platform` instead of a preload script. See `electron.vite.config.ts` for the
 * desktop build.
 *
 * `base: "./"` is the load-bearing line. A project page is served from `/<repo>/` and a custom
 * domain from `/`, and relative URLs are correct under both — so the same artifact deploys to
 * either without a rebuild. The shim resolves its data URLs against `document.baseURI` for the
 * same reason.
 *
 * The data itself is not staged here: `tools/build-site.mjs` runs this and then copies `data/`
 * into the output, because it has to minify and gzip the snapshot on the way through and that is
 * not work a Vite plugin should be doing on every dev reload.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "out/web"),
    emptyOutDir: true,
    // The snapshot dwarfs anything here; warning about a 600 kB chunk is noise.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { index: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
