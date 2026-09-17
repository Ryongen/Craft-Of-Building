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
import { registryLoadOrder } from "./registry-order.js";
import {
  fingerprintInstall,
  type Install,
  type InstallFingerprint,
  type PackNamespace,
} from "./locate.js";
import { openArchive, ZipArchive } from "./zip.js";

/** Snapshot format version. Bump when the shape below changes incompatibly. */
export const SNAPSHOT_VERSION = 2;

/** Every datapack namespace lives under this, in the jar and in an OpenLoader pack alike. */
const JAR_DATA_PREFIX = "data/";

/**
 * Mine and Slash's own namespace, which is the one every existing consumer knows about.
 *
 * It is named here for one reason only: its categories keep their bare key, so `mmorpg_spells`
 * stays `mmorpg_spells` and nothing downstream has to move. See `categoryKey`.
 */
const MMORPG_NAMESPACE = "mmorpg";
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
  /**
   * Two files registering the same id; one silently shadows the other. `kept` is the one the
   * game keeps, resolved with `registryLoadOrder` rather than guessed — see that module.
   */
  duplicateIds: { id: string; category: string; kept: string; shadowed: string }[];
  /** Files that needed Gson-leniency repairs, and which repairs. */
  lenientRepairs: { origin: string; repairs: Repair[] }[];
  /** Files that could not be parsed at all. */
  parseFailures: { origin: string; error: string }[];
  /**
   * One snapshot key claimed by two different `<namespace>/<category>` pairs.
   *
   * Fatal, because the effect is silent: two unrelated registries merge into one bucket and
   * whichever is registered last wins, with every consumer reading a category that is now part
   * someone else's. `categoryKey` is built not to produce these; this is the check that the
   * rule still holds against a pack nobody has seen yet, rather than an argument that it does.
   */
  categoryKeyCollisions: { key: string; claimedBy: string[] }[];
  /** Categories present as JSON but absent from the dev-helper registry lists. */
  categoriesWithoutRegistryList: string[];
  /**
   * Every namespace directory opened, and what came out of it.
   *
   * This is the inventory that makes "did this update bring something new?" answerable from
   * the snapshot alone, and it is what `tools/audit-port-coverage.mjs` diffs against the
   * install. Before it existed the extractor read one namespace and nothing anywhere recorded
   * that the others had not been looked at.
   */
  namespaces: NamespaceReport[];
  /** Non-fatal environment notes, e.g. world datapacks that are not being merged. */
  warnings: string[];
};

/** One namespace directory as the extractor found it. */
export type NamespaceReport = {
  /** `jar` for the Mine and Slash jar, otherwise the OpenLoader pack id. */
  layer: string;
  /** The `<ns>` in `data/<ns>/<category>/`. */
  namespace: string;
  /** Where it was read from — a zip path prefix, or an absolute directory. */
  origin: string;
  /** JSON files seen under it, across every category. */
  files: number;
  /** Each category under it, with the snapshot key it landed on and its file count. */
  categories: { category: string; key: string; files: number }[];
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
    resourcePacks: string[];
    /**
     * What the archives looked like when this was extracted, so a launch can notice the pack
     * has been updated underneath it. See `fingerprintsMatch`.
     */
    fingerprint: InstallFingerprint;
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
  /**
   * Config belonging to *other* mods that nonetheless decides Mine and Slash stats.
   *
   * `mmorpg_stat_compat` converts vanilla attributes into MnS stats, and in this pack the
   * biggest source of those attributes is Solonion's food-diversity benefits — a
   * `config/solonion.json`, not a datapack, so nothing else here would ever see it. Without
   * it a build planner cannot tell a player what eating more foods is worth.
   */
  externalConfig: {
    foodDiversity: FoodDiversityConfig | null;
    /**
     * Mine and Slash's own server config, which is not a datapack and so reaches nothing else
     * here. `in_combat_regen_multi` is the one the engine needs: the mod defaults it to 0.5 and
     * Craft to Exile 2 ships 1.0, and until this was read the app asked the player to type that
     * number in by hand from a file sitting in their install.
     */
    serverConfig: ServerConfig | null;
  };
  diagnostics: Diagnostics;
};

/**
 * `config/solonion.json` — benefits unlocked by eating N distinct foods.
 *
 * Each benefit is an attribute modifier that applies once its `threshold` is reached, and they
 * are cumulative: at 12 distinct foods every benefit with a threshold of 12 or less is active.
 * The `benefit` string is an SNBT blob rather than JSON, so it is parsed here into something
 * usable and the raw form kept alongside for anything this misses.
 */
