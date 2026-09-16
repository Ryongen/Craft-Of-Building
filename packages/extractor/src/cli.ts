#!/usr/bin/env node
/**
 * Extractor CLI.
 *
 *   npm run extract -- --install "<path to instance or game dir>" [--out snapshot.json]
 *
 * Prints a summary and the diagnostics that decide whether the snapshot is trustworthy.
 * Exits non-zero when a fail-loud diagnostic fires, so this can gate CI on a pack update.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { extractAssets } from "./assets.js";
import { extract, gearItemIds, type Snapshot } from "./extract.js";
import { LocateError, locateInstall, type Install } from "./locate.js";

type Args = { install: string; out: string | null; assets: string | null; verbose: boolean };

function parseArgs(argv: string[]): Args {
  let install: string | null = null;
  let out: string | null = null;
  let assets: string | null = null;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--install" || arg === "-i") install = argv[++i] ?? null;
    else if (arg === "--out" || arg === "-o") out = argv[++i] ?? null;
    else if (arg === "--assets" || arg === "-a") assets = argv[++i] ?? null;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage(1);
    }
  }

  if (!install) {
    console.error("Missing required --install <path>");
    usage(1);
  }
  return { install: install!, out, assets, verbose };
}

function usage(code: number): never {
  console.log(
    [
      "Usage: extract --install <path> [--out <file>] [--assets <dir>] [--verbose]",
      "",
      "  --install, -i  Prism instance folder or the game directory itself.",
      "  --out, -o      Write the snapshot JSON here. Omit to only print the summary.",
      "  --assets, -a   Also copy the GUI textures (perk, spell and ascendancy icons) here.",
      "  --verbose, -v  List every diagnostic entry instead of a capped sample.",
    ].join("\n"),
  );
  process.exit(code);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let snapshot: Snapshot;
  let install: Install;
  try {
    install = locateInstall(resolve(args.install));
    console.log(`Mine and Slash ${install.mineAndSlashVersion}`);
    console.log(`Game dir       ${install.gameDir}`);
    console.log(
      `OpenLoader     ${install.openLoaderPacks.map((p) => p.id).join(", ") || "(none)"}`,
    );
    console.log("");
    snapshot = extract(install);
  } catch (err) {
    if (err instanceof LocateError) {
      console.error(`Could not read the install: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  report(snapshot, args.verbose);

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`\nSnapshot written to ${outPath}`);
  }

  if (args.assets) {
    const assetDir = resolve(args.assets);
    const itemIds = gearItemIds(snapshot);
    const result = extractAssets(install, assetDir, { itemIds });
    console.log(
      `\n${result.written} textures written to ${assetDir}` +
        ` (${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.overridden} overridden by a resource pack)`,
    );
    console.log(
      `  ${Object.keys(result.index.items).length}/${itemIds.length} gear item sprites resolved` +
        ` across ${install.modJars.length} mod jars`,
    );
    if (result.unresolvedItems.length > 0) {
      // Same family as the missing perk icons: a reference the pack cannot satisfy. Vanilla
      // items are the common case, since their textures live in the client jar rather than
      // anywhere under `mods/`.
      const shown = result.unresolvedItems.slice(0, 6).join(", ");
      console.log(
        `  ${result.unresolvedItems.length} unresolved: ${shown}` +
          `${result.unresolvedItems.length > 6 ? ", …" : ""}`,
      );
    }
    reportMissingIcons(snapshot, result.index.assets);
  }

  process.exit(exitCode(snapshot));
}

/**
 * What was opened, per namespace.
 *
 * The extractor used to read `data/mmorpg/` and nothing else, and nothing anywhere said so —
 * 604 files across `library_of_exile`, `dungeon_realm`, `ancient_obelisks` and `the_harvest`
 * were dropped, and three OpenLoader packs were skipped whole for having no `mmorpg` folder.
 * This table is the answer to that: the unit of "what does this install contain" is the
 * namespace, so it is the unit the report leads with.
 */
function reportNamespaces(snapshot: Snapshot): void {
  const rows = snapshot.diagnostics.namespaces;
  if (rows.length === 0) return;

  const layerWidth = Math.max(...rows.map((r) => r.layer.length), 5);
  const nsWidth = Math.max(...rows.map((r) => r.namespace.length), 9);
  console.log(
    `${"layer".padEnd(layerWidth)}  ${"namespace".padEnd(nsWidth)}  ${"cats".padStart(5)} ${"files".padStart(6)}`,
  );
  for (const row of [...rows].sort((a, b) => b.files - a.files)) {
    console.log(
      `${row.layer.padEnd(layerWidth)}  ${row.namespace.padEnd(nsWidth)}  ` +
        `${String(row.categories.length).padStart(5)} ${String(row.files).padStart(6)}`,
    );
  }
  console.log(
    `${"".padEnd(layerWidth)}  ${"TOTAL".padEnd(nsWidth)}  ${"".padStart(5)} ${String(rows.reduce((n, r) => n + r.files, 0)).padStart(6)}`,
  );
  console.log("");
}

