/**
 * Builds a merged snapshot of every `mmorpg` registry from a Craft to Exile 2 install.
 *
 * Two datapack layers merge at runtime, keyed by entry id, with the pack winning:
 *   1. the Mine and Slash jar's default datapack   (`data/mmorpg/<category>/**.json`)
 *   2. each OpenLoader pack's overrides            (`<pack>/data/mmorpg/<category>/**.json`)
 *
 * Display names come from `assets/mmorpg/lang/en_us.json`, where the pack's resource zip
 * overrides the jar's copy.
 *
 * Design rule from the plan: **fail loud**. Unknown serializers, unknown modifier types
 * and unknown multiUseType values are collected as diagnostics rather than ignored,
 * because silently tolerating a schema change is how a calculator starts producing
 * confident wrong numbers after a pack update.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

import { parseLenient, type Repair } from "./lenient-json.js";
import type { Install } from "./locate.js";
import { ZipArchive } from "./zip.js";

/** Snapshot format version. Bump when the shape below changes incompatibly. */
export const SNAPSHOT_VERSION = 1;

const JAR_DATA_PREFIX = "data/mmorpg/";
const DEV_HELPER_PREFIX = "assets/mmorpg/modpack_dev_helper/";
const LANG_PATH = "assets/mmorpg/lang/en_us.json";

/** Stat serializers the engine knows how to interpret. Anything else is reported. */
const KNOWN_STAT_SERIALIZERS = new Set([
  "data",
  "core_stat",
  "vanilla_attribute_stat_ser",
  "one_to_other",
  "more_x_per_y",
  "bonus_stat_per_effect",
  "marker",
]);

/** The two values of Stat.MultiUseType in Mine and Slash. */
const KNOWN_MULTI_USE_TYPES = new Set(["MULTIPLY_STAT", "MULTIPLICATIVE_DAMAGE"]);

/**
 * Modifier types on a stat entry, mapping to InCalcStatData's Flat/Percent/Multi.
 *
 * Compared case-insensitively on purpose: `StatMod.type` is a plain `String`, resolved
 * through `ModType.fromString()`, which lowercases both sides. Craft to Exile 2 relies on
 * this — `mmorpg_affixes/chaos_stat/gear_corruptbow_trap.json` has `"flat"` and `"MORE"`
 * in the same `stats` array, and both work.
 *
 * The engine must replicate two things here: the case-insensitive match, and the fact
 * that `fromString` **falls back to FLAT** rather than failing when nothing matches — so
 * a typo'd type silently becomes a flat modifier in-game.
 */
const KNOWN_MODIFIER_TYPES = new Set(["flat", "percent", "more"]);

export type EntrySource = { kind: "jar" } | { kind: "pack"; packId: string };

export type RegistryEntry = {
  id: string;
  /** Path within its origin, for tracing a value back to a file. */
  origin: string;
  source: EntrySource;
  data: Record<string, unknown>;
};

export type Diagnostics = {
  /**
   * Registered stats with no JSON in either layer — implemented in Java only. These are
   * the ones whose behaviour must be ported from Mahjerion's source by hand, and they
   * include most of what matters (armor, dodge, resists, penetration, ailments, leech).
   */
  codeOnlyStats: string[];
  /** Stats whose `ser` the engine does not recognise. Must be empty to trust output. */
  unknownStatSerializers: { id: string; ser: string; origin: string }[];
  /** Unrecognised `multiUseType` values — would break the MORE routing rules. */
  unknownMultiUseTypes: { id: string; value: string; origin: string }[];
  /** Unrecognised stat-entry modifier types (expected FLAT / PERCENT / MORE). */
  unknownModifierTypes: { origin: string; stat: string; type: string }[];
  /**
   * Files whose declared id disagrees with their filename. The declared id is what the
   * registry uses, so these still load — but the filename is misleading to anyone
   * reading the pack, and a mismatch is usually an unnoticed typo.
   */
  idMismatches: { origin: string; declared: string; fromFilename: string }[];
  /** Two files in the same layer registering the same id; one silently shadows the other. */
  duplicateIds: { id: string; category: string; kept: string; shadowed: string }[];
  /** Files that needed Gson-leniency repairs, and which repairs. */
  lenientRepairs: { origin: string; repairs: Repair[] }[];
  /** Files that could not be parsed at all. */
  parseFailures: { origin: string; error: string }[];
  /** Categories present as JSON but absent from the dev-helper registry lists. */
  categoriesWithoutRegistryList: string[];
  /** Non-fatal environment notes, e.g. world datapacks that are not being merged. */
  warnings: string[];
};