export type FoodDiversityBenefit = {
  threshold: number;
  /** Attribute registry id, e.g. `kubejs:dodge`. */
  attributeId: string;
  /** `AttributeModifier.Operation` ordinal: 0 ADDITION, 1 MULTIPLY_BASE, 2 MULTIPLY_TOTAL. */
  operation: number;
  value: number;
  /** The unparsed `benefit` string, so nothing is silently dropped. */
  raw: string;
};

/**
 * `defaultconfigs/mine_and_slash-server.toml`, flattened.
 *
 * Kept as raw scalars keyed by their TOML name rather than a typed shape per option, because
 * the file carries a hundred-odd knobs and the engine reads a handful. `values` is the whole
 * file so a later reader needs no extractor change; the named getters live in `@cte2/schema`.
 */
export type ServerConfigValue = string | number | boolean | string[];

export type ServerConfig = {
  /** Absolute path the values came from. */
  origin: string;
  /** Every `key = value` pair, qualified by its `[section]` where it had one. */
  values: Record<string, ServerConfigValue>;
};

export type FoodDiversityConfig = {
  /** How many distinct foods the mod tracks at most. */
  trackCount: number;
  minFoodsToActivate: number;
  resetOnDeath: boolean;
  benefits: FoodDiversityBenefit[];
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
    categoryKeyCollisions: [],
    categoriesWithoutRegistryList: [],
    namespaces: [],
    warnings: [],
  };

  const registries: Record<string, Record<string, RegistryEntry>> = {};

  let registryLists: Record<string, string[]>;
  let lang: Record<string, string>;

  // Both layers are gathered before anything is registered, because which file wins a GUID
  // collision depends on the whole category's key set, not on the order files are read in.
  const pending = new PendingRegistries();

  const jar = ZipArchive.open(install.mineAndSlashJar);
  try {
    readJarRegistries(jar, pending, diagnostics);
    registryLists = readRegistryLists(jar);
    lang = jar.has(LANG_PATH)
      ? parseLenient<Record<string, string>>(jar.readText(LANG_PATH), `jar!${LANG_PATH}`).value
      : {};
  } finally {
    jar.close();
  }

  // Pack overrides, in OpenLoader's load order. Later packs win over earlier ones.
  for (const pack of install.openLoaderPacks) {
    for (const ns of pack.namespaces) {
      readPackRegistries(pack.id, ns, pending, diagnostics);
    }
  }

  pending.registerAll(registries, diagnostics);

  // The pack ships its own copy of the mod's lang file; it wins over the jar's.
  for (const packPath of install.resourcePacks) {
    const archive = openArchive(packPath);
    try {
      if (!archive.has(LANG_PATH)) continue;
      const parsed = parseLenient<Record<string, string>>(
        archive.readText(LANG_PATH),
        `${packPath}!${LANG_PATH}`,
      );
      lang = { ...lang, ...parsed.value };
    } finally {
      archive.close();
    }
  }

  if (install.resourcePacks.length === 0) {
    diagnostics.warnings.push(
      "No OpenLoader resource pack found under config/openloader/resources, so every display " +
        "name falls back to the Mine and Slash jar's. Craft to Exile 2 renames hundreds of stats " +
        "there (mana_cost -> \"Resource Cost\", plus_lvl_all_spells -> \"To All Skills\"), so " +
        "tooltips will not match the game.",
    );
  }

  validate(registries, diagnostics);
  diagnostics.codeOnlyStats = findCodeOnlyStats(registries, registryLists);

  findCategoryKeyCollisions(diagnostics);

  // Only *bare* keys are checked against the dev-helper lists. A qualified key is by
  // construction a vanilla datapack directory under a third-party namespace — `terralith:loot_tables`,
  // `botania:recipes` — and the mod's registry lists never described those, so reporting them
  // would bury the handful of real misses under 160 entries about other mods' loot.
  for (const category of Object.keys(registries)) {
    if (category.includes(":")) continue;
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
      resourcePacks: install.resourcePacks,
      fingerprint: fingerprintInstall(install),
    },
    registries,
    registryLists,
    lang,
    externalConfig: {
      foodDiversity: readFoodDiversity(install.gameDir),
      serverConfig: readServerConfig(install.gameDir),
    },
    diagnostics,
  };
}

type PendingFile = { origin: string; source: EntrySource; text: string };

