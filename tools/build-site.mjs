#!/usr/bin/env node
/**
 * Build the static site: the renderer, plus the pack data it needs, in one directory.
 *
 * Run by `npm run build:site` locally and by `.github/workflows/pages.yml` in CI. The output is
 * `packages/app/out/web`, ready to hand to `actions/upload-pages-artifact` or to serve with any
 * static file server.
 *
 * Two things here are not just copying:
 *
 *  1. **The snapshot is scrubbed.** `snapshot.meta` records where the data came from — the
 *     absolute path of the game directory, of each jar, of every resource pack, and a
 *     fingerprint listing 94 files with their sizes and mtimes. That is exactly right for a
 *     local file whose whole job is to notice when the install underneath it changed, and it is
 *     somebody's home directory and Windows username published on the internet. Nothing in the
 *     renderer or the engine reads any of it, so it is dropped rather than redacted.
 *
 *  2. **The snapshot is minified and gzipped.** The committed file is pretty-printed at 15 MB;
 *     minified it is 7.4 MB and gzipped it is around 800 KB. Both are staged — see
 *     `fetchSnapshotText` in the web shim for which one a browser ends up fetching.
 *
 * Usage:
 *   node tools/build-site.mjs [--data <dir>] [--out <dir>] [--skip-bundle]
 *
 *   --data   Where `snapshot.json` and `assets/` live. Default `data/`. CI points this at the
 *            `site-data` branch it checked out.
 *   --out    Where to write the site. Default `packages/app/out/web`.
 *   --skip-bundle  Stage the data only, without re-running Vite. For iterating on the data step.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const dataDir = resolve(repoRoot, arg("data", "data"));
const outDir = resolve(repoRoot, arg("out", "packages/app/out/web"));
const skipBundle = process.argv.includes("--skip-bundle");

const snapshotFile = join(dataDir, "snapshot.json");
const assetsDir = join(dataDir, "assets");

function fail(message) {
  console.error(`build-site: ${message}`);
  process.exit(1);
}

if (!existsSync(snapshotFile)) {
  fail(
    `no snapshot at ${snapshotFile}.\n` +
      "  The site ships prebuilt pack data. Extract it with the desktop app, or point --data at\n" +
      "  a checkout of the `site-data` branch. See the README's 'Publishing the site' section.",
  );
}

/**
 * Fields that describe *this machine* rather than the pack.
 *
 * Kept as an explicit list rather than an allowlist of what to keep, so that a new field added
 * to `meta` by the extractor ships by default. The failure mode of the other direction — a field
 * the app needs silently vanishing from the published snapshot — is much harder to notice than
 * a new field turning up in the site's JSON.
 */
const LOCAL_ONLY_META = [
  "gameDir",
  "mineAndSlashJar",
  "libraryOfExileJar",
  "resourcePacks",
  "fingerprint",
];

console.log(`build-site: reading ${snapshotFile}`);
const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));

const meta = snapshot.meta ?? {};
const dropped = LOCAL_ONLY_META.filter((key) => meta[key] !== undefined);
for (const key of dropped) delete meta[key];
// Say so in the file itself, so anyone reading the published snapshot and wondering where the
// fingerprint went has the answer without reading this script.
meta.publishedBy = "tools/build-site.mjs";
meta.publishedAt = new Date().toISOString();

const entries = Object.values(snapshot.registries ?? {}).reduce(
  (total, category) => total + Object.keys(category ?? {}).length,
  0,
);
const langKeys = Object.keys(snapshot.lang ?? {}).length;

if (!skipBundle) {
  console.log("build-site: bundling the renderer");
  // Vite's own entry script under this Node, rather than `npx`. `npx` needs a shell on Windows
  // and reports its failures as the shell's, which turned a working build into "vite build
  // failed" with nothing else to go on. `require.resolve("vite/bin/vite.js")` is not an option
  // either — vite's `exports` map does not expose its bin — so the package directory is resolved
  // and the path built from there.
  const require = createRequire(import.meta.url);
  const viteBin = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
  if (!existsSync(viteBin)) fail(`cannot find vite's bin at ${viteBin}; run npm install`);
  // `--outDir` is passed explicitly rather than left to the config, because `--out` has to move
  // the bundle as well as the data. Without it the two land in different directories and the
  // result is an output folder holding `data/` and no `index.html`.
  const result = spawnSync(
    process.execPath,
    [viteBin, "build", "--config", "vite.web.config.ts", "--outDir", outDir, "--emptyOutDir"],
    { cwd: join(repoRoot, "packages/app"), stdio: "inherit" },
  );
  if (result.status !== 0) fail(`vite build exited ${result.status}`);
} else if (!existsSync(join(outDir, "index.html"))) {
  fail("--skip-bundle, but there is no bundle in the output directory yet");
}

const siteData = join(outDir, "data");
rmSync(siteData, { recursive: true, force: true });
mkdirSync(siteData, { recursive: true });

const minified = JSON.stringify(snapshot);
writeFileSync(join(siteData, "snapshot.json"), minified);
// Level 9: this runs once per deploy and every visitor pays for the bytes.
const gzipped = gzipSync(Buffer.from(minified, "utf8"), { level: 9 });
writeFileSync(join(siteData, "snapshot.json.gz"), gzipped);

if (!existsSync(assetsDir)) {
  fail(`no assets at ${assetsDir}. The site would render every icon as a blank.`);
}
cpSync(assetsDir, join(siteData, "assets"), { recursive: true });

const manifest = {
  version: 1,
  // Every path here is relative to the *site root*, not to this file: the shim resolves them
  // against `document.baseURI` so that one artifact works at `/<repo>/` and at `/` alike.
  snapshot: "data/snapshot.json",
  snapshotGzip: "data/snapshot.json.gz",
  assets: "data/assets/",
  assetIndex: "data/assets/index.json",
  builtAt: new Date().toISOString(),
  source: {
    mineAndSlashVersion: meta.mineAndSlashVersion ?? null,
    packIds: meta.openLoaderPackIds ?? [],
    extractedAt: meta.extractedAt ?? null,
    entries,
    langKeys,
  },
};
writeFileSync(join(siteData, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// GitHub Pages runs Jekyll over the artifact unless told not to, and Jekyll silently drops
// files and directories whose names begin with `_` or `.`. Nothing here starts with one today,
// but a future Vite or a future asset name could, and the failure would be a missing file in
// production only.
writeFileSync(join(outDir, ".nojekyll"), "");

const mb = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;
console.log(`build-site: wrote ${outDir}`);
console.log(`  snapshot      ${mb(Buffer.byteLength(minified))} minified, ${mb(gzipped.length)} gzipped`);
console.log(`  dropped       ${dropped.length > 0 ? dropped.join(", ") : "(nothing local in meta)"}`);
console.log(`  registries    ${entries.toLocaleString()} entries, ${langKeys.toLocaleString()} lang keys`);
console.log(`  pack          Mine and Slash ${manifest.source.mineAndSlashVersion ?? "unknown"}`);
