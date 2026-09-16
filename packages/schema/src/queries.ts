/**
 * The "what can legally go here" layer over an extractor snapshot.
 *
 * Both the validator and (later) the app's item editor read their rules from here, so the
 * two can never drift into disagreeing about what a legal item is. Everything in this file
 * is derived from the snapshot at runtime — nothing is hardcoded that the data can answer.
 *
 * Where a rule comes from Java rather than JSON, the source is quoted at the call site and
 * attributed to mahjerion/Mine-And-Slash-Rework @ `1.20-Forge`, which is the fork Craft to
 * Exile 2 actually ships. Upstream (RobertSkalko) is ~340 commits behind and will give wrong
 * answers.
 */

import type { RegistryEntry, Snapshot } from "@cte2/extractor";

import type { AffixRoll, Item, OmenSetup, TreeKey } from "./build-doc.js";

export type MinMax = { min: number; max: number };

/**
 * Craft to Exile 2 runs "original" mode: it ships pack overrides for exactly
 * `original_balance` and `original_mode_player` and leaves the `compat_mode_*` entries at
 * their jar defaults. Both are overridable in case a future pack flips this.
 */
export const DEFAULT_BALANCE_ID = "original_balance";
export const DEFAULT_PLAYER_BASE_STATS_ID = "original_mode_player";

/**
 * `UniqueStatsData.MAX_STATS` — how many roll slots a unique's NBT always carries, regardless
 * of how many stats it actually has. `RerollNumbers` fills all ten; `GetAllStats` reads only
 * as many as the unique has stats. A five-stat unique therefore stores ten rolls, five of
 * which do nothing.
 */
export const UNIQUE_ROLL_SLOTS = 10;

/**
 * One option out of `defaultconfigs/mine_and_slash-server.toml`.
 *
 * The extractor keeps the whole file as raw scalars, so reading an option is a lookup rather
 * than an extractor change. Keys are qualified by their TOML section, which for this file is
 * `general` for everything that matters — `serverConfigNumber(snapshot, "general.in_combat_regen_multi")`.
 *
 * Returns `undefined` rather than a default when the file was not found or the key is not a
 * number, so the caller can say what its own fallback is and why.
 */
export function serverConfigNumber(snapshot: Snapshot, key: string): number | undefined {
  const value = snapshot.externalConfig?.serverConfig?.values[key];
  return typeof value === "number" ? value : undefined;
}

/** As `serverConfigNumber`, for a string-array option such as `general.gear_compatibility`. */
export function serverConfigList(snapshot: Snapshot, key: string): string[] | undefined {
  const value = snapshot.externalConfig?.serverConfig?.values[key];
  return Array.isArray(value) ? value : undefined;
}

export const CATEGORY = {
  affix: "mmorpg_affixes",
  aura: "mmorpg_aura",
  baseGearType: "mmorpg_base_gear_types",
  baseStats: "mmorpg_base_stats",
  exileEffect: "mmorpg_exile_effect",
  gameBalance: "mmorpg_game_balance",
  gearRarity: "mmorpg_gear_rarity",
  gearSlot: "mmorpg_gear_slot",
  itemSet: "mmorpg_sets",
  gem: "mmorpg_gems",
  mobRarity: "mmorpg_mob_rarity",
  omen: "mmorpg_omen",
  perk: "mmorpg_perk",
  rune: "mmorpg_runes",
  runeword: "mmorpg_runeword",
  spell: "mmorpg_spells",
  spellSchool: "mmorpg_spell_school",
  stat: "mmorpg_stat",
  statBuff: "mmorpg_stat_buff",
  statLayer: "mmorpg_stat_layer",
  statCompat: "mmorpg_stat_compat",
  statCondition: "mmorpg_stat_condition",
  statEffect: "mmorpg_stat_effect",
  supportGem: "mmorpg_support_gem",
  talentTree: "mmorpg_talent_tree",
  unique: "mmorpg_unique_gears",
  valueCalc: "mmorpg_value_calc",
} as const;

/** The ten `type` values seen across `mmorpg_affixes`. Anything else must fail loud. */
export const AFFIX_TYPES = [
  "prefix",
  "suffix",
  "implicit",
  "enchant",
  "chaos_stat",
  "jewel",
  "jewel_corruption",
  "crafted_jewel_unique",
  "watcher_eye",
  "tool",
] as const;

export type AffixType = (typeof AFFIX_TYPES)[number];