/**
 * Every registry file found, keyed the way the game keys them, before any of it is parsed.
 *
 * Two layers collapse here exactly as `BaseDataPackLoader.prepare` collapses them: one entry
 * per ResourceLocation, with a datapack beating the mod jar at the same location. Only once
 * a category's full key set is known can `registryLoadOrder` say which of two files claiming
 * one GUID the game actually keeps — which is why parsing is deferred to `registerAll`.
 */
class PendingRegistries {
  /** category -> resource path (no `.json`) -> the file that wins that path. */
  private readonly byCategory = new Map<string, Map<string, PendingFile>>();

  add(category: string, relPath: string, file: PendingFile): void {
    let paths = this.byCategory.get(category);
    if (!paths) {
      paths = new Map();
      this.byCategory.set(category, paths);
    }
    // Same resource location in both layers: the pack wins, mirroring LoE's preference for
    // the highest non-built-in pack. Later packs also beat earlier ones, as they are added
    // in OpenLoader's load order.
    const previous = paths.get(relPath);
    if (previous && previous.source.kind === "pack" && file.source.kind === "jar") return;
    paths.set(relPath, file);
  }

  registerAll(
    registries: Record<string, Record<string, RegistryEntry>>,
    diagnostics: Diagnostics,
  ): void {
    for (const [category, paths] of this.byCategory) {
      for (const relPath of registryLoadOrder([...paths.keys()])) {
        const file = paths.get(relPath)!;
        store(registries, diagnostics, category, file.origin, relPath, file.text, file.source);
      }
    }
  }
}

/**
 * The snapshot key for a category found under `namespace`.
 *
 * Three rules, in order, and each earns its place:
 *
 *   - `mmorpg` categories keep their bare key. `mmorpg_spells` stays `mmorpg_spells`, and so do
 *     the vanilla dirs that happen to sit beside them (`recipes`, `tags`, `loot_tables`), so no
 *     existing consumer moves.
 *   - a category already prefixed with its own namespace keeps its bare key too, because the
 *     sibling mods name their registry folders that way: `library_of_exile/library_of_exile_relic_stat`.
 *     Qualifying that would give `library_of_exile:library_of_exile_relic_stat`, which stops it
 *     matching its own dev-helper registry list and reads as a stutter.
 *   - anything else is qualified, because the vanilla categories repeat. `tags`, `structures`,
 *     `recipes` and `loot_tables` each appear under several namespaces, and an unqualified key
 *     would have them silently shadow one another.
 *
 * A category named exactly after its namespace is deliberately *not* a third rule. Letting
 * `data/curios/curios/` through bare collided it with `data/mmorpg/curios/`, quietly merging
 * two unrelated registries — which is what `categoryKeyCollisions` now exists to catch rather
 * than to be reasoned about.
 */
export function categoryKey(namespace: string, category: string): string {
  if (namespace === MMORPG_NAMESPACE) return category;
  if (category.startsWith(`${namespace}_`)) return category;
  return `${namespace}:${category}`;
}

/** Accumulates per-category file counts for one namespace, for the inventory. */
class NamespaceTally {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly layer: string,
    private readonly namespace: string,
    private readonly origin: string,
  ) {}

  count(category: string): void {
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
  }

  report(): NamespaceReport {
    const categories = [...this.counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, files]) => ({
        category,
        key: categoryKey(this.namespace, category),
        files,
      }));
    return {
      layer: this.layer,
      namespace: this.namespace,
      origin: this.origin,
      files: categories.reduce((n, c) => n + c.files, 0),
      categories,
    };
  }
}

/**
 * Two namespaces writing one snapshot key, found from the inventory rather than from the
 * merge — so it reports the *pair* that collided, which is what tells you which rule to fix.
 */
function findCategoryKeyCollisions(diagnostics: Diagnostics): void {
  const claims = new Map<string, Set<string>>();
  for (const ns of diagnostics.namespaces) {
    for (const category of ns.categories) {
      let set = claims.get(category.key);
      if (!set) {
        set = new Set();
        claims.set(category.key, set);
      }
      set.add(`${ns.namespace}/${category.category}`);
    }
  }
  for (const [key, claimedBy] of claims) {
    if (claimedBy.size > 1) {
      diagnostics.categoryKeyCollisions.push({ key, claimedBy: [...claimedBy].sort() });
    }
  }
}

