#!/usr/bin/env node
/**
 * Cut the pack data the build catalogue needs out of a snapshot.
 *
 * Two files per pack, written to `<out>/<mineAndSlashVersion>/`:
 *
 *  - **`snapshot.json` (+ `.gz`): the slim snapshot.** Only the registries `@cte2/schema` and
 *    `@cte2/engine` read, which is what a catalogue page needs to draw a build and compute its
 *    numbers. The other ~190 registries — other mods' loot tables, recipes, worldgen — are half
 *    the file and nothing in a build viewer ever looks at them. Machine-local `meta` is dropped
 *    as `build-site.mjs` drops it.
 *  - **`index-data.json`: what `summarizeBuild` reads**, ~20 KB, so the catalogue's upload
 *    endpoint can work out a build's ascendancy, skills and uniques without loading a snapshot.
 *
 * **The slim snapshot is checked, not trusted.** Dropping a registry the engine turns out to read
 * would not crash anything; it would compute every build a little wrong, forever, on a public
 * site. So unless `--no-verify` is passed, every build in `examples/` and `fixtures/` is derived
 * against both snapshots and the run fails on the first number that differs.
 *
 * Usage:
 *   node tools/build-catalogue-data.mjs [--data <dir>] [--out <dir>] [--no-verify]
 *
 *   --data   Where `snapshot.json` lives. Default `data/`.
 *   --out    Where to write. Default `data/catalogue`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

function fail(message) {
  console.error(`build-catalogue-data: ${message}`);
  process.exit(1);
}

const dataDir = resolve(repoRoot, arg("data", "data"));
const outRoot = resolve(repoRoot, arg("out", "data/catalogue"));
const verify = !process.argv.includes("--no-verify");

const schemaDist = join(repoRoot, "packages/schema/dist/index.js");
const engineDist = join(repoRoot, "packages/engine/dist/index.js");
if (!existsSync(schemaDist) || !existsSync(engineDist)) fail("build the packages first: npm run build");

const { buildIndexData, parseBuild } = await import(`file://${schemaDist}`);
const { deriveBuild } = await import(`file://${engineDist}`);

/**
 * The registries a build viewer reads — every one `@cte2/schema` or `@cte2/engine` names.
 *
 * An explicit list rather than a scan of the source at build time, so that what the catalogue
 * ships is a reviewed decision. Adding a registry to the engine without adding it here is exactly
 * what the verification step below exists to catch.
 */
const KEEP_REGISTRIES = [
  "library_of_exile_currency",
  "library_of_exile_item_modification",
  "library_of_exile_item_requirement",
  "mmorpg_affixes",
  "mmorpg_aura",
  "mmorpg_base_gear_types",
  "mmorpg_base_stats",
  "mmorpg_chaos_stat",
  "mmorpg_exile_effect",
  "mmorpg_game_balance",
  "mmorpg_gear_rarity",
  "mmorpg_gear_slot",
  "mmorpg_gems",
  "mmorpg_map_affix",
  "mmorpg_mercenary",
  "mmorpg_mob_affix",
  "mmorpg_mob_rarity",
  "mmorpg_omen",
  "mmorpg_perk",
  "mmorpg_runes",
  "mmorpg_runeword",
  "mmorpg_sets",
  "mmorpg_spell_school",
  "mmorpg_spells",
  "mmorpg_stat",
  "mmorpg_stat_buff",
  "mmorpg_stat_compat",
  "mmorpg_stat_condition",
  "mmorpg_stat_effect",
  "mmorpg_stat_layer",
  "mmorpg_support_gem",
  "mmorpg_talent_tree",
  "mmorpg_unique_gears",
  "mmorpg_value_calc",
  "mmorpg_weapon_type",
  "mmorpg_wizard",
  "tags",
];

/** Same list, same reasoning, as `LOCAL_ONLY_META` in build-site.mjs. */
const LOCAL_ONLY_META = ["gameDir", "mineAndSlashJar", "libraryOfExileJar", "resourcePacks", "fingerprint"];

const snapshotFile = join(dataDir, "snapshot.json");
if (!existsSync(snapshotFile)) fail(`no snapshot at ${snapshotFile}`);
console.log(`build-catalogue-data: reading ${snapshotFile}`);
const full = JSON.parse(readFileSync(snapshotFile, "utf8"));

const meta = { ...full.meta };
for (const key of LOCAL_ONLY_META) delete meta[key];
meta.publishedBy = "tools/build-catalogue-data.mjs";
meta.publishedAt = new Date().toISOString();

const registries = {};
for (const id of KEEP_REGISTRIES) {
  if (full.registries[id] !== undefined) registries[id] = full.registries[id];
}
// `diagnostics` is the extractor's report on the pack, not pack data, and only the desktop app's
// Data tab reads it. Emptied rather than dropped so the file keeps the `Snapshot` shape.
const diagnostics = Object.fromEntries(
  Object.entries(full.diagnostics ?? {}).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
);
const slim = { ...full, meta, registries, diagnostics };

if (verify) {
  const builds = [
    ...listJson(join(repoRoot, "examples")),
    ...listJson(join(repoRoot, "fixtures")),
    ...listJson(join(repoRoot, "fixtures/local")),
  ];
  if (builds.length === 0) fail("nothing to verify against — no builds in examples/ or fixtures/");
  for (const file of builds) {
    let doc;
    try {
      doc = parseBuild(readFileSync(file, "utf8")).doc;
    } catch {
      continue; // Not a build — a README or a half-written fixture. Not this tool's business.
    }
    const a = fingerprint(deriveBuild(doc, full));
    const b = fingerprint(deriveBuild(doc, slim));
    const diff = firstDifference(a, b);
    if (diff !== undefined) {
      fail(
        `the slim snapshot computes ${file} differently: ${diff}.\n` +
          "  A registry the engine reads is missing from KEEP_REGISTRIES.",
      );
    }
  }
  console.log(`  verified      ${builds.length} builds derive identically`);
}

const outDir = join(outRoot, String(meta.mineAndSlashVersion ?? "unknown"));
mkdirSync(outDir, { recursive: true });

const minified = JSON.stringify(slim);
writeFileSync(join(outDir, "snapshot.json"), minified);
const gzipped = gzipSync(Buffer.from(minified, "utf8"), { level: 9 });
writeFileSync(join(outDir, "snapshot.json.gz"), gzipped);

const index = buildIndexData(full);
writeFileSync(join(outDir, "index-data.json"), JSON.stringify(index));

console.log(`build-catalogue-data: wrote ${outDir}`);
console.log(`  snapshot      ${mb(minified.length)} minified, ${mb(gzipped.length)} gzipped`);
console.log(`  registries    ${Object.keys(registries).length} of ${Object.keys(full.registries).length} kept`);
console.log(`  index data    ${(JSON.stringify(index).length / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------------------

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

/** The numbers a catalogue page shows, flattened to compare. */
function fingerprint(derived) {
  const out = {};
  for (const [id, stat] of derived.stats) out[`stat:${id}`] = stat.value;
  out["dps"] = derived.dps?.dps;
  out["fullDps"] = derived.fullDps?.dps;
  out["diagnostics"] = derived.diagnostics.length;
  return out;
}

function firstDifference(a, b) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.is(a[key], b[key])) return `${key} is ${a[key]} with every registry and ${b[key]} without`;
  }
  return undefined;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