export function isAffixType(value: string): value is AffixType {
  return (AFFIX_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Snapshot access
// ---------------------------------------------------------------------------

export function entry(snapshot: Snapshot, category: string, id: string): RegistryEntry | undefined {
  return snapshot.registries[category]?.[id];
}

export function has(snapshot: Snapshot, category: string, id: string): boolean {
  return entry(snapshot, category, id) !== undefined;
}

export function ids(snapshot: Snapshot, category: string): string[] {
  return Object.keys(snapshot.registries[category] ?? {});
}

function data(snapshot: Snapshot, category: string, id: string): Record<string, unknown> | undefined {
  return entry(snapshot, category, id)?.data;
}

// Narrow readers. Registry data is `unknown`-valued, and a missing or wrongly-typed field
// should surface as a diagnostic rather than a crash or a silent zero.

function num(node: Record<string, unknown>, key: string, fallback: number): number {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function bool(node: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = node[key];
  return typeof v === "boolean" ? v : fallback;
}

function obj(node: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = node[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function arr(node: Record<string, unknown>, key: string): unknown[] {
  const v = node[key];
  return Array.isArray(v) ? v : [];
}

function minMax(node: Record<string, unknown> | undefined, fallback: MinMax): MinMax {
  if (!node) return fallback;
  return { min: num(node, "min", fallback.min), max: num(node, "max", fallback.max) };
}

// ---------------------------------------------------------------------------
// Gear rarity
// ---------------------------------------------------------------------------

export type GearRarityView = {
  id: string;
  itemTier: number;
  affixRarityWeight: number;
  isUniqueItem: boolean;
  /**
   * `GearRarityType` — `NORMAL`, `UNIQUE` or `RUNED`.
   *
   * A coarser grouping than the rarity itself, and the one omen set requirements are counted
   * over: the six ordinary rarities are all `NORMAL`, `runeword` is `RUNED` and `unique` is
   * `UNIQUE`. So "wear two NORMAL pieces" is satisfied by a common and a mythic alike.
   */
  type: string;
  /** `min_affixes`. Despite the name this is the *exact* affix count — see {@link affixCount}. */
  minAffixes: number;
  /** Roll band for affixes carrying this rarity as their tier. */
  statPercents: MinMax;
  /** Roll band for an item's base stats at this rarity. */
  baseStatPercents: MinMax;
  sockets: MinMax;
  maxGems: number;
  maxRunes: number;
  canHaveRunewords: boolean;
  minLvl: number;
};

export function gearRarity(snapshot: Snapshot, id: string): GearRarityView | undefined {
  const d = data(snapshot, CATEGORY.gearRarity, id);
  if (!d) return undefined;
  return {
    id,
    itemTier: num(d, "item_tier", 0),
    affixRarityWeight: num(d, "affix_rarity_weight", 0),
    isUniqueItem: bool(d, "is_unique_item", false),
    type: str(d, "type") ?? "NORMAL",
    minAffixes: num(d, "min_affixes", 0),
    statPercents: minMax(obj(d, "stat_percents"), { min: 0, max: 100 }),
    baseStatPercents: minMax(obj(d, "base_stat_percents"), { min: 0, max: 100 }),
    sockets: minMax(obj(d, "sockets"), { min: 0, max: 0 }),
    maxGems: num(d, "max_gems", 0),
    maxRunes: num(d, "max_runes", 0),
    canHaveRunewords: bool(d, "can_have_runewords", false),
    minLvl: num(d, "min_lvl", 0),
  };
}

/**
 * How many prefixes plus suffixes an item of this rarity has — exactly, not at least.
 *
 * `GearRarity.getAffixAmount()` returns `min_affixes`, and `GearAffixesData.randomize()`
 * tops the item up until it has that many:
 *
 *     int minaffixes = rar.min_affixes;
 *     int affixesToGen = minaffixes - (this.getNumberOfAffixes());
 *     while (affixesToGen > 0) { addOneRandomAffix(gear); affixesToGen--; }
 *
 * so the field name is misleading: it is a fixed count. common 1 -> mythic 6.
 */
export function affixCount(rarity: GearRarityView): number {
  return rarity.minAffixes;
}

/**
 * The most prefixes (or suffixes) a single item can carry.
 *
 * `IGearRarity.maximumOfOneAffixType()` is `getAffixAmount() / 2`, and `randomize()` seeds
 * that many of *each* type before topping up. But the top-up path does not re-check that
 * cap — `addOneRandomAffix()` only balances the two counts:
 *
 *     if (getNumberOfPrefixes() > getNumberOfSuffixes()) { ...suffix... } else { ...prefix... }
 *
 * so an odd `min_affixes` produces one more of the favoured type than
 * `maximumOfOneAffixType()` reports. Legendary (5) ends up 3 prefixes / 2 suffixes even
 * though the method returns 2. The observable ceiling is therefore the rounded-up half.
 */
export function maxOfOneAffixType(rarity: GearRarityView): number {
  return rarity.minAffixes - Math.floor(rarity.minAffixes / 2);
}

/**
 * The rarities an affix on this item may carry as its own tier.
 *
 *     var list = ExileDB.GearRarities()
 *         .getFilterWrapped(x -> !x.is_unique_item && rar.item_tier >= x.item_tier)
 *
 * — `AffixData.randomizeTier`. Note this is the *item's* rarity bounding the affix's, which
 * is why a mythic item can carry a common-tier affix but never the reverse.
 */
export function allowedAffixTiers(snapshot: Snapshot, itemRarity: GearRarityView): string[] {
  return ids(snapshot, CATEGORY.gearRarity)
    .map((id) => gearRarity(snapshot, id))
    .filter((r): r is GearRarityView => r !== undefined)
    .filter((r) => !r.isUniqueItem && itemRarity.itemTier >= r.itemTier)
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Base gear types and affixes
// ---------------------------------------------------------------------------

export type BaseGearTypeView = {
  id: string;
  gearSlot: string | undefined;
  tags: string[];
  /** Entries of `base_stats`, each a `{ type, stat, min, max }` modifier. */
  baseStats: Record<string, unknown>[];
  weaponType: string | undefined;
  /**
   * The Minecraft items this base can roll as, weakest first — `possible_items`, ordered by
   * the `min_rar` ladder the pack declares them in. The first is what a common item looks
   * like, which is the sensible sprite for a base with no rarity chosen yet.
   */
  itemIds: string[];
  /**
   * `BaseGearType.req` — what the character needs before the piece can be worn at all.
   *
   * `StatRequirement` keeps two maps and they scale differently. `scaling_req` is a fraction
   * put through `StatScaling.STAT_REQ` at the **item's** level, which is why an axe declaring
   * `strength: 0.4` asks for 80 strength at item level 100 and nothing worth mentioning at
   * level 1; `base_req` is the same number at every level. Both are then multiplied by the
   * server's `STAT_REQUIREMENTS_MULTIPLIER` and truncated to an int.
   *
   * Resolving the scaling half needs the balance curves, so it lives in the engine
   * (`gearRequirements`) rather than here — this is the declaration, not the number.
   */
  req: StatRequirementDecl;
};

/** The two halves of a `StatRequirement`, stat id to declared amount. */
export type StatRequirementDecl = {
  baseReq: Readonly<Record<string, number>>;
  scalingReq: Readonly<Record<string, number>>;
};

function numberMap(node: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(node ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function baseGearType(snapshot: Snapshot, id: string): BaseGearTypeView | undefined {
  const d = data(snapshot, CATEGORY.baseGearType, id);
  if (!d) return undefined;
  const tagNode = obj(d, "tags");
  return {
    id,
    gearSlot: str(d, "gear_slot"),
    tags: tagNode ? arr(tagNode, "tags").filter((t): t is string => typeof t === "string") : [],
    baseStats: arr(d, "base_stats").filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
    ),
    weaponType: str(d, "weapon_type"),
    itemIds: arr(d, "possible_items")
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
      .map((i) => i["item_id"])
      .filter((id): id is string => typeof id === "string"),
    req: {
      baseReq: numberMap(obj(obj(d, "req") ?? {}, "base_req")),
      scalingReq: numberMap(obj(obj(d, "req") ?? {}, "scaling_req")),
    },
  };
}

export type TagRequirement = {
  reqType: string;
  included: string[];
  excluded: string[];
};

export type AffixView = {
  id: string;
  type: string;
  tagRequirements: TagRequirement[];
  stats: Record<string, unknown>[];
  onlyOnePerItem: boolean;
  /** Non-empty means the affix belongs to a mutually exclusive group. */
  oneOfAKind: string;
  /**
   * `Affix.eye_aura_req` — the aura gem a Watcher's Eye line needs socketed before it counts.
   *
   * Only `watcher_eye` affixes set it; empty everywhere else. It is read off the affix rather
   * than off the jewel record because `StatsWhileUnderAuraData.getAura()` is
   * `ExileDB.AuraGems().get(getAffix().eye_aura_req)` — the record itself never names an aura.
   */
  eyeAuraReq: string;
};

export function affix(snapshot: Snapshot, id: string): AffixView | undefined {
  const d = data(snapshot, CATEGORY.affix, id);
  if (!d) return undefined;
  const reqs = obj(d, "requirements");
  return {
    id,
    type: str(d, "type") ?? "",
    tagRequirements: (reqs ? arr(reqs, "tag_requirements") : [])
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r))
      .map((r) => ({
        reqType: str(r, "req_type") ?? "",
        included: arr(r, "included").filter((t): t is string => typeof t === "string"),
        excluded: arr(r, "excluded").filter((t): t is string => typeof t === "string"),
      })),
    stats: arr(d, "stats").filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
    ),
    onlyOnePerItem: bool(d, "only_one_per_item", false),
    oneOfAKind: str(d, "one_of_a_kind") ?? "",
    eyeAuraReq: str(d, "eye_aura_req") ?? "",
  };
}

/**
 * Whether a set of tags satisfies one tag requirement.
 *
 * `TagRequirement.meetsRequierment()` checks exclusions first and returns false on any hit,
 * then applies the mode to the included list. Both `req_type` values are in use in this
 * pack: `INCLUDES_ANY` (438 affixes) and `HAS_ALL` (51).
 */
export function meetsTagRequirement(req: TagRequirement, tags: readonly string[]): boolean {
  for (const excluded of req.excluded) {
    if (tags.includes(excluded)) return false;
  }
  if (req.included.length === 0) return true;
  if (req.reqType === "HAS_ALL") return req.included.every((t) => tags.includes(t));
  if (req.reqType === "INCLUDES_ANY") return req.included.some((t) => tags.includes(t));
  // Unknown mode: refuse to guess. Callers surface this as a fail-loud diagnostic.
  return false;
}

export function isKnownReqType(reqType: string): boolean {
  return reqType === "HAS_ALL" || reqType === "INCLUDES_ANY";
}

/** All tag requirements must pass for the affix to be available on those tags. */
export function affixAllowedOnTags(view: AffixView, tags: readonly string[]): boolean {
  return view.tagRequirements.every((req) => meetsTagRequirement(req, tags));
}

/**
 * Every affix of `type` that can roll on `baseId` — the pool an item editor offers.
 *
 * Mirrors the filter in `AffixData.RerollFully`:
 *     x -> x.type == getAffixType() && gear.canGetAffix(x)
 */
export function affixesFor(snapshot: Snapshot, baseId: string, type: AffixType): AffixView[] {
  const base = baseGearType(snapshot, baseId);
  if (!base) return [];
  return ids(snapshot, CATEGORY.affix)
    .map((id) => affix(snapshot, id))
    .filter((a): a is AffixView => a !== undefined)
    .filter((a) => a.type === type && affixAllowedOnTags(a, base.tags));
}

export type UniqueView = {
  id: string;
  baseGear: string | undefined;
  minDropLvl: number;
  rarity: string | undefined;
  uniqueStats: Record<string, unknown>[];
};

export function unique(snapshot: Snapshot, id: string): UniqueView | undefined {
  const d = data(snapshot, CATEGORY.unique, id);
  if (!d) return undefined;
  return {
    id,
    baseGear: str(d, "base_gear"),
    minDropLvl: num(d, "min_drop_lvl", 0),
    rarity: str(d, "rarity"),
    uniqueStats: arr(d, "unique_stats").filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
    ),
  };
}

export function uniquesForBase(snapshot: Snapshot, baseId: string): UniqueView[] {
  return ids(snapshot, CATEGORY.unique)
    .map((id) => unique(snapshot, id))
    .filter((u): u is UniqueView => u !== undefined && u.baseGear === baseId);
}

export function basesForSlot(snapshot: Snapshot, slotId: string): BaseGearTypeView[] {
  return ids(snapshot, CATEGORY.baseGearType)
    .map((id) => baseGearType(snapshot, id))
    .filter((b): b is BaseGearTypeView => b !== undefined && b.gearSlot === slotId);
}

/** `gear_slot.fam`, e.g. "Armor" — the family a slot belongs to. */
export function slotFamily(snapshot: Snapshot, slotId: string): string | undefined {
  const d = data(snapshot, CATEGORY.gearSlot, slotId);
  return d ? str(d, "fam") : undefined;
}

// ---------------------------------------------------------------------------
// Talent trees
// ---------------------------------------------------------------------------

export type TreeCellKind = "empty" | "perk" | "connector" | "center";

export type TreeCell = {
  kind: TreeCellKind;
  /** The raw CSV token with its original case, for diagnostics. */
  raw: string;
  /** `raw` lowercased — what the game classifies and keys on (`GridPoint.java:29`). */
  id: string;
  /**
   * Set when `kind === "perk"`. The lowercased token. It may name no registered perk: the
   * game resolves that to `UnknownStat` (`TalentTree.CalcData.getPerk`) rather than dropping
   * the cell, so the node still exists and still costs a point.
   */
  perkId?: string;
  /** Set when `kind === "connector"` — the channel id, *not* a line direction. */
  glyph?: string;
};

export type TreeGrid = {
  id: string;
  rows: number;
  cols: number;
  cellAt(row: number, col: number): TreeCell | undefined;
  /** Number of cells that resolve to a perk — the allocatable positions. */
  perkCellCount: number;
  /** `[row, col]` of the single `[CENTER]` cell. A camera origin, never an allocation anchor. */
  center: readonly [number, number] | undefined;
  /** Perk tokens present in the grid that name no `mmorpg_perk` entry. */
  unknownPerkIds: readonly string[];
};

const CENTER_TOKEN = "[center]";

/**
 * Parses a tree's CSV grid, classifying cells exactly as `GridPoint.java:26-41` does.
 *
 *     this.id = str.toLowerCase(Locale.ROOT);
 *     if (id.length() == 1)                     { this.isConnector = true; }
 *     else if (id.equalsIgnoreCase(CENTER_ID))  { this.isCenter = true; }
 *     else if (id.length() > 2)                 { this.isTalent = true; }
 *
 * Three consequences the previous "is it a registered perk id" rule got wrong:
 *
 *   - **`E` is a connector, not empty.** It is a single character, so it classifies as a
 *     connector with glyph `"e"`. All 618 per tree form the border ring, which is what stops
 *     the game's unguarded `get(x ± 1, y ± 1)` from running off the array. They are isolated
 *     from every talent, so no edge is ever drawn along them — but the classification has to
 *     be right or the guard's purpose is invisible.
 *   - **A token of exactly two characters is nothing at all** — it falls through all three
 *     branches. There are none today; if a pack adds one it silently disappears in game too.
 *   - **A token longer than two characters is a talent whether or not it is registered.**
 *
 * Note the grids are not valid strict JSON in their source files — the `perks` value contains
 * raw newlines, which Gson tolerates. The extractor's lenient parser has already dealt with
 * that by the time a snapshot exists.
 */
/**
 * Cached per snapshot and tree id, including the `undefined` miss.
 *
 * The talents grid is 138 x 173 and the parse splits ~24,000 tokens. `collectPerks` calls this
 * once per tree per calculation, and an editor recalculates on every click. A `TreeGrid` closes
 * over an immutable array, so sharing is safe.
 */
const GRID_CACHE = new WeakMap<Snapshot, Map<string, TreeGrid | undefined>>();

export function treeGrid(snapshot: Snapshot, treeId: string): TreeGrid | undefined {
  let byId = GRID_CACHE.get(snapshot);
  if (!byId) {
    byId = new Map();
    GRID_CACHE.set(snapshot, byId);
  }
  if (byId.has(treeId)) return byId.get(treeId);

  const built = buildTreeGrid(snapshot, treeId);
  byId.set(treeId, built);
  return built;
}

function buildTreeGrid(snapshot: Snapshot, treeId: string): TreeGrid | undefined {
  const d = data(snapshot, CATEGORY.talentTree, treeId);
  if (!d) return undefined;
  const raw = d["perks"];
  if (typeof raw !== "string") return undefined;

  const perks = snapshot.registries[CATEGORY.perk] ?? {};
  let center: readonly [number, number] | undefined;
  const unknown = new Set<string>();

  const grid: TreeCell[][] = raw.split("\n").map((line, row) =>
    line.split(",").map((token, col): TreeCell => {
      const trimmed = token.trim();
      const id = trimmed.toLowerCase();
      if (id.length === 1) return { kind: "connector", raw: trimmed, id, glyph: id };
      if (id === CENTER_TOKEN) {
        center ??= [row, col];
        return { kind: "center", raw: trimmed, id };
      }
      if (id.length > 2) {
        if (!(id in perks)) unknown.add(id);
        return { kind: "perk", raw: trimmed, id, perkId: id };
      }
      return { kind: "empty", raw: trimmed, id };
    }),
  );

  let perkCellCount = 0;
  for (const row of grid) {
    for (const cell of row) if (cell.kind === "perk") perkCellCount++;
  }

  return {
    id: treeId,
    rows: grid.length,
    cols: grid.reduce((max, row) => Math.max(max, row.length), 0),
    cellAt: (row, col) => grid[row]?.[col],
    perkCellCount,
    center,
    unknownPerkIds: [...unknown].sort(),
  };
}

export type PerkView = {
  id: string;
  /** `STAT` | `SPECIAL` | `MAJOR` | `ASC` | `START`. Drives the node glyph and border texture. */
  type: string;
  /**
   * An entry perk may be allocated with nothing else allocated — it is a starting node.
   * `TalentsData.canAllocate` skips the adjacency requirement for exactly these.
   */
  isEntry: boolean;
  /**
   * Mutual-exclusion group. At most one allocated perk per group per tree
   * (`TalentsData.java:74-78`). This is what makes "pick one class" a rule rather than a
   * convention: all six `START` perks share `"start"`, all sixteen `ASC` ones share
   * `"ascendancy"`.
   */
  oneKind: string | undefined;
  maxLevels: number;
  icon: string;
};

export function perk(snapshot: Snapshot, id: string): PerkView | undefined {
  const d = data(snapshot, CATEGORY.perk, id);
  if (!d) return undefined;
  return {
    id,
    type: str(d, "type") ?? "STAT",
    isEntry: d["is_entry"] === true,
    // `str` already collapses "" to undefined, which matches the game's
    // `one_kind != null && !one_kind.isEmpty()` guard.
    oneKind: str(d, "one_kind"),
    maxLevels: num(d, "max_lvls", 1),
    icon: str(d, "icon") ?? "",
  };
}

/** Every perk carrying `one_kind === kind`, e.g. the sixteen ascendancy entry perks. */
export function perksOfKind(snapshot: Snapshot, kind: string): string[] {
  return ids(snapshot, CATEGORY.perk)
    .filter((id) => perk(snapshot, id)?.oneKind === kind)
    .sort();
}

export type PointBudget = {
  /** `base_points + points_per_lvl * level`, capped at `max_total_points`. */
  fromLevel: number;
  /** Points obtainable outside levelling (quests, items). The tool cannot see these. */
  maxBonus: number;
  maxTotal: number;
  /** The most a character at this level could possibly have spent. */
  ceiling: number;
};

/**
 * `player_points` key for each tree, matching the tree's own `school_type`.
 *
 * Exported because the app's point counters need the same mapping to ask
 * {@link pointsAvailable} about a tree, and two copies of it is how the tree screen and the
 * validator would drift apart again.
 */
export const TREE_POINT_TYPE: Record<TreeKey, PlayerPointType> = {
  talents: "TALENTS",
  ascendancy: "ASCENDANCY",
  atlas: "ATLAS",
};

/**
 * Point budget for a tree at a given level, from `mmorpg_game_balance.player_points`.
 *
 * `maxBonus` is included in `ceiling` because bonus points come from sources a build
 * document does not record. Spending more than `fromLevel` is therefore suspicious rather
 * than impossible, and the validator reports it as a warning.
 *
 * A tree's pool is just one of the six `PlayerPointsType` keys, so this is
 * {@link playerPointBudget} with the tree's name looked up. It stays as its own function
 * because `TreeKey` is what every caller on the tree side already holds.
 */
export function pointBudget(
  snapshot: Snapshot,
  tree: TreeKey,
  level: number,
  balanceId: string = DEFAULT_BALANCE_ID,
): PointBudget | undefined {
  return playerPointBudget(snapshot, TREE_POINT_TYPE[tree], level, balanceId);
}

export function maxLevel(snapshot: Snapshot, balanceId: string = DEFAULT_BALANCE_ID): number {
  const d = data(snapshot, CATEGORY.gameBalance, balanceId);
  return d ? num(d, "MAX_LEVEL", 100) : 100;
}

/**
 * `GameBalanceConfig.MAX_BONUS_SPELL_LEVELS` — how many ranks above a spell's own `max_lvl`
 * gear and perks may push it.
 *
 *     for (InsertedSpell spell : this.spells) {
 *         spell.bonus_ranks = MathHelper.clamp(spell.bonus_ranks, 0, GameBalanceConfig.get().MAX_BONUS_SPELL_LEVELS);
 *         spell.rank += spell.bonus_ranks;
 *     }
 *
 * — SpellCastingData.calcSpellLevels:135-139. The jar default is 5; `original_balance`, which
 * this pack runs, sets **8**. `@cte2/engine`'s `Balance` reads the same field for
 * `LeveledValue` interpolation — this copy exists so the validator does not need an engine.
 */
export function maxBonusSpellLevels(
  snapshot: Snapshot,
  balanceId: string = DEFAULT_BALANCE_ID,
): number {
  const d = data(snapshot, CATEGORY.gameBalance, balanceId);
  return d ? num(d, "MAX_BONUS_SPELL_LEVELS", 5) : 5;
}

// ---------------------------------------------------------------------------
// Two-handed weapons
// ---------------------------------------------------------------------------

/**
 * The tag Craft to Exile 2 marks two-handed bases with.
 *
 * It appears **nowhere in the Mine and Slash source** — grep the 1.20-Forge checkout and there
 * is no `two_handed`, no `TwoHand`, nothing. It is a pure pack tag, carried by exactly three
 * bases (`greatsword`, `scythe`, `spear`) and read by 29 affixes as a roll requirement.
 *
 * The behaviour the player sees comes from **Better Combat**, not from the mod this project
 * otherwise ports. `net.bettercombat.mixin.PlayerEntityMixin.getEquippedStack_Pre` intercepts
 * every `getItemBySlot` call and, when the slot asked for is `OFFHAND` and either the selected
 * mainhand stack or the offhand stack carries two-handed weapon attributes, sets the return
 * value to `ItemStack.EMPTY` and cancels. Mine and Slash's `GearData` then reads an empty
 * offhand like any other, so an offhand item contributes *nothing at all* while a two-handed
 * weapon is held — not a partial penalty, and not merely a UI-level block.
 *
 * The two systems only agree because the pack makes them agree, which is worth recording since
 * a pack update could break it: the jar ships `bettercombat:staff` and `bettercombat:hammer` as
 * `two_handed: true`, and `cte_configuration` overrides both to `false`; RoE's spear items point
 * at `bettercombat:trident` (`two_handed: false`) and the same datapack repoints `spear_0..7` to
 * `bettercombat:spear` (`true`). After those overrides the Better Combat set and the tag set are
 * the same three bases.
 *
 * The consequence for this file is the happy one: two-handedness is answerable from the
 * snapshot the extractor already produces, with no Better Combat parsing anywhere.
 */
export const TWO_HANDED_TAG = "two_handed";

/** Whether this base occupies both hands, and so suppresses the offhand entirely. */
export function isTwoHanded(snapshot: Snapshot, baseId: string): boolean {
  return baseGearType(snapshot, baseId)?.tags.includes(TWO_HANDED_TAG) ?? false;
}

// ---------------------------------------------------------------------------
// Slot occupancy
// ---------------------------------------------------------------------------

/**
 * How many items may share one gear slot.
 *
 * Phase 0.5 left this open ("how many items share a gear slot (two rings?) is not in the
 * datapack... Left unchecked rather than invented") and the gear panel has carried a banner
 * saying so ever since. It *is* answerable — just not from the datapack.
 * `characters/CharacterEquipment.java` lays out a character's worn loadout explicitly, because
 * switching characters has to move every worn stack somewhere:
 *
 *     VANILLA_SLOTS = HEAD, CHEST, LEGS, FEET, OFFHAND      // indices 0-4
 *     CURIO_BLOCKS  = RING(base 5, count 2),
 *                     NECKLACE(base 7, count 1),
 *                     OMEN(base 8, count 1)
 *     public static final int SIZE = 9; // 4 armor + offhand + 2 rings + necklace + omen
 *
 * Two things that list settles beyond the counts:
 *
 *   - **The mainhand is not in it.** The file's header says the inventory and the mainhand are
 *     "deliberately left alone" — a weapon is the held item, so there is exactly one of it, and
 *     it does not travel with the character.
 *   - **Curios is not the wrong tree to be barking up.** The phase 0.5 note that Curios' "only
 *     registered slot here is `master_bag`" pointed the wrong way: `RefCurios` also registers
 *     `ring`, `omen` and `necklace`, and `GearSlot.isItemOfThisSlot` resolves both jewellery
 *     slots through `CuriosApi.getCuriosHelper().getCurioTags(item)`.
 *
 * Keyed by `mmorpg_gear_slot` id. A slot absent from this map has **no known capacity** and is
 * deliberately not guessed: `elytra` and `head` are pack-added `Jewelry`-family slots matching
 * no block in `CURIO_BLOCKS`, so how many a character may wear is genuinely unanswered and
 * {@link slotCapacity} returns `undefined` rather than inventing a 1.
 */
export const SLOT_CAPACITY: Readonly<Record<string, number>> = {
  helmet: 1,
  chest: 1,
  pants: 1,
  boots: 1,
  necklace: 1,
  ring: 2,
};

/**
 * The capacity of one `mmorpg_gear_slot`, or `undefined` when the mod does not say.
 *
 * Weapon and offhand slots are families — a character has one mainhand and one offhand, and
 * which *kind* fills it is the player's choice — so the limit belongs to the family rather than
 * to `sword` or `shield` individually. Ask {@link slotFamilyCapacity} for those.
 */
export function slotCapacity(slotId: string): number | undefined {
  return SLOT_CAPACITY[slotId];
}

/**
 * Capacity per `SlotFamily`, for the two families where the family is the real limit.
 *
 * `Weapon` is the mainhand and `OffHand` is `EquipmentSlot.OFFHAND`: one each, whichever base
 * fills it. `Armor` and `Jewelry` are per-slot instead ({@link SLOT_CAPACITY}), because a
 * character wears four separate armour pieces and three separate jewels.
 */
export const FAMILY_CAPACITY: Readonly<Record<string, number>> = {
  Weapon: 1,
  OffHand: 1,
};

export function slotFamilyCapacity(family: string): number | undefined {
  return FAMILY_CAPACITY[family];
}

// ---------------------------------------------------------------------------
// Sockets: gems, runes and runewords
// ---------------------------------------------------------------------------

/**
 * Which of a socketable's three stat lists applies, from the base's `SlotFamily`.
 *
 * `Gem.getFor` and `Rune.getFor` are the same four lines:
 *
 *     if (fam == SlotFamily.Weapon)  return on_weapons_stats;
 *     if (fam == SlotFamily.Jewelry) return on_jewelry_stats;
 *     return on_armor_stats;
 *
 * — so **the offhand takes the armour list**, because `OffHand` matches neither of the first
 * two. That is not an oversight to correct; a shield socketed with a ruby really does grant
 * the armour line.
 */
export type SocketFamily = "Weapon" | "Jewelry" | "Armor";

export function socketFamily(family: string | undefined): SocketFamily {
  if (family === "Weapon") return "Weapon";
  if (family === "Jewelry") return "Jewelry";
  return "Armor";
}

/** The family a gear base's socketables resolve against. */
export function socketFamilyOfBase(snapshot: Snapshot, baseId: string): SocketFamily {
  const slot = baseGearType(snapshot, baseId)?.gearSlot;
  return socketFamily(slot === undefined ? undefined : slotFamily(snapshot, slot));
}

type FamilyStats = {
  onWeapons: Record<string, unknown>[];
  onJewelry: Record<string, unknown>[];
  onArmor: Record<string, unknown>[];
};

function modList(node: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return arr(node, key).filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
  );
}

function familyStats(d: Record<string, unknown>): FamilyStats {
  return {
    onWeapons: modList(d, "on_weapons_stats"),
    onJewelry: modList(d, "on_jewelry_stats"),
    onArmor: modList(d, "on_armor_stats"),
  };
}

/** `getFor(fam)` over an already-read view. */
export function statsForFamily(view: FamilyStats, family: SocketFamily): Record<string, unknown>[] {
  if (family === "Weapon") return view.onWeapons;
  if (family === "Jewelry") return view.onJewelry;
  return view.onArmor;
}

export type GemView = FamilyStats & {
  id: string;
  /** `amethyst`, `ruby`, ... — the half of the name a player reads as the gem's colour. */
  gemType: string;
  /** 0-7, and the other half of the name: Cracked through Pinnacle. */
  tier: number;
  /** The gem's own rarity, for colouring. Not a roll band — a gem does not roll. */
  rarity: string;
  minLvlMulti: number;
};

export function gem(snapshot: Snapshot, id: string): GemView | undefined {
  const d = data(snapshot, CATEGORY.gem, id);
  if (!d) return undefined;
  return {
    id,
    gemType: str(d, "gem_type") ?? id,
    tier: num(d, "tier", 0),
    rarity: str(d, "rar") ?? "common",
    minLvlMulti: num(d, "min_lvl_multi", 0),
    ...familyStats(d),
  };
}

export type RuneView = FamilyStats & {
  id: string;
  tier: number;
  minLvlMulti: number;
  /** `uses_unlucky_ran` — whether inserting it rolls twice and keeps the worse. */
  usesUnluckyRan: boolean;
};

export function rune(snapshot: Snapshot, id: string): RuneView | undefined {
  const d = data(snapshot, CATEGORY.rune, id);
  if (!d) return undefined;
  return {
    id,
    tier: num(d, "tier", 0),
    minLvlMulti: num(d, "min_lvl_multi", 0),
    usesUnluckyRan: bool(d, "uses_unlucky_ran", false),
    ...familyStats(d),
  };
}

export type RunewordView = {
  id: string;
  /** The rune ids, **in order**. See {@link runewordMatches}. */
  runes: string[];
  /** `mmorpg_gear_slot` ids this runeword may be made on. */
  slots: string[];
  /** `{ type, stat, min, max }` rolled once, at `GearSocketsData.rp`, at the item's level. */
  stats: Record<string, unknown>[];
};

export function runeword(snapshot: Snapshot, id: string): RunewordView | undefined {
  const d = data(snapshot, CATEGORY.runeword, id);
  if (!d) return undefined;
  return {
    id,
    runes: arr(d, "runes").filter((r): r is string => typeof r === "string"),
    slots: arr(d, "slots").filter((s): s is string => typeof s === "string"),
    stats: modList(d, "stats"),
  };
}

/**
 * `RuneWord.canApplyOnItem(GearItemData)` — one line, and it is the *slot*, not the family.
 *
 *     return slots.stream().anyMatch(x -> gear.GetBaseGearType().gear_slot.equals(x));
 *
 * So a runeword listing `chest` goes on a chest and nothing else, and a picker that offered it
 * for a helmet would be offering an item the game cannot make.
 */
export function runewordFitsBase(snapshot: Snapshot, view: RunewordView, baseId: string): boolean {
  const slot = baseGearType(snapshot, baseId)?.gearSlot;
  return slot !== undefined && view.slots.includes(slot);
}

/**
 * Every runeword this item could carry: the rarity must allow runewords at all, and the base's
 * slot must be one the runeword names. Sorted by rune count, longest first, because that is the
 * order `RuneItem` itself resolves ties in — it takes the biggest match.
 */
export function runewordsForItem(
  snapshot: Snapshot,
  baseId: string,
  rarity: GearRarityView | undefined,
): RunewordView[] {
  if (rarity !== undefined && !rarity.canHaveRunewords) return [];
  return ids(snapshot, CATEGORY.runeword)
    .map((id) => runeword(snapshot, id))
    .filter((r): r is RunewordView => r !== undefined && r.runes.length > 0)
    .filter((r) => runewordFitsBase(snapshot, r, baseId))
    .sort((a, b) => b.runes.length - a.runes.length || a.id.localeCompare(b.id));
}

/**
 * `RuneWord.hasMatchingRunesToCreate` — and it is a **substring** test, not a set test:
 *
 *     String reqString  = join(runes, "");
 *     String testString = join(socketed.map(x -> x.g), "");
 *     return testString.contains(reqString);
 *
 * The socketed ids are concatenated in socket order and the runeword's the same way, so the
 * runes must appear consecutively and in the declared order. `ano`+`net`+`mos` completes
 * Abyssal Depths; `net`+`ano`+`mos` does not.
 *
 * Concatenating ids is the mod's own trick and it is as fragile as it looks — this reproduces
 * it exactly rather than improving on it, because a planner that accepted an order the game
 * rejects would be describing an item nobody can build.
 */
export function runewordMatches(view: RunewordView, socketedRunes: readonly string[]): boolean {
  return socketedRunes.join("").includes(view.runes.join(""));
}

// ---------------------------------------------------------------------------
// Uniques
// ---------------------------------------------------------------------------

/**
 * Every unique in the snapshot, sorted by id.
 *
 * {@link uniquesForBase} answers "what can this base become"; this answers "what uniques
 * exist", which is what a picker wants when the player is choosing the unique *first* and
 * expects the base to follow from it.
 */
export function allUniques(snapshot: Snapshot): UniqueView[] {
  return ids(snapshot, CATEGORY.unique)
    .map((id) => unique(snapshot, id))
    .filter((u): u is UniqueView => u !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The gear rarity a unique item takes.
 *
 * `UniqueGear.rarity` names it when present; otherwise the single rarity carrying
 * `is_unique_item` is the only thing it can be. That flag is what `AffixData.randomizeTier`
 * filters *out* of the affix tier pool, so there is exactly one in this pack (`unique`) and
 * falling back to it is a lookup rather than a guess.
 */
export function uniqueRarityId(snapshot: Snapshot, view: UniqueView): string | undefined {
  if (view.rarity !== undefined && has(snapshot, CATEGORY.gearRarity, view.rarity)) {
    return view.rarity;
  }
  return ids(snapshot, CATEGORY.gearRarity).find((id) => gearRarity(snapshot, id)?.isUniqueItem);
}

// ---------------------------------------------------------------------------
// Core stats and the stat point budget
// ---------------------------------------------------------------------------

/**
 * The serializer id every allocatable core stat carries.
 *
 * `AllocateStatPacket.onReceived` rejects anything that is not a `CoreStat`:
 *
 *     // unregistered ids fall back to EmptyStat, so this also rejects a made up stat id
 *     if (!(ExileDB.Stats().get(stat) instanceof CoreStat)) { return; }
 *
 * and `CoreStat.SER_ID` is `"core_stat"`. In this pack that is exactly `strength`, `dexterity`
 * and `intelligence`. The 20 `bonus_stat_per_effect` stats carry a `core_stat_data` block too
 * and are *not* `CoreStat` instances, so matching on the serializer rather than on the presence
 * of that block is what keeps `aoe_per_power_charge` out of the allocation screen.
 */
export const CORE_STAT_SER = "core_stat";

/** The stats a level-up point may be spent on, derived rather than hardcoded. */
export function coreStatIds(snapshot: Snapshot): string[] {
  return ids(snapshot, CATEGORY.stat)
    .filter((id) => entry(snapshot, CATEGORY.stat, id)?.data?.["ser"] === CORE_STAT_SER)
    .sort();
}

/**
 * The stat point budget at a level, from `mmorpg_game_balance.player_points.STATS`.
 *
 * Same shape and same arithmetic as {@link pointBudget}, which only covers the three trees:
 * `PlayerPointsType.getFreePoints` is one method serving all six point types.
 *
 *     int current = data.base_points + (int) (lvl * data.points_per_lvl);
 *     int total   = current + bonus;
 *     if (total > data.max_total_points) { total = data.max_total_points; }
 *     int free = total - getPointsInUse(p);
 *
 * For `STATS` in `original_balance` that is `0 + 1 * lvl`, capped at 300, with up to 50 bonus
 * points from sources a build document cannot see — hence `ceiling` above `fromLevel`, and a
 * warning rather than an error when a document spends into that band.
 */
/**
 * Every key of `player_points`, which is `PlayerPointsType` in the game.
 *
 * `pointBudget` covers the three that are trees; spell schools spend from `SPELLS` and
 * `PASSIVES`, which belong to no tree, so the general form is the one to reach for.
 */
export const PLAYER_POINT_TYPES = [
  "TALENTS",
  "ASCENDANCY",
  "ATLAS",
  "SPELLS",
  "PASSIVES",
  "STATS",
] as const;
export type PlayerPointType = (typeof PLAYER_POINT_TYPES)[number];

/**
 * The budget for any point pool, from `mmorpg_game_balance.player_points`.
 *
 *     int current = data.base_points + (int) (lvl * data.points_per_lvl);
 *     int total = Math.min(current + getBonusPoints(p), data.max_total_points);
 *
 * `getBonusPoints` is quest and item rewards, which no document can derive — so `fromLevel` is
 * what levelling alone grants and `ceiling` is what a character could conceivably hold.
 */
/**
 * Bonus points Craft to Exile 2 actually hands out, where the balance file's cap is not it.
 *
 * `max_bonus_points` is a *ceiling on* `getBonusPoints`, not a statement of how many the pack
 * awards, and for `ATLAS` the two are far apart: the balance file carries the mod's own
 * `PlayerPointsConfig(ATLAS, 0, 0, 200, 200)` (GeneratedData.java:132) while the points
 * themselves come one at a time from dungeon-realm atlas nodes —
 * `pd.points.get(ATLAS).giveBonusPoints(node.atlas_points_reward)` — and the pack's real total is
 * **104**. Left at 200 a planner offered twice the atlas tree anyone can allocate, and the
 * validator would not have called 150 points illegal.
 *
 * **Stated, not derived**, and deliberately: summing `atlas_points_reward` over the 151 entries
 * of `dungeon_realm_atlas_node` gives 117, or 90 once the uber-gated nine are removed, and
 * neither is 104 — which node is reachable depends on the atlas grid's own connectivity and on
 * progression this snapshot does not describe. So it is a number read off the game, carried here
 * the way {@link PACK_IN_COMBAT_REGEN_MULTI} carries the server config's, rather than a
 * derivation that happens to be wrong.
 *
 * `TALENTS` and `ASCENDANCY` need no entry: 101 from levelling + 25 bonus is the 126 the game
 * reports at level 100, and `ASCENDANCY`'s 0 + 9 is 9. Both are confirmed against
 * `character.pointTotals` on the 2026-09-17 capture.
 */
export const PACK_MAX_BONUS_POINTS: Partial<Record<PlayerPointType, number>> = {
  ATLAS: 104,
};

export function playerPointBudget(
  snapshot: Snapshot,
  type: PlayerPointType,
  level: number,
  balanceId: string = DEFAULT_BALANCE_ID,
): PointBudget | undefined {
  const d = data(snapshot, CATEGORY.gameBalance, balanceId);
  if (!d) return undefined;
  const points = obj(d, "player_points");
  const node = points ? obj(points, type) : undefined;
  if (!node) return undefined;

  const maxTotal = num(node, "max_total_points", 0);
  // The pack's own number wins where there is one, and never raises the balance file's cap:
  // an override is a statement about what this pack awards, not a licence to exceed the mod.
  const declaredBonus = num(node, "max_bonus_points", 0);
  const override = PACK_MAX_BONUS_POINTS[type];
  const maxBonus = override === undefined ? declaredBonus : Math.min(override, declaredBonus);
  const fromLevel = Math.min(
    Math.floor(num(node, "base_points", 0) + num(node, "points_per_lvl", 0) * level),
    maxTotal,
  );
  return { fromLevel, maxBonus, maxTotal, ceiling: Math.min(fromLevel + maxBonus, maxTotal) };
}

/**
 * How many points of a pool this character actually has.
 *
 * The one question every spend check and every counter in the app is really asking, and it has
 * two answers depending on what the document knows.
 *
 *     int total = Math.min(current + getBonusPoints(p), data.max_total_points);
 *
 * `getBonusPoints` is quest and item rewards. Nothing derivable from a level reaches it, so a
 * document that was written by hand can only say what levelling grants and treat the rest as
 * *possible*. A document the companion mod produced records the finished number in
 * `character.pointTotals`, straight off `PlayerPointsType.getFreePoints` — and where that is
 * present it is not a better estimate, it is the answer, so it wins outright.
 *
 * Reading it in one place is what keeps the validator and the three point counters in the app
 * agreeing. They did not: the Classes tab honoured `pointTotals` while the tree and stat
 * screens re-derived a ceiling from the level, so every real capture opened with three
 * "needs bonus points" warnings against an allocation the game itself had just reported as
 * legal.
 */
export type PointsAvailable = {
  /** What the character has to spend. */
  total: number;
  /** True when `total` is the game's own count rather than a level-derived floor. */
  recorded: boolean;
  /** The level-derived budget, or undefined when the balance file has no entry for the pool. */
  budget: PointBudget | undefined;
};

export function pointsAvailable(
  snapshot: Snapshot,
  character: { level: number; pointTotals?: Record<string, number> },
  type: PlayerPointType,
  balanceId: string = DEFAULT_BALANCE_ID,
): PointsAvailable {
  const budget = playerPointBudget(snapshot, type, character.level, balanceId);
  const recorded = character.pointTotals?.[type];
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) {
    return { total: Math.floor(recorded), recorded: true, budget };
  }
  return { total: budget?.fromLevel ?? 0, recorded: false, budget };
}

/** `points_per_lvl` for a pool — the SPELLS one drives the per-level cost of a school perk. */
export function pointsPerLevel(
  snapshot: Snapshot,
  type: PlayerPointType,
  balanceId: string = DEFAULT_BALANCE_ID,
): number {
  const d = data(snapshot, CATEGORY.gameBalance, balanceId);
  const points = d ? obj(d, "player_points") : undefined;
  const node = points ? obj(points, type) : undefined;
  return node ? num(node, "points_per_lvl", 0) : 0;
}

export function statPointBudget(
  snapshot: Snapshot,
  level: number,
  balanceId: string = DEFAULT_BALANCE_ID,
): PointBudget | undefined {
  return playerPointBudget(snapshot, "STATS", level, balanceId);
}

// ---------------------------------------------------------------------------
// Omens
// ---------------------------------------------------------------------------

/**
 * The three `GearRarityType` values omen requirements are counted over.
 *
 * Not the rarities themselves: `common` through `mythic` are all `NORMAL`, `runeword` is
 * `RUNED` and `unique` is `UNIQUE`. So a requirement for two `NORMAL` pieces is met by a
 * common and a mythic together.
 */
export const GEAR_RARITY_TYPES = ["NORMAL", "UNIQUE", "RUNED"] as const;

export type GearRarityTypeName = (typeof GEAR_RARITY_TYPES)[number];

export function isGearRarityType(value: string): value is GearRarityTypeName {
  return (GEAR_RARITY_TYPES as readonly string[]).includes(value);
}

export type OmenView = {
  id: string;
  /**
   * `Omen.lvl_req`, a **fraction of `MAX_LEVEL`**, not a level.
   *
   *     ExileDB.Omens().getFilterWrapped(x -> lvl >= GameBalanceConfig.get().MAX_LEVEL * x.lvl_req)
   *
   * — `OmenPart.DroppableOmens`. All nine in this pack are `0.5`, so they start dropping at
   * level 50. Reading it as a level would have made every omen legal from level 1.
   */
  levelRequirementFraction: number;
  /** `Omen.mods` — the set's payout, as ranges resolved by the derived stat percent. */
  mods: Record<string, unknown>[];
  /** `Omen.affix_types` — which `Affix.AffixSlot`s may sit on it. `chaos_stat` throughout. */
  affixTypes: string[];
};

export function omen(snapshot: Snapshot, id: string): OmenView | undefined {
  const d = data(snapshot, CATEGORY.omen, id);
  if (!d) return undefined;
  return {
    id,
    levelRequirementFraction: num(d, "lvl_req", 0),
    mods: arr(d, "mods").filter(
      (m): m is Record<string, unknown> => m !== null && typeof m === "object" && !Array.isArray(m),
    ),
    affixTypes: arr(d, "affix_types").filter((t): t is string => typeof t === "string"),
  };
}

export function omenIds(snapshot: Snapshot): string[] {
  return ids(snapshot, CATEGORY.omen).sort();
}

/** The level an omen starts dropping at: `MAX_LEVEL * lvl_req`, per `OmenPart`. */
export function omenMinLevel(
  snapshot: Snapshot,
  view: OmenView,
  balanceId: string = DEFAULT_BALANCE_ID,
): number {
  return Math.ceil(maxLevel(snapshot, balanceId) * view.levelRequirementFraction);
}

/**
 * The roll percent an omen's own mods resolve at — earned from its requirements, never rolled.
 *
 *     public static int getStatPercent(HashMap<GearRarityType, Integer> rarities,
 *                                      List<OmenSlotReq> slot_req, GearRarity rar) {
 *         int num = 0;
 *         for (Map.Entry<GearRarityType, Integer> en : rarities.entrySet()) {
 *             num += en.getValue() * 10;
 *         }
 *         num += slot_req.size() * 10;
 *         num *= rar.omens.stat_multi;
 *         return num;
 *     }
 *
 * — `OmenData.java`, whose own comment is "the more difficult the omen is to assemble, the
 * more stats it provides".
 *
 * Two details that are behaviour rather than tidiness, and are reproduced rather than fixed:
 *
 *  - **The multiply truncates.** `num` is an `int` and `stat_multi` a `float`, so Java's
 *    compound assignment narrows: `70 * 1.25` is 87, not 87.5.
 *  - **Nothing clamps it to 100.** `ExactStatData.fromStatModifier` is a bare
 *    `min + (max - min) * percent / 100F`, so a heavily-conditioned mythic omen reaching 125
 *    puts its stats a quarter above the declared maximum. That is what the game does.
 */
export function omenStatPercent(
  snapshot: Snapshot,
  requires: Readonly<Record<string, number>> | undefined,
  slotRequirementCount: number,
  rarityId: string,
): number {
  let num = 0;
  for (const count of Object.values(requires ?? {})) {
    if (Number.isFinite(count)) num += count * 10;
  }
  num += slotRequirementCount * 10;

  const multi = omenStatMulti(snapshot, rarityId);
  // Java narrows the float back into the int on `num *= multi`, truncating toward zero.
  return Math.trunc(num * multi);
}

/** `GearRarity.omens.stat_multi` — the difficulty payout scalar for a rarity. */
export function omenStatMulti(snapshot: Snapshot, rarityId: string): number {
  const d = data(snapshot, CATEGORY.gearRarity, rarityId);
  const omens = d ? obj(d, "omens") : undefined;
  return omens ? num(omens, "stat_multi", 1) : 1;
}

/**
 * How many worn pieces count toward the omen — `PlayerData.omensFilled`.
 *
 * Ported from `OmenData.calcPiecesEquipped`, which is subtler than it looks:
 *
 *     for (GearData gear : Load.Unit(p).equipmentCache.getGear()) {
 *         if (gear.gear != null) {
 *             var type = gear.gear.getRarity().type;
 *             boolean has = true;
 *             for (OmenSlotReq slot : slot_req) {
 *                 String gearslot = gear.gear.GetBaseGearType().gear_slot;
 *                 if (slot.slot.equals(gearslot)) { if (type != slot.rtype) { has = false; } }
 *             }
 *             if (has) {
 *                 if (map.getOrDefault(type, 0) < rarities.getOrDefault(type, 0)) {
 *                     map.put(type, map.getOrDefault(type, 0) + 1);
 *                 }
 *             }
 *         }
 *     }
 *
 * Three consequences worth naming:
 *
 *  - **A slot requirement disqualifies, it does not add.** A piece in a named slot whose type
 *    does not match stops counting entirely; a piece in a slot nobody named is unaffected.
 *  - **Each type is capped at what the omen asked for.** Six `NORMAL` pieces against a
 *    requirement of two contribute two. So the count cannot exceed the threshold, which is
 *    what makes "all buckets at or below `fill`" a sensible payout rule.
 *  - **A type the omen did not ask for contributes nothing**, because the cap it is compared
 *    against is `getOrDefault(type, 0)` — zero.
 *
 * And the piece list itself excludes the mainhand. `CachedEntityStats.recalcGears` collects
 * `CHEST, FEET, LEGS, HEAD, OFFHAND` plus every curio slot, with the weapon tracked separately
 * in `recalcWeapon` — the mod's own source carries the note
 * `// todo note somewhere the weapon isnt included in omen counting`. It also filters on
 * `isUsableBy`, so a piece above the character's level is not worn as far as this is concerned.
 */
export function countOmenPieces(
  snapshot: Snapshot,
  items: readonly Item[],
  omenSetup: OmenSetup,
  characterLevel: number,
): number {
  const required = omenSetup.requires ?? {};
  const slotReqs = omenSetup.slotRequirements ?? [];
  const counted = new Map<string, number>();

  for (const item of items) {
    const base = baseGearType(snapshot, item.base);
    const slotId = base?.gearSlot;
    if (slotId === undefined) continue;

    // `recalcGears` never looks at the mainhand, so a weapon can never satisfy an omen.
    if (!omenCountsSlot(snapshot, slotId)) continue;

    // `isUsableBy` refuses an item above the holder's level, and `getGear()` filters on it.
    if (item.itemLevel > characterLevel) continue;

    const type = gearRarity(snapshot, item.rarity)?.type;
    if (type === undefined) continue;

    const disqualified = slotReqs.some((req) => req.slot === slotId && req.rarityType !== type);
    if (disqualified) continue;

    const already = counted.get(type) ?? 0;
    if (already < (required[type] ?? 0)) counted.set(type, already + 1);
  }

  let total = 0;
  for (const count of counted.values()) total += count;
  return total;
}

/**
 * Whether a gear slot is one the omen counter can see.
 *
 * Armour, the offhand and the jewellery curios — everything in `recalcGears` except the
 * mainhand, which is `recalcWeapon`'s. Expressed through `slotFamily` rather than a list of
 * slot ids so a pack-added armour slot is included without an edit here.
 */
export function omenCountsSlot(snapshot: Snapshot, slotId: string): boolean {
  const family = slotFamily(snapshot, slotId);
  return family === "Armor" || family === "OffHand" || family === "Jewelry";
}

/**
 * The payout buckets, keyed by how many pieces each needs — `OmenSet`'s constructor.
 *
 * The omen's own mods sit at the full requirement; each affix unlocks one piece earlier, with
 * `if (index < 2) { index = 2; }` flooring it. That floor is a real collision: an omen with
 * more affixes than its requirement has room for stacks the surplus onto bucket 2, so several
 * affixes can unlock together.
 *
 * Returned as buckets rather than resolved stats because resolving means level scaling, which
 * is the engine's job. `mods` are the omen's own ranges plus the percent they resolve at;
 * `affix` entries carry their own stored roll.
 */
export type OmenBucket = {
  /** Pieces required for this bucket to pay out. */
  pieces: number;
  /** The omen's own `mods`, present on exactly one bucket. */
  mods?: Record<string, unknown>[];
  /** Resolved at {@link omenStatPercent}; meaningless for the affix buckets. */
  statPercent?: number;
  /** An affix bucket. */
  affix?: AffixRoll;
};

export function omenBuckets(snapshot: Snapshot, setup: OmenSetup): OmenBucket[] {
  const view = omen(snapshot, setup.id);
  if (view === undefined) return [];

  let max = 0;
  for (const count of Object.values(setup.requires ?? {})) {
    if (Number.isFinite(count)) max += count;
  }

  const percent = omenStatPercent(
    snapshot,
    setup.requires,
    (setup.slotRequirements ?? []).length,
    setup.rarity,
  );

  const out: OmenBucket[] = [{ pieces: max, mods: view.mods, statPercent: percent }];

  let index = max - 1;
  for (const affix of setup.affixes ?? []) {
    out.push({ pieces: index, affix });
    index--;
    if (index < 2) index = 2;
  }
  return out;
}