function readJarRegistries(
  jar: ZipArchive,
  pending: PendingRegistries,
  diagnostics: Diagnostics,
): void {
  const tallies = new Map<string, NamespaceTally>();

  for (const name of jar.find(JAR_DATA_PREFIX, ".json")) {
    const parts = name.slice(JAR_DATA_PREFIX.length).split("/");
    // `data/<namespace>/<category>/<path…>.json`. Anything shallower is not a registry entry —
    // a stray file directly under a namespace has no category to belong to.
    if (parts.length < 3) continue;
    const namespace = parts[0]!;
    const category = parts[1]!;

    let text: string;
    try {
      text = jar.readText(name);
    } catch (err) {
      diagnostics.parseFailures.push({ origin: name, error: asMessage(err) });
      continue;
    }

    let tally = tallies.get(namespace);
    if (!tally) {
      tally = new NamespaceTally("jar", namespace, `${JAR_DATA_PREFIX}${namespace}/`);
      tallies.set(namespace, tally);
    }
    tally.count(category);

    const relPath = parts.slice(2).join("/").slice(0, -".json".length);
    pending.add(categoryKey(namespace, category), relPath, {
      origin: name,
      source: { kind: "jar" },
      text,
    });
  }

  for (const tally of tallies.values()) diagnostics.namespaces.push(tally.report());
}

function readPackRegistries(
  packId: string,
  ns: PackNamespace,
  pending: PendingRegistries,
  diagnostics: Diagnostics,
): void {
  const tally = new NamespaceTally(packId, ns.namespace, ns.dir);

  for (const category of readdirSync(ns.dir)) {
    // Skip tooling/editor directories that live alongside the data.
    if (category.startsWith(".")) continue;
    const categoryDir = join(ns.dir, category);
    if (!isDir(categoryDir)) continue;

    for (const file of walkJson(categoryDir)) {
      // Origins stay relative to the namespace directory, and only a non-`mmorpg` one names
      // itself. That keeps every existing origin string byte-identical — they appear in the
      // diagnostics a user reads — while still telling two `tags/` folders apart.
      const within = relative(ns.dir, file).split(sep).join("/");
      const origin =
        ns.namespace === MMORPG_NAMESPACE
          ? `${packId}:${within}`
          : `${packId}:${ns.namespace}/${within}`;

      let text: string;
      try {
        text = readFileSync(file, "utf8").replace(/^﻿/, "");
      } catch (err) {
        diagnostics.parseFailures.push({ origin, error: asMessage(err) });
        continue;
      }
      tally.count(category);
      const relPath = relative(categoryDir, file).split(sep).join("/").slice(0, -".json".length);
      pending.add(categoryKey(ns.namespace, category), relPath, {
        origin,
        source: { kind: "pack", packId },
        text,
      });
    }
  }

  diagnostics.namespaces.push(tally.report());
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
  if (previous) {
    // Two files claiming the same GUID from different resource locations. In-game this is
    // silent: BaseDataPackLoader.apply() ignores the ResourceLocation and calls
    // object.registerToExileRegistry(), so the last one it iterates simply overwrites the
    // first, with no warning. Craft to Exile 2 has hundreds of these — most from shipping a
    // copy of the same entry at the category root and in a subfolder, with differing content
    // (e.g. mmorpg_spells/armageddon.json vs mmorpg_spells/0_8_elementalist/armageddon.json).
    //
    // Callers reach `store` in `registryLoadOrder`, which puts the deepest path last, so
    // overwriting here lands on the copy the game uses rather than on whichever file happened
    // to be walked last. `kept` is therefore accurate, and the entry is still reported because
    // a pack shipping two versions of one item is nearly always an accident worth seeing.
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
 * Registered stats with no JSON representation anywhere.
 *
 * This is a floor, not the full set. The dev-helper list covers the mod's defaults only, and
 * some Java stats are registered *per entry of a datapack registry* — `LearnSpellStat` is one
 * per spell — so a pack that adds spells adds code-only stats that appear in neither the list
 * nor `mmorpg_stat`. Craft to Exile 2 adds 143 that way. Finding those needs the Java, so
 * `@cte2/engine` expands them at load rather than the extractor guessing here.
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

/**
 * Reads `config/solonion.json` if the pack ships one.
 *
 * The `benefit` values are SNBT, not JSON — `{key:"kubejs:dodge",op:0,type:"att",val:1.0d}` —
 * so they are pulled apart with a pattern rather than parsed. Anything that does not match is
 * kept as `raw` with an empty `attributeId`, so it shows up as unhandled instead of vanishing.
 * A missing file is not an error: most installs will not have this mod.
 */
/**
 * `defaultconfigs/mine_and_slash-server.toml`.
 *
 * Not a datapack, so nothing else in this extractor would ever see it — and the engine needs
 * it. `in_combat_regen_multi` multiplies every regen tick while you are in combat, the mod
 * defaults it to 0.5, Craft to Exile 2 ships 1.0, and until this reader existed the app asked
 * the player to type that number in by hand from a file already sitting in their install.
 * `gear_compatibility` is the other one worth having: it maps real item ids onto Mine and
 * Slash gear slots, which is how a vanilla iron sword counts as a `sword`.
 *
 * This parses the subset Forge's TOML writer actually emits — `[section]` headers, one
 * `key = value` per line, scalars and single-level string arrays — rather than pulling in a
 * TOML dependency for a flat file. Anything it cannot read is skipped rather than guessed at,
 * and every value is kept, so a later reader needs a schema change and not an extractor one.
 */
function readServerConfig(gameDir: string): ServerConfig | null {
  const path = join(gameDir, "defaultconfigs", "mine_and_slash-server.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseServerConfigToml(text, path);
}

/** The parse half of `readServerConfig`, split out so it can be tested without an install. */
export function parseServerConfigToml(text: string, origin: string): ServerConfig {
  const values: Record<string, ServerConfigValue> = {};
  let section = "";

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      const close = line.indexOf("]");
      if (close < 0) continue;
      // `[general."Default Feature Configs"]` — dotted, and a segment may be quoted.
      section = line
        .slice(1, close)
        .split(".")
        .map((part) => part.trim().replace(/^"|"$/g, ""))
        .join(".");
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    if (key === "") continue;
    let raw = line.slice(eq + 1).trim();

    // An array may wrap across lines. Forge does not emit it that way today, which is exactly
    // why it is worth tolerating: a hand-edited config should not silently lose a value.
    if (raw.startsWith("[") && !raw.endsWith("]")) {
      while (i + 1 < lines.length && !raw.endsWith("]")) {
        i++;
        raw += " " + (lines[i] ?? "").trim();
      }
    }

    const value = parseTomlValue(raw);
    if (value !== undefined) values[section ? `${section}.${key}` : key] = value;
  }

  return { origin, values };
}

/** One TOML scalar or string array. `undefined` for anything this subset does not cover. */
function parseTomlValue(raw: string): ServerConfigValue | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1);
    const out: string[] = [];
    for (const match of inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      out.push((match[1] ?? "").replace(/\\(.)/g, "$1"));
    }
    return out;
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return Number(raw);

  return undefined;
}

