/**
 * Copies the GUI textures out of a Craft to Exile 2 install.
 *
 * The snapshot carries icon *references* and nothing else: a perk says
 * `"icon": "mmorpg:textures/gui/stat_icons/main/accuracy.png"`, and the PNG that names lives
 * inside the mod jar. A planner that renders the talent tree needs those bitmaps, so this is
 * the second half of extraction — same inputs, same merge rule, different payload.
 *
 * ## Scope: `assets/mmorpg/textures/gui`, plus two item folders
 *
 * Measured against Mine and Slash `1.20.1-6.4.7` plus pack `2.0.2`, the GUI subtree is 1,323
 * PNGs totalling 0.73 MB in the jar, with 363 overriding files in the pack's `resources.zip`.
 * It covers every icon the registries reference — 810 distinct paths across `stat_icons/`,
 * `talent_icons/`, `spells/icons/`, `spells/passives/` and `asc_classes/`.
 *
 * Two icon sets a planner needs are **not** under `gui/` and were being missed entirely. They
 * are not GUI textures because in Mine and Slash they are *items*, and the game draws the item:
 *
 *   - `textures/item/mob_effects/<id>.png` — an exile effect's icon.
 *     `ExileEffect.getTexture()` is `SlashRef.id("textures/item/mob_effects/" + GUID() + ".png")`,
 *     read off the 6.4.13 jar's constant pool rather than the fork. 37 of the pack's 212 effects
 *     ship one; the rest have no icon of their own in any layer, and a caller has to fall back.
 *   - `textures/item/skill_gems/{skill,support,aura}/<style>.png` — the three gem items, by
 *     `PlayStyle` rather than by id. There is no per-gem or per-Augment texture anywhere: every
 *     Fortify gem in the game is the same green gem, and that is the icon to draw.
 *
 * 46 files and 23 KB between them, so the cost of taking the whole of both folders is nothing
 * against the cost of guessing which ids will exist next patch.
 *
 * Item textures are the second pass, in `item-icons.ts`. Gear bases point at items belonging
 * to other mods (`roe_weapons:bow_3`, `cte_essentials:cloth_0_boots`), so those do mean walking
 * every jar in `mods/` — 171 distinct ids across five namespaces in this pack. They are worth
 * it: without them the Items tab has nothing to draw but text.
 *
 * Stat icons need nothing from here at all — `mmorpg_stat.icon` is one of five unicode glyphs
 * (`★ ⚔ ➹ ❁ 🌀`), not a path, and is rendered as text.
 *
 * ## Nothing extracted is redistributable
 *
 * These are Mine and Slash's assets, read out of the player's own install into the git-ignored
 * `data/`, exactly as the snapshot is. The same rule applies: the app extracts on first run and
 * ships none of it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { resolveItemIcons } from "./item-icons.js";
import type { Install } from "./locate.js";
import { openArchive, type ResourceArchive } from "./zip.js";

export const ASSET_INDEX_VERSION = 3;

/**
 * The archive subtrees copied, and the relative root each is filed under.
 *
 * The relative root is what lands on disk and what the index is keyed by, so **an existing one
 * must never move**: a key that changes spelling is indistinguishable from a texture the pack
 * dropped, and the app would render `unknown.png` for every icon it used to find. `gui/` keeps
 * the bare relative path it has always had (`stat_icons/main/accuracy.png`); the two item
 * folders are filed under `item/`, which no GUI texture can collide with because the jar has no
 * `textures/gui/item/` at all — checked, not assumed.
 *
 * The version above is bumped with this list. An index written before an entry was added is not
 * wrong about what it holds, it is merely short, and the number is how the app tells "this pack
 * ships no icon" from "you have not re-extracted since". See the `--assets` note in the CLI.
 */
const SUBTREES: readonly { archive: string; relative: string }[] = [
  { archive: "assets/mmorpg/textures/gui/", relative: "" },
  { archive: "assets/mmorpg/textures/item/mob_effects/", relative: "item/mob_effects/" },
  { archive: "assets/mmorpg/textures/item/skill_gems/", relative: "item/skill_gems/" },
];

/** The namespaced form a registry entry refers to a texture by. */
const RESOURCE_PREFIX = "mmorpg:textures/";

/** `gui/stat_icons/...` for a GUI texture, `item/mob_effects/...` for an effect icon. */
function resourceKey(relative: string): string {
  return RESOURCE_PREFIX + (relative.startsWith("item/") ? relative : `gui/${relative}`);
}

/**
 * The placeholder Mine and Slash ships for exactly this case.
 *
 * 51 of the pack's perk icons name a PNG that is in no archive at all — not the jar, not the
 * resource pack, not under any other path. They render as the missing-texture square in game,
 * and a planner should render this instead of an empty cell.
 */
export const UNKNOWN_ICON = "mmorpg:textures/gui/talent_icons/unknown.png";