export type Snapshot = {
  snapshotVersion: number;
  meta: {
    extractedAt: string;
    gameDir: string;
    mineAndSlashVersion: string;
    mineAndSlashJar: string;
    libraryOfExileJar: string | null;
    openLoaderPackIds: string[];
    resourceZips: string[];
  };
  /** category -> id -> entry */
  registries: Record<string, Record<string, RegistryEntry>>;
  /**
   * category -> registered ids, from `assets/mmorpg/modpack_dev_helper/*.txt`. This is
   * the mod's own authoritative list of default registry entries, including code-only
   * ones with no JSON, so it is what reveals the gap.
   */
  registryLists: Record<string, string[]>;
  lang: Record<string, string>;
  diagnostics: Diagnostics;
};

export function extract(install: Install): Snapshot {
  const diagnostics: Diagnostics = {
    codeOnlyStats: [],
    unknownStatSerializers: [],
    unknownMultiUseTypes: [],
    unknownModifierTypes: [],
    idMismatches: [],
    duplicateIds: [],
    lenientRepairs: [],
    parseFailures: [],
    categoriesWithoutRegistryList: [],
    warnings: [],
  };

  const registries: Record<string, Record<string, RegistryEntry>> = {};

  let registryLists: Record<string, string[]>;
  let lang: Record<string, string>;

  const jar = ZipArchive.open(install.mineAndSlashJar);
  try {
    readJarRegistries(jar, registries, diagnostics);
    registryLists = readRegistryLists(jar);
    lang = jar.has(LANG_PATH)
      ? parseLenient<Record<string, string>>(jar.readText(LANG_PATH), `jar!${LANG_PATH}`).value
      : {};
  } finally {
    jar.close();
  }

  // Pack overrides, in OpenLoader's load order. Later packs win over earlier ones.
  for (const pack of install.openLoaderPacks) {
    readPackRegistries(pack.id, pack.mmorpgDir, registries, diagnostics);
  }

  // The pack ships its own copy of the mod's lang file; it wins over the jar's.
  for (const zipPath of install.resourceZips) {
    const zip = ZipArchive.open(zipPath);
    try {
      if (!zip.has(LANG_PATH)) continue;
      const parsed = parseLenient<Record<string, string>>(zip.readText(LANG_PATH), `${zipPath}!${LANG_PATH}`);
      lang = { ...lang, ...parsed.value };
    } finally {
      zip.close();
    }
  }

  validate(registries, diagnostics);
  diagnostics.codeOnlyStats = findCodeOnlyStats(registries, registryLists);

  for (const category of Object.keys(registries)) {
    if (!(category in registryLists)) diagnostics.categoriesWithoutRegistryList.push(category);
  }

  if (install.worldDatapackDirs.length > 0) {
    diagnostics.warnings.push(
      `Found ${install.worldDatapackDirs.length} world datapack folder(s) which are NOT merged: ` +
        `${install.worldDatapackDirs.join(", ")}. Stats from world datapacks will be missing.`,
    );
  }

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    meta: {
      extractedAt: new Date().toISOString(),
      gameDir: install.gameDir,
      mineAndSlashVersion: install.mineAndSlashVersion,
      mineAndSlashJar: install.mineAndSlashJar,
      libraryOfExileJar: install.libraryOfExileJar,
      openLoaderPackIds: install.openLoaderPacks.map((p) => p.id),
      resourceZips: install.resourceZips,
    },
    registries,
    registryLists,
    lang,
    diagnostics,
  };
}