function readFoodDiversity(gameDir: string): FoodDiversityConfig | null {
  const path = join(gameDir, "config", "solonion.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  const list = Array.isArray(root["benefits"]) ? root["benefits"] : [];
  const benefits: FoodDiversityBenefit[] = [];
  for (const node of list) {
    if (node === null || typeof node !== "object") continue;
    const b = node as Record<string, unknown>;
    const threshold = typeof b["threshold"] === "number" ? b["threshold"] : 0;
    const text = typeof b["benefit"] === "string" ? b["benefit"] : "";
    const m = /key:"([^"]+)".*?op:(\d+).*?val:(-?[\d.]+)/.exec(text);
    benefits.push({
      threshold,
      attributeId: m ? m[1]! : "",
      operation: m ? Number(m[2]) : 0,
      value: m ? Number(m[3]) : 0,
      raw: text,
    });
  }

  return {
    trackCount: typeof root["trackCount"] === "number" ? root["trackCount"] : 0,
    minFoodsToActivate: typeof root["minFoodsToActivate"] === "number" ? root["minFoodsToActivate"] : 0,
    resetOnDeath: root["resetOnDeath"] === true,
    benefits,
  };
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

/**
 * Every Minecraft item id a gear base can roll as, for the item-icon pass.
 *
 * `possible_items` is a weighted list per base — 171 distinct ids across five namespaces in
 * this pack — and they belong to other mods, which is why resolving their sprites needs the
 * whole of `mods/` rather than just Mine and Slash.
 */
export function gearItemIds(snapshot: Snapshot): string[] {
  const ids = new Set<string>();
  for (const entry of Object.values(snapshot.registries["mmorpg_base_gear_types"] ?? {})) {
    const items = entry.data["possible_items"];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const id = (item as Record<string, unknown>)["item_id"];
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return [...ids].sort();
}