export type AssetSource = { kind: "jar" } | { kind: "pack"; zip: string };

export type AssetIndex = {
  version: number;
  /**
   * Item id -> path relative to the asset directory, for gear sprites resolved out of other
   * mods' jars. Separate from `assets` because these are keyed on an item id, not a
   * `namespace:textures/...` resource path.
   */
  items: Record<string, string>;
  /**
   * Resource path -> path relative to the asset directory, using forward slashes.
   *
   *     "mmorpg:textures/gui/stat_icons/main/accuracy.png" -> "stat_icons/main/accuracy.png"
   */
  assets: Record<string, string>;
  /** Which layer each asset came from, for the same provenance reason entries have `source`. */
  sources: Record<string, AssetSource>;
};

export type AssetResult = {
  index: AssetIndex;
  /** Absolute path of the directory written to. */
  outDir: string;
  written: number;
  /** How many jar textures a resource pack replaced. */
  overridden: number;
  bytes: number;
  /** Gear item ids no sprite could be resolved for — reported, never guessed at. */
  unresolvedItems: string[];
};

export type AssetOptions = {
  /**
   * Gear item ids to resolve sprites for, from `mmorpg_base_gear_types[].possible_items`.
   * Omitted, the item pass is skipped entirely and the jars in `mods/` are never opened.
   */
  itemIds?: readonly string[];
};

/**
 * Reads every GUI texture from the jar, then lets each resource pack override it, and writes
 * the result plus an `index.json` under `outDir`.
 *
 * The override order matches `extract()`'s handling of `lang`: the jar is the base layer and
 * packs are applied in the order `locateInstall` lists them, last one winning. That is what
 * the game does with resource packs, and it is why the pack's 363 files are not simply added.
 */
export function extractAssets(
  install: Install,
  outDir: string,
  options: AssetOptions = {},
): AssetResult {
  const files = new Map<string, { bytes: Buffer; source: AssetSource }>();

  readInto(files, install.mineAndSlashJar, { kind: "jar" });

  let overridden = 0;
  for (const pack of install.resourcePacks) {
    overridden += readInto(files, pack, { kind: "pack", zip: pack });
  }

  const assets: Record<string, string> = {};
  const sources: Record<string, AssetSource> = {};
  let bytes = 0;

  for (const [relative, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(outDir, ...relative.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);

    assets[resourceKey(relative)] = relative;
    sources[resourceKey(relative)] = file.source;
    bytes += file.bytes.length;
  }

  // Item sprites come from every jar in `mods/`, with the resource packs applied on top so a
  // pack retexturing a weapon wins, exactly as it does in game.
  const itemIcons = resolveItemIcons(
    [...install.modJars, ...install.resourcePacks],
    options.itemIds ?? [],
    (relative, png) => {
      const target = join(outDir, ...relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, png);
    },
  );
  bytes += itemIcons.bytes;

  const index: AssetIndex = {
    version: ASSET_INDEX_VERSION,
    assets,
    items: itemIcons.icons,
    sources,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2), "utf8");

  return {
    index,
    outDir,
    written: files.size + Object.keys(itemIcons.icons).length,
    overridden,
    bytes,
    unresolvedItems: itemIcons.unresolved,
  };
}

/** @returns how many entries this archive replaced rather than introduced. */
function readInto(
  files: Map<string, { bytes: Buffer; source: AssetSource }>,
  archivePath: string,
  source: AssetSource,
): number {
  const archive = openArchive(archivePath);
  let replaced = 0;
  try {
    for (const subtree of SUBTREES) {
      for (const name of archive.find(subtree.archive, ".png")) {
        const relative = subtree.relative + name.slice(subtree.archive.length);
        if (relative.length === subtree.relative.length) continue;
        if (files.has(relative)) replaced++;
        files.set(relative, { bytes: archive.read(name), source });
      }
    }
  } finally {
    archive.close();
  }
  return replaced;
}

/**
 * Resolves a registry `icon` field against an extracted asset directory.
 *
 * Returns `undefined` rather than a guess when the reference names a texture the extraction
 * did not produce — a caller that renders a placeholder is better off knowing it is one.
 */
export function resolveAsset(index: AssetIndex, resourcePath: string): string | undefined {
  const relative = index.assets[resourcePath];
  return relative === undefined ? undefined : relative;
}

/** The on-disk path of a resolved asset, for a caller that needs to read the bytes. */
export function assetPath(outDir: string, relative: string): string {
  return join(outDir, ...relative.split("/"));
}

/** Guards against a resource path escaping the asset directory. Used by the app's protocol. */
export function isSafeAssetPath(relative: string): boolean {
  if (relative.length === 0) return false;
  if (relative.includes("\0")) return false;
  const parts = relative.split(/[/\\]/);
  return !parts.some((part) => part === "" || part === "." || part === "..") && !relative.includes(sep + sep);
}