function report(snapshot: Snapshot, verbose: boolean): void {
  const { registries, registryLists, diagnostics } = snapshot;

  reportNamespaces(snapshot);

  const categories = Object.keys(registries).sort();
  // A qualified key (`terralith:loot_tables`) is a vanilla datapack directory belonging to
  // another mod. They are extracted and counted, but listing all 160 of them by default buries
  // the registries a build actually comes from, so they roll into one line unless asked for.
  const shown = verbose ? categories : categories.filter((c) => !c.includes(":"));
  const hidden = categories.length - shown.length;
  const nameWidth = Math.max(...shown.map((c) => c.length), 8);
  let jarTotal = 0;
  let packTotal = 0;

  console.log(`${"category".padEnd(nameWidth)}  ${"jar".padStart(6)} ${"pack".padStart(6)} ${"merged".padStart(7)}`);
  for (const category of categories) {
    const entries = Object.values(registries[category]!);
    const fromJar = entries.filter((e) => e.source.kind === "jar").length;
    const fromPack = entries.length - fromJar;
    jarTotal += fromJar;
    packTotal += fromPack;
    if (!shown.includes(category)) continue;
    console.log(
      `${category.padEnd(nameWidth)}  ${String(fromJar).padStart(6)} ${String(fromPack).padStart(6)} ${String(entries.length).padStart(7)}`,
    );
  }
  if (hidden > 0) {
    console.log(`${`… and ${hidden} third-party categories`.padEnd(nameWidth)}  ${"".padStart(6)} ${"".padStart(6)} ${"".padStart(7)}`);
  }
  console.log(
    `${"TOTAL".padEnd(nameWidth)}  ${String(jarTotal).padStart(6)} ${String(packTotal).padStart(6)} ${String(jarTotal + packTotal).padStart(7)}`,
  );

  const statsWithJson = Object.keys(registries["mmorpg_stat"] ?? {}).length;
  const statsRegistered = (registryLists["mmorpg_stat"] ?? []).length;
  console.log("");
  console.log(`lang keys                  ${Object.keys(snapshot.lang).length}`);
  console.log(`stats with JSON            ${statsWithJson}`);
  console.log(`stats in default registry  ${statsRegistered}`);
  console.log(`code-only stats            ${diagnostics.codeOnlyStats.length}   <- must be ported from Java`);

  console.log("");
  console.log("diagnostics");
  logGroup("lenient JSON repairs", diagnostics.lenientRepairs, verbose, (r) => `${r.origin} [${r.repairs.join(", ")}]`);
  logGroup("id / filename mismatches", diagnostics.idMismatches, verbose, (m) => `${m.origin}: declared "${m.declared}" != file "${m.fromFilename}"`);
  logGroup("duplicate ids within a layer", diagnostics.duplicateIds, verbose, (d) => `${d.category}/${d.id}: ${d.kept} shadows ${d.shadowed}`);
  logGroup("unknown stat serializers", diagnostics.unknownStatSerializers, verbose, (u) => `${u.id}: ser="${u.ser}" (${u.origin})`);
  logGroup("unknown multiUseType", diagnostics.unknownMultiUseTypes, verbose, (u) => `${u.id}: "${u.value}" (${u.origin})`);
  logGroup("unknown modifier types", diagnostics.unknownModifierTypes, verbose, (u) => `${u.origin}: ${u.stat} type="${u.type}"`);
  logGroup("parse failures", diagnostics.parseFailures, verbose, (f) => `${f.origin}: ${f.error}`);
  logGroup("category key collisions", diagnostics.categoryKeyCollisions, verbose, (c) => `${c.key} claimed by ${c.claimedBy.join(" and ")}`);
  logGroup("categories without a registry list", diagnostics.categoriesWithoutRegistryList, verbose, (c) => c);

  for (const warning of diagnostics.warnings) console.log(`  ! ${warning}`);
}

/**
 * Perk icons that name a texture no archive contains.
 *
 * A pack-quality finding rather than an extraction gap: these were checked against every PNG
 * in the jar and every resource pack, by full path *and* by basename, and they are simply not
 * there. In game they render as the missing-texture square. Against pack `2.0.2` there are 51,
 * which sits alongside the 466 duplicate GUIDs and 263 id/filename mismatches as something the
 * app reproduces rather than corrects — it falls back to the mod's own `unknown.png`.
 */
function reportMissingIcons(snapshot: Snapshot, assets: Record<string, string>): void {
  const missing = new Set<string>();
  for (const entry of Object.values(snapshot.registries["mmorpg_perk"] ?? {})) {
    const icon = entry.data["icon"];
    if (typeof icon === "string" && icon.length > 0 && !(icon in assets)) missing.add(icon);
  }
  if (missing.size === 0) {
    console.log("  ok    every perk icon resolved");
    return;
  }
  console.log(`  ${missing.size} perk icons name a texture that is in no archive (pack bug; renders as unknown.png):`);
  for (const icon of [...missing].sort().slice(0, 10)) console.log(`          ${icon}`);
  if (missing.size > 10) console.log(`          ... and ${missing.size - 10} more (--verbose to list)`);
}

function logGroup<T>(label: string, items: T[], verbose: boolean, format: (item: T) => string): void {
  if (items.length === 0) {
    console.log(`  ok    ${label}: none`);
    return;
  }
  const limit = verbose ? items.length : 5;
  console.log(`  ${items.length.toString().padStart(5)} ${label}:`);
  for (const item of items.slice(0, limit)) console.log(`          ${format(item)}`);
  if (items.length > limit) console.log(`          ... and ${items.length - limit} more (--verbose to list)`);
}

/**
 * Fail-loud gate for things that mean the engine would be *guessing about schema*:
 * a serializer, multiUseType or modifier type we have never seen, or a file we could
 * not read at all.
 *
 * Duplicate GUIDs and id/filename mismatches are deliberately not fatal — they are
 * properties of the pack as shipped, not signs that the extractor is out of date, and
 * they are already reported loudly above.
 */
function exitCode(snapshot: Snapshot): number {
  const d = snapshot.diagnostics;
  const fatal =
    d.unknownStatSerializers.length +
    d.unknownMultiUseTypes.length +
    d.unknownModifierTypes.length +
    d.parseFailures.length +
    d.categoryKeyCollisions.length;
  return fatal > 0 ? 1 : 0;
}

main();