function readJarRegistries(
  jar: ZipArchive,
  registries: Record<string, Record<string, RegistryEntry>>,
  diagnostics: Diagnostics,
): void {
  for (const name of jar.find(JAR_DATA_PREFIX, ".json")) {
    const rest = name.slice(JAR_DATA_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // a stray file directly under data/mmorpg/
    const category = rest.slice(0, slash);

    let text: string;
    try {
      text = jar.readText(name);
    } catch (err) {
      diagnostics.parseFailures.push({ origin: name, error: asMessage(err) });
      continue;
    }
    const relPath = rest.slice(slash + 1, -".json".length);
    store(registries, diagnostics, category, name, relPath, text, { kind: "jar" });
  }
}

function readPackRegistries(
  packId: string,
  mmorpgDir: string,
  registries: Record<string, Record<string, RegistryEntry>>,
  diagnostics: Diagnostics,
): void {
  for (const category of readdirSync(mmorpgDir)) {
    // Skip tooling/editor directories that live alongside the data (e.g. `.claude`).
    if (category.startsWith(".")) continue;
    const categoryDir = join(mmorpgDir, category);
    if (!isDir(categoryDir)) continue;

    for (const file of walkJson(categoryDir)) {
      const origin = `${packId}:${relative(mmorpgDir, file).split(sep).join("/")}`;
      let text: string;
      try {
        text = readFileSync(file, "utf8").replace(/^﻿/, "");
      } catch (err) {
        diagnostics.parseFailures.push({ origin, error: asMessage(err) });
        continue;
      }
      const relPath = relative(categoryDir, file).split(sep).join("/").slice(0, -".json".length);
      store(registries, diagnostics, category, origin, relPath, text, {
        kind: "pack",
        packId,
      });
    }
  }
}

/**
 * @param relPath Category-relative path without the `.json` suffix, e.g.
 *   `0_8_elementalist/fireball`. Used as the key for vanilla-style categories.
 */
function store(
  registries: Record<string, Record<string, RegistryEntry>>,
  diagnostics: Diagnostics,
  category: string,
  origin: string,
  relPath: string,
  text: string,
  source: EntrySource,
): void {
  const fromFilename = relPath.slice(relPath.lastIndexOf("/") + 1);
  let data: Record<string, unknown>;
  try {
    const parsed = parseLenient<Record<string, unknown>>(text, origin);
    if (parsed.repairs.length > 0) {
      diagnostics.lenientRepairs.push({ origin, repairs: parsed.repairs });
    }
    data = parsed.value;
  } catch (err) {
    diagnostics.parseFailures.push({ origin, error: asMessage(err) });
    return;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    diagnostics.parseFailures.push({ origin, error: "expected a JSON object at the top level" });
    return;
  }

  // Library of Exile's ExileRegistryContainer keys entries by the object's GUID() — the
  // declared id/guid/identifier field — not by the file path. So the declared id is
  // authoritative, and a file whose name disagrees still registers under its declared id.
  // That matters for merging: `gear_corruptneckalce_all.json` declares
  // `gear_corruptnecklace_all`, and it is the latter that overrides the jar's entry.
  //
  // Resource-location ids are not a mismatch: `mmorpg_entity` entries are named after
  // entity ids ("minecraft:bee") whose separators cannot appear in a filename.
  // Entries with no declared id are not Exile registry objects at all — `recipes`,
  // `loot_tables`, `tags` and friends are plain vanilla datapack categories that happen
  // to sit under `data/mmorpg/`. Those are keyed by ResourceLocation, i.e. their
  // category-relative path, so `gems/amethyst/1` and `gems/azurite/1` stay distinct.
  const declared = declaredId(data);
  const key = declared ?? relPath;
  if (declared && normaliseId(declared) !== normaliseId(fromFilename)) {
    diagnostics.idMismatches.push({ origin, declared, fromFilename });
  }

  const bucket = (registries[category] ??= {});
  const previous = bucket[key];
  if (previous && previous.source.kind === source.kind) {
    // Two files in one layer claiming the same GUID. In-game this is silent:
    // BaseDataPackLoader.apply() ignores the ResourceLocation and calls
    // object.registerToExileRegistry(), so the last one parsed simply overwrites the
    // first, with no warning. Craft to Exile 2 has hundreds of these — most from
    // shipping a copy of the same entry at the category root and in a subfolder, with
    // differing content (e.g. mmorpg_spells/armageddon.json vs
    // mmorpg_spells/0_8_elementalist/armageddon.json).
    //
    // WHICH copy wins depends on Minecraft's resource iteration order, which this
    // extractor approximates with jar-then-pack, directory order within each. That
    // assumption is unverified and must be pinned against a ground-truth dump before
    // any number derived from a duplicated entry is trusted.
    diagnostics.duplicateIds.push({ id: key, category, kept: origin, shadowed: previous.origin });
  }
  bucket[key] = { id: key, origin, source, data };
}

/** Lowercases and folds resource-location separators so `minecraft:bee` == `minecraft_bee`. */
function normaliseId(id: string): string {
  return id.toLowerCase().replace(/[:/]/g, "_");
}

function declaredId(data: Record<string, unknown>): string | null {
  for (const key of ["id", "guid", "identifier"]) {
    const v = data[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const nested = data["data"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const v = (nested as Record<string, unknown>)["id"];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function readRegistryLists(jar: ZipArchive): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  for (const name of jar.find(DEV_HELPER_PREFIX, ".txt")) {
    const category = basename(name, ".txt");
    // Each file begins with two lines of prose ("These are all default registry
    // entries..."), then one id per line.
    const lines = jar
      .readText(name)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    lists[category] = lines.filter((l) => !l.startsWith("These are all") && !l.startsWith("This registry"));
  }
  return lists;
}

/**
 * Registered stats with no JSON representation anywhere. The dev-helper list covers the
 * mod's defaults only, so pack-added stats (which always have JSON) can't appear here.
 */
function findCodeOnlyStats(
  registries: Record<string, Record<string, RegistryEntry>>,
  registryLists: Record<string, string[]>,
): string[] {
  const registered = registryLists["mmorpg_stat"] ?? [];
  const withJson = new Set(Object.keys(registries["mmorpg_stat"] ?? {}));
  return registered.filter((id) => !withJson.has(id)).sort();
}

function validate(
  registries: Record<string, Record<string, RegistryEntry>>,
  diagnostics: Diagnostics,
): void {
  for (const entry of Object.values(registries["mmorpg_stat"] ?? {})) {
    const ser = entry.data["ser"];
    if (typeof ser === "string" && !KNOWN_STAT_SERIALIZERS.has(ser)) {
      diagnostics.unknownStatSerializers.push({ id: entry.id, ser, origin: entry.origin });
    }
    const mut = entry.data["multiUseType"];
    if (typeof mut === "string" && !KNOWN_MULTI_USE_TYPES.has(mut)) {
      diagnostics.unknownMultiUseTypes.push({ id: entry.id, value: mut, origin: entry.origin });
    }
  }

  // Stat modifier entries appear across perks, affixes, gems, uniques, effects and auras.
  // Walking every registry rather than a fixed list means a new content category is
  // checked automatically.
  for (const bucket of Object.values(registries)) {
    for (const entry of Object.values(bucket)) {
      forEachStatModifier(entry.data, (mod) => {
        if (!KNOWN_MODIFIER_TYPES.has(mod.type.toLowerCase())) {
          // Not fatal in-game — ModType.fromString silently yields FLAT — but it means
          // the author's intent was lost, so it is worth surfacing.
          diagnostics.unknownModifierTypes.push({
            origin: entry.origin,
            stat: mod.stat,
            type: mod.type,
          });
        }
      });
    }
  }
}

/** Visits every `{ type, stat, ... }` modifier object nested anywhere within `value`. */
export function forEachStatModifier(
  value: unknown,
  visit: (mod: { type: string; stat: string; node: Record<string, unknown> }) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) forEachStatModifier(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  if (typeof node["stat"] === "string" && typeof node["type"] === "string") {
    visit({ type: node["type"], stat: node["stat"], node });
  }
  for (const child of Object.values(node)) forEachStatModifier(child, visit);
}

function* walkJson(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (isDir(path)) {
      yield* walkJson(path);
    } else if (name.endsWith(".json")) {
      yield path;
    }
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
