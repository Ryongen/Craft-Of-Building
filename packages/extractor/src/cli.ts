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

import { extract, type Snapshot } from "./extract.js";
import { LocateError, locateInstall } from "./locate.js";

type Args = { install: string; out: string | null; verbose: boolean };

function parseArgs(argv: string[]): Args {
  let install: string | null = null;
  let out: string | null = null;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--install" || arg === "-i") install = argv[++i] ?? null;
    else if (arg === "--out" || arg === "-o") out = argv[++i] ?? null;
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
  return { install: install!, out, verbose };
}

function usage(code: number): never {
  console.log(
    [
      "Usage: extract --install <path> [--out <file>] [--verbose]",
      "",
      "  --install, -i  Prism instance folder or the game directory itself.",
      "  --out, -o      Write the snapshot JSON here. Omit to only print the summary.",
      "  --verbose, -v  List every diagnostic entry instead of a capped sample.",
    ].join("\n"),
  );
  process.exit(code);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let snapshot: Snapshot;
  try {
    const install = locateInstall(resolve(args.install));
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

  process.exit(exitCode(snapshot));
}

function report(snapshot: Snapshot, verbose: boolean): void {
  const { registries, registryLists, diagnostics } = snapshot;

  const categories = Object.keys(registries).sort();
  const nameWidth = Math.max(...categories.map((c) => c.length), 8);
  let jarTotal = 0;
  let packTotal = 0;

  console.log(`${"category".padEnd(nameWidth)}  ${"jar".padStart(6)} ${"pack".padStart(6)} ${"merged".padStart(7)}`);
  for (const category of categories) {
    const entries = Object.values(registries[category]!);
    const fromJar = entries.filter((e) => e.source.kind === "jar").length;
    const fromPack = entries.length - fromJar;
    jarTotal += fromJar;
    packTotal += fromPack;
    console.log(
      `${category.padEnd(nameWidth)}  ${String(fromJar).padStart(6)} ${String(fromPack).padStart(6)} ${String(entries.length).padStart(7)}`,
    );
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
  logGroup("categories without a registry list", diagnostics.categoriesWithoutRegistryList, verbose, (c) => c);

  for (const warning of diagnostics.warnings) console.log(`  ! ${warning}`);
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
    d.parseFailures.length;
  return fatal > 0 ? 1 : 0;
}

main();
