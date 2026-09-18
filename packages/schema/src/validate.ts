/**
 * Legality checking for a build document.
 *
 * The question this answers is narrow and important: **could the game have produced this
 * character?** Not "is it good", not "does it parse" — could it exist. A hand-authored
 * character is only useful as ground truth if it is recreatable, and an item with an
 * impossible affix roll would make an engine mismatch unattributable.
 *
 * Two severities:
 *
 *   - `error`   the game cannot produce this. Grounded in data or in quoted Java.
 *   - `warning` suspicious, or resting on something this project has not yet verified
 *               against a real character. Never used to paper over a rule we know.
 *
 * Nothing is ever silently dropped or defaulted — an unknown enum value produces a
 * diagnostic, matching the extractor's fail-loud posture. Silently tolerating a schema
 * change is how a calculator starts producing confident wrong numbers after a pack update.
 */

import type { Snapshot } from "@cte2/extractor";

import {
  BUILD_DOC_VERSION,
  FOOD_BUFF_SLOTS,
  TREE_KEYS,
  isSupportEnabled,
  supportLinks,
  type AffixRoll,
  type BuildDoc,
  type FoodBuffSlot,
  type Item,
  type Jewel,
  type SkillSetup,
  type TreeCoord,
  type TreeKey,
} from "./build-doc.js";
import { ELEMENT_GUIDS } from "./elements.js";
import { isTargetPresetId } from "./target-presets.js";
import {
  CATEGORY,
  DEFAULT_BALANCE_ID,
  affix,
  entry,
  affixAllowedOnTags,
  affixCount,
  baseGearType,
  basesForSlot,
  coreStatIds,
  gearRarity,
  omen,
  omenCountsSlot,
  omenMinLevel,
  isGearRarityType,
  GEAR_RARITY_TYPES,
  has,
  isAffixType,
  isKnownReqType,
  isTwoHanded,
  maxBonusSpellLevels,
  maxLevel,
  maxOfOneAffixType,
  maxQuality,
  perk,
  perksOfKind,
  pointsAvailable,
  pointsPerLevel,
  slotCapacity,
  rune,
  runeword,
  runewordFitsBase,
  runewordMatches,
  slotFamily,
  slotFamilyCapacity,
  socketFamilyOfBase,
  statsForFamily,
  treeGrid,
  TREE_POINT_TYPE,
  unique,
  UNIQUE_ROLL_SLOTS,
  type AffixType,
  type GearRarityView,
  type PlayerPointType,
} from "./queries.js";
import { MAX_ACTIVE_SKILLS, activeSkillCount } from "./build-doc.js";
import {
  MAX_SCHOOLS,
  allocatedSchools,
  levelNeededForNextPerkLevel,
  perkPointType,
  schoolOfPerk,
  spellSchool,
} from "./spell-schools.js";
import { hasPathToEntry, nodeKey, treeGraph, type NodeKey } from "./tree-graph.js";

/**
 * `info` is not a lesser warning — it is a note about how a figure was reached rather than a
 * claim that something is wrong. The damage model emits them for the choices it made that a
 * reader should be able to see: a component group nothing reaches, an act it does not
 * interpret, a rotation whose length is set by one skill's cooldown. Nothing filters a build
 * out on one.
 */
export type Severity = "error" | "warning" | "info";

export type Diagnostic = {
  severity: Severity;
  /** Stable, greppable identifier for the rule that fired. */
  code: string;
  /** Where in the document, e.g. `gear[2].prefixes[0]`. */
  path: string;
  message: string;
};

export type ValidateOptions = {
  /** Which `mmorpg_game_balance` entry is in force. */
  balanceId?: string;
};

export function validateBuild(
  doc: BuildDoc,
  snapshot: Snapshot,
  options: ValidateOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const balanceId = options.balanceId ?? DEFAULT_BALANCE_ID;
  const add = (severity: Severity, code: string, path: string, message: string): void => {
    out.push({ severity, code, path, message });
  };

  if (doc.schemaVersion !== BUILD_DOC_VERSION) {
    add(
      "error",
      "unsupported-schema-version",
      "schemaVersion",
      `Expected ${BUILD_DOC_VERSION}, got ${JSON.stringify(doc.schemaVersion)}.`,
    );
    // Keep going: a version mismatch is worth reporting alongside whatever else is wrong,
    // rather than hiding every other problem behind it.
  }

  validateCharacter(doc, snapshot, balanceId, add);
  validateTrees(doc, snapshot, balanceId, add);

  for (const [i, item] of (doc.gear ?? []).entries()) {
    validateItem(item, snapshot, `gear[${i}]`, add);
  }
  // The bench is held to the same rules about what an *item* may be — a roll outside its tier's
  // band is impossible whether or not you are wearing it, and an item you cannot craft is not
  // one worth comparing against. What it is deliberately **not** held to is anything about the
  // loadout: `validateEquipment` counts slots, and a pool of nine swords is the point of having
  // a pool rather than nine errors.
  for (const [i, item] of (doc.itemPool ?? []).entries()) {
    validateItem(item, snapshot, `itemPool[${i}]`, add);
  }
  validateEquipment(doc, snapshot, add);
  validateOmen(doc, snapshot, add);
  validateStatPoints(doc, snapshot, balanceId, add);
  validateSchools(doc, snapshot, balanceId, add);
  for (const [i, jewel] of (doc.jewels ?? []).entries()) {
    validateJewel(jewel, snapshot, `jewels[${i}]`, add);
  }
  validateJewelSockets(doc, snapshot, add);

  validateReferences(doc, snapshot, add);
  return out;
}

/** True when nothing in the list would stop the game from producing this build. */
export function isLegal(diagnostics: readonly Diagnostic[]): boolean {
  return !diagnostics.some((d) => d.severity === "error");
}

type Add = (severity: Severity, code: string, path: string, message: string) => void;

/** `one_kind` shared by the sixteen `ASC` entry perks — the ascendancy choice. */
const ASCENDANCY_KIND = "ascendancy";

/**
 * The diagnostic codes one point pool's spend is reported under.
 *
 * Kept per caller rather than unified: "more talent points than exist" and "more stat points
 * than exist" are different findings to anyone filtering the list, and the codes are part of
 * this module's contract.
 */
type PointCodes = {
  /** Spent more than the character could possibly hold. */
  over: string;
  /** Spent past what levelling grants, which bonus points could still explain. */
  beyondLevelling: string;
  /** The balance file has no entry for this pool, so nothing could be checked. */
  unknown: string;
};

/**
 * One spend against one pool, checked the same way wherever the points came from.
 *
 * Three screens allocate points — the three trees, the stat screen, and the two class pools —
 * and each carried its own copy of this arithmetic. That is how they came to disagree about
 * `character.pointTotals`: the class pools honoured it and the other two re-derived a ceiling
 * from the level, so a capture of a quest-boosted character opened with warnings against an
 * allocation the game had just reported as legal.
 *
 * `pointsAvailable` is the single answer to "how many does this character have", and the two
 * branches below are what follows from it:
 *
 *  - **the game counted them** — `character.pointTotals` is present, so anything above it is a
 *    plain error and there is no band of doubt left to warn about;
 *  - **nobody counted them** — only levelling can be derived, so `ceiling` is the error line and
 *    the gap between `fromLevel` and it is a warning, because `getBonusPoints` is real and not
 *    derivable from a document.
 */
function checkPointSpend(
  doc: BuildDoc,
  snapshot: Snapshot,
  balanceId: string,
  pool: PlayerPointType,
  spent: number,
  path: string,
  noun: string,
  codes: PointCodes,
  add: Add,
): void {
  const available = pointsAvailable(snapshot, doc.character, pool, balanceId);

  if (available.recorded) {
    if (spent > available.total) {
      add(
        "error",
        codes.over,
        path,
        `${spent} ${noun} but the game reported ${available.total} ${pool} point(s) for this ` +
          "character (`character.pointTotals`).",
      );
    }
    return;
  }

  const budget = available.budget;
  if (!budget) {
    add(
      "warning",
      codes.unknown,
      path,
      "No `player_points." + pool + "` in balance \"" + balanceId + "\"; the spend could not be checked.",
    );
    return;
  }

  if (spent > budget.ceiling) {
    add(
      "error",
      codes.over,
      path,
      `${spent} ${noun} but at most ${budget.ceiling} are obtainable at level ` +
        `${doc.character.level} (${budget.fromLevel} from levelling + ${budget.maxBonus} bonus, ` +
        `capped at ${budget.maxTotal}).`,
    );
  } else if (spent > budget.fromLevel) {
    add(
      "warning",
      codes.beyondLevelling,
      path,
      `${spent} ${noun} but levelling to ${doc.character.level} grants ${budget.fromLevel}. ` +
        `Legal only if ${spent - budget.fromLevel} bonus point(s) were acquired, which only ` +
        "`character.pointTotals` can confirm.",
    );
  }
}


// ---------------------------------------------------------------------------

function validateCharacter(doc: BuildDoc, snapshot: Snapshot, balanceId: string, add: Add): void {
  const cap = maxLevel(snapshot, balanceId);
  const { level, school, ascendancy } = doc.character;

  if (!Number.isInteger(level) || level < 1 || level > cap) {
    add("error", "level-out-of-range", "character.level", `Must be an integer in 1..${cap}, got ${level}.`);
  }
  if (school !== undefined && !has(snapshot, CATEGORY.spellSchool, school)) {
    add("error", "unknown-spell-school", "character.school", `No ${CATEGORY.spellSchool} entry "${school}".`);
  }
  // The sixteen legal ascendancies are exactly the perks carrying `one_kind: "ascendancy"`,
  // which is also what stops a character taking two of them (`TalentsData.java:74-78`). An
  // earlier note here claimed they were underivable; they are not.
  if (ascendancy !== undefined && ascendancy.length === 0) {
    add("error", "empty-ascendancy", "character.ascendancy", "Present but empty; omit it instead.");
  } else if (ascendancy !== undefined) {
    const legal = perksOfKind(snapshot, ASCENDANCY_KIND);
    if (legal.length > 0 && !legal.includes(ascendancy)) {
      add(
        "error",
        "unknown-ascendancy",
        "character.ascendancy",
        `"${ascendancy}" is not one of the ${legal.length} one_kind="${ASCENDANCY_KIND}" perks.`,
      );
    }
  }
}

function validateTrees(doc: BuildDoc, snapshot: Snapshot, balanceId: string, add: Add): void {
  for (const key of Object.keys(TREE_KEYS) as TreeKey[]) {
    const coords = doc.tree?.[key];
    if (!coords) continue;
    const path = `tree.${key}`;
    const treeId = TREE_KEYS[key];
    const grid = treeGrid(snapshot, treeId);
    if (!grid) {
      add("error", "unknown-tree", path, `No ${CATEGORY.talentTree} entry "${treeId}" in the snapshot.`);
      continue;
    }

    const seen = new Set<string>();
    const allocated = new Set<NodeKey>();
    let spent = 0;

    for (const [i, coord] of coords.entries()) {
      const at = `${path}[${i}]`;
      if (!isCoord(coord)) {
        add("error", "malformed-coord", at, `Expected [row, col], got ${JSON.stringify(coord)}.`);
        continue;
      }
      const [row, col] = coord;
      const key2 = `${row},${col}`;
      if (seen.has(key2)) {
        add("error", "duplicate-allocation", at, `[${row}, ${col}] is allocated more than once.`);
        continue;
      }
      seen.add(key2);

      const cell = grid.cellAt(row, col);
      if (!cell) {
        add(
          "error",
          "coord-out-of-bounds",
          at,
          `[${row}, ${col}] is outside the ${grid.rows}x${grid.cols} "${treeId}" grid.`,
        );
        continue;
      }
      if (cell.kind !== "perk") {
        add(
          "error",
          "cell-not-allocatable",
          at,
          `[${row}, ${col}] is a ${cell.kind} cell ("${cell.raw}"), not a perk.`,
        );
        continue;
      }
      // A grid token longer than two characters is a talent whether or not it names a
      // registered perk; the game resolves the miss to `UnknownStat` and still charges a
      // point for it. Report rather than reject — it is a pack bug, not a document bug.
      if (cell.perkId !== undefined && !has(snapshot, CATEGORY.perk, cell.perkId)) {
        add(
          "warning",
          "unknown-perk",
          at,
          `[${row}, ${col}] names "${cell.perkId}", which is in no ${CATEGORY.perk} entry. ` +
            `In game it resolves to UnknownStat and grants nothing.`,
        );
      }
      allocated.add(nodeKey(row, col));
      spent++;
    }

    validateTreeGraph(snapshot, treeId, path, allocated, add);

    checkPointSpend(doc, snapshot, balanceId, TREE_POINT_TYPE[key], spent, path, "points allocated", {
      over: "point-budget-exceeded",
      beyondLevelling: "point-budget-needs-bonus",
      unknown: "no-point-budget",
    }, add);
  }

}

/**
 * Connectivity and exclusivity, ported from `TalentsData.canAllocate` / `hasPathToStart`.
 *
 * This used to be left unchecked on the grounds that the data did not settle whether a path
 * could run through connector glyphs. `TalentGrid.java` settles it completely: connector cells
 * are walked at load to precompute an edge list, and a glyph is a channel rather than a
 * direction. `packages/schema/src/tree-graph.ts` is that port, and the rules below are the two
 * the game enforces on top of it.
 *
 * Note the anchor is an `is_entry` perk, not `[CENTER]` — the centre cell is the tree screen's
 * camera origin and is never an allocation target.
 */
function validateTreeGraph(
  snapshot: Snapshot,
  treeId: string,
  path: string,
  allocated: ReadonlySet<NodeKey>,
  add: Add,
): void {
  if (allocated.size === 0) return;
  const graph = treeGraph(snapshot, treeId);
  if (!graph) return;

  // One perk per `one_kind` per tree: one class start, one ascendancy, one of each keystone.
  const byKind = new Map<string, string[]>();
  for (const key of allocated) {
    const kind = graph.nodes.get(key)?.perk?.oneKind;
    if (kind === undefined) continue;
    const list = byKind.get(kind) ?? [];
    list.push(graph.nodes.get(key)?.perkId ?? key);
    byKind.set(kind, list);
  }
  for (const [kind, held] of byKind) {
    if (held.length > 1) {
      add(
        "error",
        "one-kind-conflict",
        path,
        `${held.length} perks share one_kind="${kind}" (${held.sort().join(", ")}); the game ` +
          `allows exactly one.`,
      );
    }
  }

  const entries = [...allocated].filter((key) => graph.nodes.get(key)?.perk?.isEntry === true);
  if (entries.length === 0) {
    const names = graph.entries.map((e) => e.perkId).sort();
    add(
      "error",
      "no-entry-allocated",
      path,
      `Nothing is allocated at an entry perk, so no allocation is reachable. Take one of: ` +
        `${[...new Set(names)].join(", ")}.`,
    );
    return;
  }

  for (const key of allocated) {
    if (hasPathToEntry(graph, allocated, key)) continue;
    const node = graph.nodes.get(key);
    add(
      "error",
      "not-connected",
      path,
      `"${node?.perkId ?? key}" at [${node?.row ?? "?"}, ${node?.col ?? "?"}] has no path of ` +
        `allocated perks back to an entry perk.`,
    );
  }

}

function isCoord(value: unknown): value is TreeCoord {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    (value[0] as number) >= 0 &&
    (value[1] as number) >= 0
  );
}

// ---------------------------------------------------------------------------

function validateItem(item: Item, snapshot: Snapshot, path: string, add: Add): void {
  const base = baseGearType(snapshot, item.base);
  if (!base) {
    // Slot ids and base ids overlap confusingly: `boots` and `helmet` are gear *slots*, while
    // the bases are material-specific (`leather_boots`, `plate_helmet`, ...). Writing the slot
    // where the base belongs is the most likely hand-authoring mistake there is, so name the
    // alternatives rather than just reporting the id as unknown.
    const alternatives = has(snapshot, CATEGORY.gearSlot, item.base)
      ? basesForSlot(snapshot, item.base).map((b) => b.id)
      : [];
    add(
      "error",
      "unknown-base",
      `${path}.base`,
      alternatives.length > 0
        ? `"${item.base}" is a gear slot, not a base gear type. Bases in that slot: ${alternatives.join(", ")}.`
        : `No ${CATEGORY.baseGearType} entry "${item.base}".`,
    );
  }
  const rarity = gearRarity(snapshot, item.rarity);
  if (!rarity) {
    add("error", "unknown-rarity", `${path}.rarity`, `No ${CATEGORY.gearRarity} entry "${item.rarity}".`);
  }

  if (!Number.isInteger(item.itemLevel) || item.itemLevel < 0) {
    add("error", "bad-item-level", `${path}.itemLevel`, `Must be a non-negative integer, got ${item.itemLevel}.`);
  } else if (rarity && item.itemLevel < rarity.minLvl) {
    add(
      "error",
      "item-level-below-rarity-minimum",
      `${path}.itemLevel`,
      `Rarity "${rarity.id}" requires level ${rarity.minLvl}, item is ${item.itemLevel}.`,
    );
  }

  validateQuality(item, snapshot, path, add);

  if (base && rarity) {
    validateBaseRolls(item, base.baseStats.length, rarity, path, add);
  }

  validateUnique(item, snapshot, rarity, path, add);
  validateAffixSections(item, snapshot, base?.tags ?? [], rarity, path, add);
  validateSocketsAndRunes(item, snapshot, rarity, path, add);
}

/**
 * `CustomItemData.KEYS.QUALITY` is a `DataKey.IntKey` and is added to the base stat roll raw,
 * so a fraction or a negative is not a weak item but a malformed one.
 *
 * The ceiling is the other half, and it is a **warning** rather than an error on purpose.
 * Everything else here is grounded in a single field — an affix band, a rarity's affix count —
 * whereas `maxQuality` is a chain: currency to requirement to modification, across three
 * registries this project otherwise treats as out of scope. It is also only an upper bound (see
 * the query). A derived rule that confident is worth saying out loud and not worth refusing an
 * import over.
 */
function validateQuality(item: Item, snapshot: Snapshot, path: string, add: Add): void {
  if (item.quality === undefined) return;

  if (!Number.isInteger(item.quality) || item.quality < 0) {
    add(
      "error",
      "bad-quality",
      `${path}.quality`,
      `Quality is an int added straight to the base stat roll, so it must be a non-negative whole number, got ${item.quality}.`,
    );
    return;
  }

  const ceiling = maxQuality(snapshot);
  if (ceiling !== undefined && item.quality > ceiling) {
    add(
      "warning",
      "quality-above-pack-ceiling",
      `${path}.quality`,
      `No chain of this pack's currencies reaches past ${ceiling} quality, got ${item.quality}.`,
    );
  }
}

function validateBaseRolls(
  item: Item,
  expectedCount: number,
  rarity: GearRarityView,
  path: string,
  add: Add,
): void {
  if (item.baseRolls === undefined) return;
  if (item.baseRolls.length !== expectedCount) {
    add(
      "error",
      "base-roll-count-mismatch",
      `${path}.baseRolls`,
      `Base "${item.base}" has ${expectedCount} base stat(s) but ${item.baseRolls.length} roll(s) were given.`,
    );
  }
  for (const [i, roll] of item.baseRolls.entries()) {
    const band = rarity.baseStatPercents;
    if (typeof roll !== "number" || roll < band.min || roll > band.max) {
      add(
        "error",
        "base-roll-outside-band",
        `${path}.baseRolls[${i}]`,
        `Rarity "${rarity.id}" rolls base stats in ${band.min}..${band.max}, got ${roll}.`,
      );
    }
  }
}

function validateUnique(
  item: Item,
  snapshot: Snapshot,
  rarity: GearRarityView | undefined,
  path: string,
  add: Add,
): void {
  if (item.unique === undefined) {
    if (item.uniqueRolls !== undefined) {
      add("error", "unique-rolls-without-unique", `${path}.uniqueRolls`, "Present but no `unique` is set.");
    }
    if (rarity?.isUniqueItem) {
      add(
        "error",
        "unique-rarity-without-unique",
        `${path}.rarity`,
        `Rarity "${rarity.id}" is a unique rarity but no \`unique\` id is set.`,
      );
    }
    return;
  }

  const view = unique(snapshot, item.unique);
  if (!view) {
    add("error", "unknown-unique", `${path}.unique`, `No ${CATEGORY.unique} entry "${item.unique}".`);
    return;
  }
  if (view.baseGear !== undefined && view.baseGear !== item.base) {
    add(
      "error",
      "unique-base-mismatch",
      `${path}.unique`,
      `"${view.id}" is a "${view.baseGear}", but the item's base is "${item.base}".`,
    );
  }
  if (rarity && !rarity.isUniqueItem) {
    add(
      "error",
      "unique-on-non-unique-rarity",
      `${path}.rarity`,
      `"${view.id}" is a unique but the rarity "${rarity.id}" is not a unique rarity.`,
    );
  }
  if (item.itemLevel < view.minDropLvl) {
    add(
      "error",
      "unique-below-min-drop-level",
      `${path}.itemLevel`,
      `"${view.id}" only drops at level ${view.minDropLvl} or above, item is ${item.itemLevel}.`,
    );
  }
  if ((item.prefixes?.length ?? 0) > 0 || (item.suffixes?.length ?? 0) > 0) {
    add(
      "error",
      "unique-with-affixes",
      path,
      "Uniques carry `unique_stats` instead of prefixes and suffixes; both cannot be set.",
    );
  }
  // `UniqueStatsData.perc` is a fixed ten-slot array, not one slot per stat:
  //
  //     public static int MAX_STATS = 10;
  //     public void RerollNumbers(GearItemData gear) {
  //         perc.clear();
  //         // wont ever have more than 10 unique stats.
  //         for (int i = 0; i < MAX_STATS; i++) { perc.add(getMinMax(gear).random()); }
  //     }
  //
  // and `GetAllStats` walks `getUnique(stack).uniqueStats()` indexing `perc.get(i)`, so slots
  // past the unique's stat count are rolled, stored and never read. A capture therefore shows
  // ten rolls on a five-stat unique and is perfectly well-formed. Only a *short* list is a
  // problem: the game would throw IndexOutOfBounds where the engine silently reads 0%.
  if (item.uniqueRolls !== undefined && item.uniqueRolls.length < view.uniqueStats.length) {
    add(
      "error",
      "unique-rolls-too-few",
      `${path}.uniqueRolls`,
      `"${view.id}" has ${view.uniqueStats.length} stat(s) but only ${item.uniqueRolls.length} ` +
        `roll(s) were given; the remaining stat(s) would be computed at 0%.`,
    );
  }
  if (item.uniqueRolls !== undefined && item.uniqueRolls.length > UNIQUE_ROLL_SLOTS) {
    add(
      "warning",
      "unique-rolls-over-slots",
      `${path}.uniqueRolls`,
      `${item.uniqueRolls.length} rolls given, but the game only ever stores ` +
        `${UNIQUE_ROLL_SLOTS} (UniqueStatsData.MAX_STATS). The extras are ignored.`,
    );
  }
  for (const [i, roll] of (item.uniqueRolls ?? []).entries()) {
    if (typeof roll !== "number" || roll < 0 || roll > 100) {
      add("error", "roll-out-of-range", `${path}.uniqueRolls[${i}]`, `Must be 0..100, got ${roll}.`);
    }
  }
}

/** The affix sections of an item, paired with the affix `type` each one may contain. */
const ITEM_AFFIX_SECTIONS: { key: "implicits" | "prefixes" | "suffixes" | "corruptions"; type: AffixType }[] = [
  { key: "implicits", type: "implicit" },
  { key: "prefixes", type: "prefix" },
  { key: "suffixes", type: "suffix" },
  { key: "corruptions", type: "chaos_stat" },
];

function validateAffixSections(
  item: Item,
  snapshot: Snapshot,
  baseTags: readonly string[],
  rarity: GearRarityView | undefined,
  path: string,
  add: Add,
): void {
  const onItem: { roll: AffixRoll; path: string }[] = [];

  for (const section of ITEM_AFFIX_SECTIONS) {
    for (const [i, roll] of (item[section.key] ?? []).entries()) {
      const at = `${path}.${section.key}[${i}]`;
      validateAffixRoll(roll, section.type, snapshot, baseTags, rarity, at, add);
      onItem.push({ roll, path: at });
    }
  }
  if (item.enchant) {
    const at = `${path}.enchant`;
    validateAffixRoll(item.enchant, "enchant", snapshot, baseTags, rarity, at, add);
    onItem.push({ roll: item.enchant, path: at });
  }

  validateAffixExclusivity(onItem, snapshot, add);

  if (!rarity || item.unique !== undefined) return;

  // Affix counts. `min_affixes` is an exact total, not a floor, and the per-type ceiling is
  // the rounded-up half — see queries.affixCount / maxOfOneAffixType for the source.
  const prefixes = item.prefixes?.length ?? 0;
  const suffixes = item.suffixes?.length ?? 0;
  const expected = affixCount(rarity);
  const perType = maxOfOneAffixType(rarity);

  if (prefixes + suffixes !== expected) {
    add(
      "error",
      "affix-count-mismatch",
      path,
      `Rarity "${rarity.id}" always has exactly ${expected} affix(es); found ${prefixes + suffixes} ` +
        `(${prefixes} prefix, ${suffixes} suffix).`,
    );
  }
  if (prefixes > perType) {
    add("error", "too-many-prefixes", `${path}.prefixes`, `At most ${perType} on rarity "${rarity.id}", got ${prefixes}.`);
  }
  if (suffixes > perType) {
    add("error", "too-many-suffixes", `${path}.suffixes`, `At most ${perType} on rarity "${rarity.id}", got ${suffixes}.`);
  }
}

function validateAffixRoll(
  roll: AffixRoll,
  expectedType: AffixType,
  snapshot: Snapshot,
  baseTags: readonly string[],
  itemRarity: GearRarityView | undefined,
  path: string,
  add: Add,
): void {
  const view = affix(snapshot, roll.affixId);
  if (!view) {
    add("error", "unknown-affix", `${path}.affixId`, `No ${CATEGORY.affix} entry "${roll.affixId}".`);
    return;
  }

  if (!isAffixType(view.type)) {
    add(
      "error",
      "unknown-affix-type",
      `${path}.affixId`,
      `"${view.id}" declares an unrecognised type "${view.type}". Refusing to guess what it means.`,
    );
  } else if (view.type !== expectedType) {
    add(
      "error",
      "affix-type-mismatch",
      path,
      `"${view.id}" is a "${view.type}" affix and cannot go in a "${expectedType}" slot.`,
    );
  }

  for (const [i, req] of view.tagRequirements.entries()) {
    if (!isKnownReqType(req.reqType)) {
      add(
        "error",
        "unknown-req-type",
        `${path}.affixId`,
        `"${view.id}" requirement ${i} uses req_type "${req.reqType}", which this tool does not implement.`,
      );
    }
  }
  if (!affixAllowedOnTags(view, baseTags)) {
    add(
      "error",
      "affix-not-allowed-on-base",
      path,
      `"${view.id}" cannot roll on tags [${baseTags.join(", ")}].`,
    );
  }

  validateTier(roll, expectedType, snapshot, itemRarity, path, add);
}

/**
 * An implicit is the one affix with no tier.
 *
 *     public class ImplicitStatsData implements IGearPartTooltip, IRerollable, IStatsContainer {
 *         public Integer p = 0;
 *         public String imp = "";
 *
 * — that is the whole of its saved state, against `AffixData`'s `rar` + `p` + `id`. And
 * because it does not override `IGearPartTooltip.getMinMax`, it keeps that interface's
 * default:
 *
 *     default MinMax getMinMax(GearItemData gear) { return new MinMax(0, 100); }
 *
 * where `BaseStatsData` overrides it to `gear.getRarity().base_stat_percents`. So an implicit
 * rolls the full 0-100 on every rarity, and holding one to a rarity's narrow band rejects
 * ordinary items — a 79% roll on an epic necklace is not a corrupted capture.
 */
function validateTier(
  roll: AffixRoll,
  expectedType: AffixType,
  snapshot: Snapshot,
  itemRarity: GearRarityView | undefined,
  path: string,
  add: Add,
): void {
  if (expectedType === "implicit") {
    if (roll.tier !== undefined) {
      add(
        "warning",
        "implicit-has-tier",
        `${path}.tier`,
        `Implicits have no tier in game (ImplicitStatsData stores only \`p\` and \`imp\`); ` +
          `"${roll.tier}" is ignored. Drop the field.`,
      );
    }
    if (!Number.isFinite(roll.rollPercent) || roll.rollPercent < 0 || roll.rollPercent > 100) {
      add(
        "error",
        "roll-outside-tier-band",
        `${path}.rollPercent`,
        `Implicits roll 0..100, got ${roll.rollPercent}.`,
      );
    }
    return;
  }

  if (roll.tier === undefined) {
    add(
      "error",
      "missing-affix-tier",
      `${path}.tier`,
      `A "${expectedType}" affix carries its own tier (AffixData.rar) and one is required.`,
    );
    return;
  }

  const tier = gearRarity(snapshot, roll.tier);
  if (!tier) {
    add("error", "unknown-affix-tier", `${path}.tier`, `No ${CATEGORY.gearRarity} entry "${roll.tier}".`);
    return;
  }
  if (tier.isUniqueItem) {
    add(
      "error",
      "unique-rarity-as-affix-tier",
      `${path}.tier`,
      `randomizeTier excludes unique rarities; "${tier.id}" cannot be an affix tier.`,
    );
  }
  // There is deliberately no "affix tier must not exceed the item's rarity" rule here, and
  // there was one. `randomizeTier` caps the tier at the item's rarity when an affix is first
  // *rolled*, which is what the rule was reasoning from — but nothing holds it there
  // afterwards. `UpgradeRarityItemMod` rescales every `p` and then walks the tier up to
  // whatever band now contains it:
  //
  //     while (affix.p > affix.getRarity().stat_percents.max) {
  //         affix.rar = affix.getRarity().getHigherRarity().GUID();
  //     }
  //
  // with no ceiling at the item, and the currency that does this is in the pack. A captured
  // epic jewel carrying three mythic-tier affixes tripped the rule thirteen times on one real
  // character. Nothing is lost by dropping it: the tier's only job is to say which band the
  // roll came from (`AffixData.getMinMax` returns `getRarity().stat_percents`), and the band
  // check below still holds the roll to it.

  const band = tier.statPercents;
  if (!Number.isFinite(roll.rollPercent) || roll.rollPercent < band.min || roll.rollPercent > band.max) {
    add(
      "error",
      "roll-outside-tier-band",
      `${path}.rollPercent`,
      `Tier "${tier.id}" rolls in ${band.min}..${band.max}, got ${roll.rollPercent}.`,
    );
  }
}

function validateAffixExclusivity(
  onItem: readonly { roll: AffixRoll; path: string }[],
  snapshot: Snapshot,
  add: Add,
): void {
  const seenIds = new Map<string, string>();
  const seenGroups = new Map<string, string>();

  for (const { roll, path } of onItem) {
    const view = affix(snapshot, roll.affixId);
    if (!view) continue;

    const firstId = seenIds.get(view.id);
    if (firstId !== undefined && view.onlyOnePerItem) {
      add(
        "error",
        "duplicate-only-one-per-item",
        path,
        `"${view.id}" is only_one_per_item but also appears at ${firstId}.`,
      );
    }
    if (firstId === undefined) seenIds.set(view.id, path);

    if (view.oneOfAKind.length > 0) {
      const firstGroup = seenGroups.get(view.oneOfAKind);
      if (firstGroup !== undefined) {
        add(
          "error",
          "one-of-a-kind-conflict",
          path,
          `"${view.id}" is in the one_of_a_kind group "${view.oneOfAKind}", already used at ${firstGroup}.`,
        );
      } else {
        seenGroups.set(view.oneOfAKind, path);
      }
    }
  }
}

function validateSocketsAndRunes(
  item: Item,
  snapshot: Snapshot,
  rarity: GearRarityView | undefined,
  path: string,
  add: Add,
): void {
  const sockets = item.sockets ?? [];
  const runes = item.runes ?? [];

  for (const [i, gemId] of sockets.entries()) {
    if (!has(snapshot, CATEGORY.gem, gemId)) {
      add("error", "unknown-gem", `${path}.sockets[${i}]`, `No ${CATEGORY.gem} entry "${gemId}".`);
    }
  }
  for (const [i, runeId] of runes.entries()) {
    if (!has(snapshot, CATEGORY.rune, runeId)) {
      add("error", "unknown-rune", `${path}.runes[${i}]`, `No ${CATEGORY.rune} entry "${runeId}".`);
    }
  }

  if (!rarity) return;

  // Gems and runes share one list in game — `GearSocketsData.so` holds both, and
  // `getEmptySockets()` is `getTotalSockets() - getSocketedGemsCount()` over the pair. So the
  // ceiling is on the *total*, and counting the two separately let an item carry twice what it
  // has room for.
  //
  // `sockets.max` gates `canAddSocket`, which is a crafting-time check rather than an invariant
  // an item on a character has to satisfy: a mythic helmet carrying two socketed gems came out
  // of a real capture, and the game applied both. So this reports rather than refuses.
  const filled = sockets.length + runes.length;
  if (filled > rarity.sockets.max) {
    add(
      "warning",
      "too-many-sockets",
      `${path}.sockets`,
      `Rarity "${rarity.id}" allows at most ${rarity.sockets.max} socket(s) to be *added* and ` +
        `gems and runes share them, got ${sockets.length} gem(s) + ${runes.length} rune(s). ` +
        `An item can carry more than it could be given today.`,
    );
  }
  // `max_gems: 0` is not "no limit stated", it is the outright refusal a runed base gets:
  // RARITY_CANT_HAVE_ANY_GEMS is the `else` branch of `if (rar.max_gems > 0)` in
  // `GemItem.canBeModified`. Runed gear takes runes and nothing else.
  if (sockets.length > 0 && rarity.maxGems <= 0) {
    add(
      "error",
      "gems-on-runed-gear",
      `${path}.sockets`,
      `Rarity "${rarity.id}" has max_gems: 0, so no gem can be socketed into it at all ` +
        "(`GemItem.canBeModified` refuses with RARITY_CANT_HAVE_ANY_GEMS). " +
        `${sockets.length} gem(s) are listed. Runed gear takes runes.`,
    );
  } else if (sockets.length > rarity.maxGems) {
    add(
      "error",
      "too-many-gems",
      `${path}.sockets`,
      `Rarity "${rarity.id}" allows at most ${rarity.maxGems} gem(s), got ${sockets.length}.`,
    );
  }
  if (runes.length > rarity.maxRunes) {
    add(
      "error",
      "too-many-runes",
      `${path}.runes`,
      `Rarity "${rarity.id}" allows at most ${rarity.maxRunes} rune(s), got ${runes.length}.`,
    );
  }
  // One socket per *distinct* rune: `RuneItem`'s outcome looks for a socket already holding the
  // same rune and raises its roll rather than adding a second, and `canBeModified` refuses one
  // already at 100%.
  const seenRunes = new Map<string, number>();
  for (const [i, runeId] of runes.entries()) {
    const first = seenRunes.get(runeId);
    if (first !== undefined) {
      add(
        "error",
        "duplicate-rune",
        `${path}.runes[${i}]`,
        `"${runeId}" is already socketed at runes[${first}]. Inserting the same rune again ` +
          "raises that socket's roll (`SocketData.p`) rather than taking a second socket.",
      );
    } else {
      seenRunes.set(runeId, i);
    }
  }
  // A rune's stat list is per `SlotFamily`, and an empty list for this base's family is the
  // NOT_FAMILY refusal — the rune cannot go in at all, not merely grant nothing.
  const family = socketFamilyOfBase(snapshot, item.base);
  for (const [i, runeId] of runes.entries()) {
    const view = rune(snapshot, runeId);
    if (view === undefined) continue;
    if (statsForFamily(view, family).length === 0) {
      add(
        "error",
        "rune-wrong-family",
        `${path}.runes[${i}]`,
        `"${runeId}" declares no stats for a ${family} item, which is Chats.NOT_FAMILY — ` +
          "`RuneItem.canBeModified` refuses to insert it.",
      );
    }
  }
  for (const [i, roll] of (item.runeRolls ?? []).entries()) {
    if (roll < 0 || roll > 100) {
      add(
        "error",
        "rune-roll-out-of-range",
        `${path}.runeRolls[${i}]`,
        "`SocketData.p` is rolled over 0-100 when the rune goes in, got " + `${roll}.`,
      );
    }
  }
  validateRuneword(item, snapshot, rarity, runes, path, add);

  // How many items may occupy one gear slot (two rings, say) is not in the datapack — the
  // equipment screen is the mod's own, not Curios, whose only registered slot here is
  // `master_bag`. Cross-item slot limits are therefore left unchecked rather than guessed.
}

/**
 * A runeword is not a label you attach to an item — it is what the runes in it spell.
 *
 * `RuneItem` sets one only when both hold:
 *
 *     ExileDB.RuneWords().getFilterWrapped(x -> x.canApplyOnItem(gear) && x.hasMatchingRunesToCreate(gear))
 *
 * `canApplyOnItem` is the base's `gear_slot` against the runeword's `slots`, and
 * `hasMatchingRunesToCreate` concatenates the socketed rune ids in order and asks whether the
 * runeword's own concatenation is a **substring** of it. So the runes must be present, adjacent
 * and in the declared order — having the right set is not enough.
 *
 * The roll is `GearSocketsData.setRuneword`: `rp = new MinMax(0, 100).random()`, one roll for
 * the whole runeword.
 *
 * ## Both shape rules warn rather than refuse, and a capture is why
 *
 * Nothing re-checks either condition once `rw` is set. `GearSocketsData.GetAllStats` reads
 * `hasRuneWord()`, which is `isRegistered(rw)` and nothing more, and pays the stats out. So the
 * two are gates on *making* a runeword, not invariants an item on a character satisfies — the
 * same distinction `too-many-sockets` already draws.
 *
 * The Amfk level-100 capture proves it: a **spear** carrying `carpe_noctem`, whose `slots` are
 * axe, sword, greatsword, hammer and scythe. Its `plus_lvl_cold_spells: 2` is that runeword's,
 * and all 1342 of that character's observed stats reproduce at float precision with it applied.
 * A pack update moved the slot list under an item somebody had already made, and the game went
 * on paying it. Reporting that as illegal would be calling the game wrong.
 */
function validateRuneword(
  item: Item,
  snapshot: Snapshot,
  rarity: GearRarityView,
  runes: readonly string[],
  path: string,
  add: Add,
): void {
  if (item.runewordRoll !== undefined && (item.runewordRoll < 0 || item.runewordRoll > 100)) {
    add(
      "error",
      "runeword-roll-out-of-range",
      `${path}.runewordRoll`,
      "`GearSocketsData.rp` is `new MinMax(0, 100).random()`, got " + `${item.runewordRoll}.`,
    );
  }
  if (item.runeword === undefined) return;

  // The rarity check does not depend on the runeword existing, and both facts are worth having
  // at once — a document naming a made-up runeword on a rare item is wrong twice over.
  if (!rarity.canHaveRunewords) {
    add(
      "error",
      "runeword-on-disallowed-rarity",
      `${path}.runeword`,
      `Rarity "${rarity.id}" has can_have_runewords: false.`,
    );
  }

  const view = runeword(snapshot, item.runeword);
  if (view === undefined) {
    add("error", "unknown-runeword", `${path}.runeword`, `No ${CATEGORY.runeword} entry "${item.runeword}".`);
    return;
  }
  if (!runewordFitsBase(snapshot, view, item.base)) {
    const slot = baseGearType(snapshot, item.base)?.gearSlot ?? "?";
    add(
      "warning",
      "runeword-wrong-slot",
      `${path}.runeword`,
      `"${item.runeword}" can only be *made* on ${view.slots.join(", ") || "no slot at all"}, ` +
        `and this base's slot is "${slot}" (RuneWord.canApplyOnItem). An item that already ` +
        "carries it keeps paying out — nothing re-checks this after the runeword is set — so " +
        "this is a pack change under an existing item rather than an impossible document.",
    );
  }
  if (!runewordMatches(view, runes)) {
    add(
      "warning",
      "runeword-runes-mismatch",
      `${path}.runes`,
      `"${item.runeword}" is made from ${view.runes.join(" + ")} socketed consecutively and in ` +
        `that order; this item has ${runes.length === 0 ? "no runes" : runes.join(" + ")}. ` +
        "`hasMatchingRunesToCreate` is a substring test over the concatenated rune ids, so the " +
        "order is part of the recipe. The stats still apply — `GetAllStats` reads only whether " +
        "a runeword is set — so this warns rather than refuses.",
    );
  }
}

/** The `mmorpg_perk` whose whole purpose is to be a socket. There are 18 in the talent tree. */
const JEWEL_SOCKET_PERK = "jewel_socket";

/**
 * `JewelSocketStat.max` — the ceiling on the stat itself, whatever grants it.
 */
const MAX_JEWEL_SOCKETS = 9;

/**
 * A jewel needs a socket, and a socket is something you paid for.
 *
 * `jewel_socket` is a `SPECIAL` perk granting the `jewel_socket` stat, and the talent grid has
 * exactly 18 of them; the ascendancy and atlas trees have none. So how many jewels a build may
 * carry is not a constant — and it is not only the tree either: **two uniques grant the same
 * stat**, Bubonic Trail at 1-2 and Hungering Vessel at a flat 4. Counting only talents called a
 * legal Hungering Vessel build illegal.
 *
 * The bound here is deliberately the most generous reading — each unique counted at the top of
 * its band — because this is the "no roll of this document is legal" check. The engine computes
 * the *actual* number off the finished sheet and reports `jewel-without-socket` per jewel it
 * had to drop, which is the precise answer; this only catches what no roll could rescue.
 *
 * That is the one jewel rule there is: Mine and Slash has no radius rule, no jewel-type-per-socket
 * rule and no limit other than the sockets themselves, which is also why `Jewel.socket` is
 * recorded when known and never required.
 */
function validateJewelSockets(doc: BuildDoc, snapshot: Snapshot, add: Add): void {
  const jewels = doc.jewels ?? [];
  if (jewels.length === 0) return;

  const grid = treeGrid(snapshot, TREE_KEYS.talents);
  if (!grid) return; // `validateTrees` has already reported the missing tree

  let sockets = 0;
  for (const coord of doc.tree?.talents ?? []) {
    if (!isCoord(coord)) continue;
    const cell = grid.cellAt(coord[0], coord[1]);
    if (cell?.kind === "perk" && cell.perkId === JEWEL_SOCKET_PERK) sockets += 1;
  }

  let fromGear = 0;
  for (const item of doc.gear ?? []) {
    if (item.unique === undefined) continue;
    for (const mod of unique(snapshot, item.unique)?.uniqueStats ?? []) {
      if (mod["stat"] !== JEWEL_SOCKET_PERK) continue;
      const top = mod["max"] ?? mod["v1"];
      if (typeof top === "number" && Number.isFinite(top)) fromGear += Math.trunc(top);
    }
  }

  const total = Math.min(sockets + fromGear, MAX_JEWEL_SOCKETS);
  if (jewels.length > total) {
    add(
      "error",
      "too-many-jewels",
      "jewels",
      `${jewels.length} jewel(s) but ${total} jewel socket(s): ${sockets} allocated ` +
        `\`${JEWEL_SOCKET_PERK}\` talent(s)` +
        (fromGear > 0 ? ` and up to ${fromGear} from uniques` : "") +
        `. A jewel needs a socket — allocate more or remove ${jewels.length - total} jewel(s). ` +
        `The game unequips the surplus outright (\`JewelInvHelper.checkRemoveJewels\`).`,
    );
  }
}

function validateJewel(jewel: Jewel, snapshot: Snapshot, path: string, add: Add): void {
  const rarity = gearRarity(snapshot, jewel.rarity);
  if (!rarity) {
    add("error", "unknown-rarity", `${path}.rarity`, `No ${CATEGORY.gearRarity} entry "${jewel.rarity}".`);
  }
  if (!Number.isInteger(jewel.itemLevel) || jewel.itemLevel < 0) {
    add("error", "bad-item-level", `${path}.itemLevel`, `Must be a non-negative integer, got ${jewel.itemLevel}.`);
  }

  for (const [i, roll] of (jewel.affixes ?? []).entries()) {
    const at = `${path}.affixes[${i}]`;
    const view = affix(snapshot, roll.affixId);
    if (!view) {
      add("error", "unknown-affix", `${at}.affixId`, `No ${CATEGORY.affix} entry "${roll.affixId}".`);
      continue;
    }
    // Jewels have their own tag space (`jewel_str`, `any_jewel`, ...) which no gear base
    // carries, so the base-tag check does not apply. The type check still does.
    if (view.type !== "jewel" && view.type !== "jewel_corruption" && view.type !== "crafted_jewel_unique") {
      add(
        "error",
        "affix-type-mismatch",
        at,
        `"${view.id}" is a "${view.type}" affix and cannot appear on a jewel.`,
      );
    }
    // A jewel affix is an `AffixData` like any other, tier and all — only implicits are
    // tierless, and a jewel has none.
    validateTier(roll, "jewel", snapshot, rarity, at, add);
  }

  if (jewel.socket !== undefined && !isCoord(jewel.socket)) {
    add("error", "malformed-coord", `${path}.socket`, `Expected [row, col], got ${JSON.stringify(jewel.socket)}.`);
  }
}

// ---------------------------------------------------------------------------

/**
 * A skill-gem-type item's rarity and roll — the same pair on a support gem and on an Augment,
 * because the game stores both as `SkillGemData`.
 *
 * The rarity is not decoration. `perc` is drawn from it and stays inside it:
 *
 *     data.rar  = rar.GUID();
 *     data.perc = rar.stat_percents.random();
 *
 * — SkillGemBlueprint.java:32-40, and `UpgradeSkillGemRarityItemMod` rescales `perc` into the
 * new band rather than leaving it behind. So the bands do not overlap and a roll outside its
 * own is something the game cannot produce — the same check gear affixes get against their
 * tier. Without a rarity stated there is no band, and only the plain 0-100 applies.
 */
/** The top of every band any rarity in this pack rolls a gem at. */
const GEM_PERCENT_BAND_MAX = 100;

/**
 * Why a gem percent above the bands is a warning and not an error.
 *
 * Nothing the game does today can produce one. `SkillGemBlueprint` draws from
 * `rar.stat_percents.random()`, `RerollSkillGemStatsItemMod` redraws from the same band, and
 * `UpgradeSkillGemRarityItemMod` goes through `uniformRescaleInt`, whose last act is
 * `Math.min(…, to.max)` — all three confirmed in `Mine_and_Slash-1.20.1-6.4.13.jar`, not just in
 * the fork. The pack's quest reward tables hand out gems with a literal `perc` and the highest is
 * 40. No rarity in the pack has a band above 100.
 *
 * But `SkillGemData.perc` is a bare public `int` with no clamp anywhere in the class —
 * `getStatPercent()` is `return perc` and nothing re-reads the band on load — so a value written
 * by an older build of the pack or the mod survives every world load and the game goes on using
 * it. A capture that records one is a *measurement*, and this project's rule is that a
 * measurement wins. `protection` at 108 on the 2026-09-15 capture is exactly that.
 *
 * So: a number the format cannot represent is still an error, and one the game is demonstrably
 * holding is a warning that says where it came from.
 */
function abovePercentBand(roll: number): string {
  return (
    `${roll} is above the ${GEM_PERCENT_BAND_MAX} every rarity band tops out at. Nothing in ` +
    `6.4.13 writes one — the blueprint, the reroll and the rarity upgrade all stay inside the ` +
    `band — but \`SkillGemData.perc\` is never re-clamped on load, so an item rolled before a ` +
    `band changed keeps its number and the game keeps using it. The gem's stats interpolate ` +
    `past the top of their range at this roll.`
  );
}

function validateGemRoll(
  gem: { id: string; rarity?: string; rollPercent?: number },
  snapshot: Snapshot,
  path: string,
  add: Add,
): void {
  const roll = gem.rollPercent;
  if (roll !== undefined && (!Number.isFinite(roll) || roll < 0)) {
    add(
      "error",
      "gem-percent-out-of-range",
      `${path}.rollPercent`,
      `\`SkillGemData.getStatPercent()\` is a non-negative percent, got ${roll}.`,
    );
    return;
  }
  if (roll !== undefined && roll > GEM_PERCENT_BAND_MAX) {
    add("warning", "gem-percent-above-band", `${path}.rollPercent`, abovePercentBand(roll));
  }

  if (gem.rarity === undefined) return;
  const rarity = gearRarity(snapshot, gem.rarity);
  if (!rarity) {
    add("error", "unknown-gem-rarity", `${path}.rarity`, `No ${CATEGORY.gearRarity} entry "${gem.rarity}".`);
    return;
  }
  if (rarity.isUniqueItem) {
    add(
      "error",
      "unique-rarity-as-gem-rarity",
      `${path}.rarity`,
      `"${rarity.id}" is a unique-item rarity and is not one a gem rolls at.`,
    );
    return;
  }

  const band = rarity.statPercents;
  if (roll === undefined || (roll >= band.min && roll <= band.max)) return;

  // Above the band is the stale-item case above, and the pack has real ones; below it is what a
  // typo looks like, and nothing in the game produces it. Same rule, different direction.
  add(
    roll > band.max ? "warning" : "error",
    "gem-roll-outside-rarity-band",
    `${path}.rollPercent`,
    `A "${rarity.id}" gem rolls in ${band.min}..${band.max}, got ${roll}.` +
      (roll > band.max
        ? ` Above the band is legal-but-stale: \`SkillGemData.perc\` is never re-clamped on load.`
        : ""),
  );
}

/**
 * Two support gems one Skill may not hold at once.
 *
 * Unlike most legality rules this one has teeth in game. `SocketedGem.checkIfCanUseGems` does not
 * ignore the second gem, it throws away *all* of them:
 *
 *     if (map.get(data.getSupport().id) > 1) { toomany = true; break; }
 *     if (data.getSupport().isOneOfAKind()) {
 *         String id = data.getSupport().one_of_a_kind;
 *         map.put(id, map.getOrDefault(id, 0) + 1);
 *         if (map.get(id) > 1) { toomany = true; break; }
 *     }
 *     ...
 *     if (toomany) { for (ItemStack s : this.getSupports()) { PlayerUtils.forceUnequipItem(...); } }
 *
 * — SocketedGem.java:67-94. So a document with Greater and Lesser Multiple Projectiles on one
 * Skill does not describe a Skill with a redundant gem; it describes a Skill the game strips
 * bare the moment it is loaded, and every figure computed from it is wrong by all five gems.
 *
 * Per Skill, because `SocketedGem` is per Skill: the same gem in two different Skills is fine.
 *
 * A link switched off in the planner is skipped, for the same reason the collector skips it: it
 * is an empty socket. Counting one would refuse the commonest thing this switch exists for —
 * holding the gem you are comparing against beside the one you are trying.
 */
function validateSupportExclusivity(skill: SkillSetup, snapshot: Snapshot, i: number, add: Add): void {
  const seenIds = new Map<string, number>();
  const seenGroups = new Map<string, { id: string; at: number }>();

  for (const [j, support] of supportLinks(skill).entries()) {
    if (!isSupportEnabled(support)) continue;
    const path = `skills[${i}].supports[${j}]`;
    const first = seenIds.get(support.id);
    if (first !== undefined) {
      add(
        "error",
        "duplicate-support-gem",
        path,
        `"${support.id}" is already linked at skills[${i}].supports[${first}]. The game unequips ` +
          `every support gem on this Skill rather than ignoring the second one.`,
      );
      continue;
    }
    seenIds.set(support.id, j);

    const raw = entry(snapshot, CATEGORY.supportGem, support.id)?.data["one_of_a_kind"];
    const group = typeof raw === "string" ? raw : "";
    if (group.length === 0) continue;
    const clash = seenGroups.get(group);
    if (clash !== undefined) {
      add(
        "error",
        "support-gem-one-of-a-kind",
        path,
        `"${support.id}" and "${clash.id}" (at skills[${i}].supports[${clash.at}]) are both in the ` +
          `one_of_a_kind group "${group}", and only one of a group may be linked. The game ` +
          `unequips every support gem on this Skill rather than ignoring the second one.`,
      );
      continue;
    }
    seenGroups.set(group, { id: support.id, at: j });
  }
}

/** Plain existence checks for the sections that are still just id references. */
function validateReferences(doc: BuildDoc, snapshot: Snapshot, add: Add): void {
  let mains = 0;
  for (const [i, skill] of (doc.skills ?? []).entries()) {
    const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
    if (!spell) {
      add("error", "unknown-spell", `skills[${i}].spellId`, `No ${CATEGORY.spell} entry "${skill.spellId}".`);
    }
    for (const [j, support] of supportLinks(skill).entries()) {
      if (!has(snapshot, CATEGORY.supportGem, support.id)) {
        add(
          "error",
          "unknown-support-gem",
          `skills[${i}].supports[${j}]`,
          `No ${CATEGORY.supportGem} entry "${support.id}".`,
        );
      }
      // Read off `supportLinks`, so this also catches an out-of-range `gemPercent` inherited by
      // a support gem that states no roll of its own.
      validateGemRoll(support, snapshot, `skills[${i}].supports[${j}]`, add);
    }
    validateSupportExclusivity(skill, snapshot, i, add);

    // `min_lvl` and `max_lvl` are **not** two ends of one range, and reading them as one is
    // how `protection` came to be reported as "levels 15-12":
    //
    //     public int getMaxLevel()        { return max_lvl; }   // the spell's top rank
    //     public int getRequiredLevel()   { return min_lvl; }   // the CHARACTER level to use it
    //
    // — Spell.java:581-593. `min_lvl` gates the caster, not the rank, so a spell that unlocks
    // at character level 15 and ranks to 12 is perfectly ordinary.
    if (spell) {
      // The rank ceiling is `max_lvl` plus the bonus ranks gear and perks may add:
      //
      //     spell.bonus_ranks = MathHelper.clamp(spell.bonus_ranks, 0, MAX_BONUS_SPELL_LEVELS);
      //     spell.rank += spell.bonus_ranks;
      //
      // — SpellCastingData.calcSpellLevels:135-139, which is `getMaxLevelWithBonuses()`. A
      // unique that grants "+2 to buff spell levels" puts a 20-rank spell at 22 legally.
      if (skill.level !== undefined) {
        const maxRank = numberField(spell, "max_lvl") ?? 16;
        const bonus = maxBonusSpellLevels(snapshot);
        const ceiling = maxRank + bonus;
        // `getLevelOf` floors at `default_lvl`, which is 0 for every spell in this pack — but
        // a slotted spell the document names is one the character has, so rank 0 is a bug.
        if (!Number.isInteger(skill.level) || skill.level < 1 || skill.level > ceiling) {
          add(
            "error",
            "spell-level-out-of-range",
            `skills[${i}].level`,
            `"${skill.spellId}" ranks 1-${maxRank} (+${bonus} bonus, so ${ceiling} at most), ` +
              `got ${skill.level}.`,
          );
        }
      }

      // The character-level gate, which nothing checked before.
      const requiredLevel = numberField(spell, "min_lvl") ?? 1;
      if (doc.character.level < requiredLevel) {
        add(
          "error",
          "spell-below-required-level",
          `skills[${i}].spellId`,
          `"${skill.spellId}" needs character level ${requiredLevel}, character is ` +
            `${doc.character.level}.`,
        );
      }
    }

    if (skill.gemPercent !== undefined) {
      if (!Number.isFinite(skill.gemPercent) || skill.gemPercent < 0) {
        add(
          "error",
          "gem-percent-out-of-range",
          `skills[${i}].gemPercent`,
          `A gem's roll is a non-negative percent, got ${skill.gemPercent}.`,
        );
      } else if (skill.gemPercent > GEM_PERCENT_BAND_MAX) {
        add("warning", "gem-percent-above-band", `skills[${i}].gemPercent`, abovePercentBand(skill.gemPercent));
      }
    }

    if (skill.main === true) mains += 1;
  }

  if (mains > 1) {
    add("error", "multiple-main-skills", "skills", `${mains} skills are marked \`main\`; at most one may be.`);
  }

  // `GemInventoryHelper.MAX_SKILL_GEMS` is 8 and the skill-gem inventory is sized from it, so a
  // ninth active Skill has no hotbar slot to sit in. Disabled Skills are exempt: keeping the
  // setup you are comparing against is what `enabled` is for.
  const active = activeSkillCount(doc.skills);
  if (active > MAX_ACTIVE_SKILLS) {
    add(
      "error",
      "too-many-active-skills",
      "skills",
      `${active} Skills are enabled and the hotbar holds ${MAX_ACTIVE_SKILLS} ` +
        "(`GemInventoryHelper.MAX_SKILL_GEMS`). Disable " +
        `${active - MAX_ACTIVE_SKILLS} of them — a disabled Skill keeps its level and its ` +
        "support gems and contributes nothing.",
    );
  }

  validateEnemy(doc, snapshot, add);

  const seenAuras = new Set<string>();
  for (const [i, aura] of (doc.auras ?? []).entries()) {
    if (!has(snapshot, CATEGORY.aura, aura.id)) {
      add("error", "unknown-aura", `auras[${i}].id`, `No ${CATEGORY.aura} entry "${aura.id}".`);
    }
    validateGemRoll(aura, snapshot, `auras[${i}]`, add);
    if (seenAuras.has(aura.id)) {
      add("error", "duplicate-aura", `auras[${i}].id`, `"${aura.id}" is listed more than once.`);
    }
    seenAuras.add(aura.id);
  }

  // One food per slot: `PlayerBuffData.map` is keyed by `Type`, so eating a second meal
  // replaces the first rather than stacking with it.
  const seenSlots = new Set<FoodBuffSlot>();
  for (const [i, buff] of (doc.foodBuffs ?? []).entries()) {
    if (!has(snapshot, CATEGORY.statBuff, buff.id)) {
      add("error", "unknown-stat-buff", `foodBuffs[${i}].id`, `No ${CATEGORY.statBuff} entry "${buff.id}".`);
    }
    if (buff.slot !== undefined) {
      if (!FOOD_BUFF_SLOTS.includes(buff.slot)) {
        add(
          "error",
          "unknown-food-slot",
          `foodBuffs[${i}].slot`,
          `Expected one of ${FOOD_BUFF_SLOTS.join(", ")}, got "${buff.slot}".`,
        );
      } else if (seenSlots.has(buff.slot)) {
        add(
          "error",
          "duplicate-food-slot",
          `foodBuffs[${i}].slot`,
          `Two foods claim the "${buff.slot}" slot; the game keeps only the later one.`,
        );
      }
      seenSlots.add(buff.slot);
    }
    if (buff.rollPercent !== undefined && (!Number.isFinite(buff.rollPercent) || buff.rollPercent < 0 || buff.rollPercent > 100)) {
      add(
        "error",
        "food-roll-out-of-range",
        `foodBuffs[${i}].rollPercent`,
        `The crafted roll is 0-100 before the level is added to it, got ${buff.rollPercent}.`,
      );
    }
    // `PlayerBuffData.tryAdd` refuses outright: `if (lvl > Load.Unit(p).getLevel())`.
    if (buff.level !== undefined) {
      if (!Number.isInteger(buff.level) || buff.level < 1) {
        add("error", "bad-food-level", `foodBuffs[${i}].level`, `Must be a positive integer, got ${buff.level}.`);
      } else if (buff.level > doc.character.level) {
        add(
          "error",
          "food-above-character-level",
          `foodBuffs[${i}].level`,
          `A level ${buff.level} food cannot be eaten by a level ${doc.character.level} character.`,
        );
      }
    }
  }

  for (const [i, effect] of (doc.exileEffects ?? []).entries()) {
    if (!has(snapshot, CATEGORY.exileEffect, effect.id)) {
      add("error", "unknown-exile-effect", `exileEffects[${i}].id`, `No ${CATEGORY.exileEffect} entry "${effect.id}".`);
    }
    if (effect.stacks !== undefined && (!Number.isInteger(effect.stacks) || effect.stacks < 1)) {
      add("error", "bad-stack-count", `exileEffects[${i}].stacks`, `Must be a positive integer, got ${effect.stacks}.`);
    }
  }

  for (const conditionId of Object.keys(doc.config?.conditions ?? {})) {
    if (!has(snapshot, CATEGORY.statCondition, conditionId)) {
      add(
        "error",
        "unknown-condition",
        `config.conditions.${conditionId}`,
        "No mmorpg_stat_condition entry with this id.",
      );
    }
  }
}

/**
 * The declared target.
 *
 * These are assumptions rather than facts about the game, so the checks are only about being
 * *expressible* — a resist keyed on an element that does not exist would silently never be
 * read, which is exactly the class of quiet failure this package exists to prevent.
 */
function validateEnemy(doc: BuildDoc, snapshot: Snapshot, add: Add): void {
  const placement = doc.config?.target;
  if (placement) {
    for (const field of ["distance", "radius", "height"] as const) {
      const value = placement[field];
      if (!Number.isFinite(value) || value < 0) {
        add(
          "error",
          "bad-target-placement",
          `config.target.${field}`,
          `Must be a non-negative number, got ${JSON.stringify(value)}.`,
        );
      }
    }
    if (!Number.isFinite(placement.bearing)) {
      add(
        "error",
        "bad-target-placement",
        "config.target.bearing",
        `Must be a number of degrees, got ${JSON.stringify(placement.bearing)}.`,
      );
    }
  }

  const pack = doc.config?.packSize;
  if (pack !== undefined && (!Number.isInteger(pack) || pack < 1)) {
    add("error", "bad-pack-size", "config.packSize", `Must be a positive integer, got ${JSON.stringify(pack)}.`);
  }

  const preset = doc.config?.targetPreset;
  if (preset !== undefined && !isTargetPresetId(preset)) {
    add(
      "warning",
      "unknown-target-preset",
      "config.targetPreset",
      `No such target preset \`${preset}\`. The enemy block is still read as written; only the ` +
        `record of where it came from is unrecognised.`,
    );
  }

  for (const [id, hits] of Object.entries(doc.config?.coverageOverrides ?? {})) {
    if (!Number.isFinite(hits) || hits < 0) {
      add(
        "error",
        "bad-coverage-override",
        `config.coverageOverrides.${id}`,
        `Must be a non-negative number of hits per cast, got ${JSON.stringify(hits)}.`,
      );
    }
  }

  const enemy = doc.config?.enemy;
  if (!enemy) return;

  if (enemy.level !== undefined && (!Number.isInteger(enemy.level) || enemy.level < 1)) {
    add("error", "bad-enemy-level", "config.enemy.level", `Must be a positive integer, got ${enemy.level}.`);
  }

  for (const field of ["resists", "maxResists"] as const) {
    const table = enemy[field];
    if (!table) continue;
    for (const [guid, value] of Object.entries(table)) {
      const at = `config.enemy.${field}.${guid}`;
      if (!ELEMENT_GUIDS.includes(guid)) {
        add(
          "error",
          "unknown-element",
          at,
          `Not an element GUID. Expected one of ${ELEMENT_GUIDS.join(", ")} — note the enum names \`Cold\`, \`Nature\` and \`Shadow\` are spelled \`water\`, \`lightning\` and \`chaos\` in ids.`,
        );
      }
      if (!Number.isFinite(value)) {
        add("error", "bad-enemy-resist", at, `Must be a finite number, got ${JSON.stringify(value)}.`);
      }
    }
  }

  for (const field of ["armor", "blockChance", "dodge", "damageReduction"] as const) {
    const value = enemy[field];
    if (value !== undefined && !Number.isFinite(value)) {
      add("error", "bad-enemy-stat", `config.enemy.${field}`, `Must be a finite number, got ${JSON.stringify(value)}.`);
    }
  }

  // Mob affixes. An id the snapshot does not have is an error rather than a warning: naming the
  // affix instead of typing its armour is the whole point, and a name nothing resolves is a
  // document describing a mob this pack cannot make. A duplicate is harmless — the engine counts
  // it once, as `MobAffixesData` would — but it is still not a mob the game rolls.
  const affixes = enemy.affixes ?? [];
  const seen = new Set<string>();
  for (const [i, id] of affixes.entries()) {
    if (!has(snapshot, CATEGORY.mobAffix, id)) {
      add(
        "error",
        "unknown-mob-affix",
        `config.enemy.affixes[${i}]`,
        `No ${CATEGORY.mobAffix} entry "${id}".`,
      );
      continue;
    }
    if (seen.has(id)) {
      add(
        "warning",
        "duplicate-mob-affix",
        `config.enemy.affixes[${i}]`,
        `"${id}" is listed twice. It counts once, the way a mob can only carry it once.`,
      );
    }
    seen.add(id);
  }
}

function numberField(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Equipment: how many of each slot, and what a two-handed weapon does to the offhand
// ---------------------------------------------------------------------------

/**
 * Whether the gear list describes a loadout a character could actually be wearing.
 *
 * This was deliberately unchecked until now — phase 0.5 recorded "how many items share a gear
 * slot (two rings?) is not in the datapack" and left it. That was right about the datapack and
 * wrong about the mod: `characters/CharacterEquipment.java` states the worn loadout outright,
 * because switching characters has to relocate every worn stack. See {@link SLOT_CAPACITY}.
 *
 * Capacity overflow is an **error**: two necklaces is not a build the game can produce, it is a
 * typo or a pair of alternatives someone forgot to delete, and either way every stat on the
 * extra one is being counted. A slot the mod says nothing about (`elytra`, `head`) is not
 * checked at all rather than assumed to hold one.
 */
function validateEquipment(doc: BuildDoc, snapshot: Snapshot, add: Add): void {
  const gear = doc.gear ?? [];
  if (gear.length === 0) return;

  const perSlot = new Map<string, number[]>();
  const perFamily = new Map<string, number[]>();

  for (const [i, item] of gear.entries()) {
    const base = baseGearType(snapshot, item.base);
    const slotId = base?.gearSlot;
    if (slotId === undefined) continue;

    perSlot.set(slotId, [...(perSlot.get(slotId) ?? []), i]);
    const family = slotFamily(snapshot, slotId);
    if (family !== undefined) perFamily.set(family, [...(perFamily.get(family) ?? []), i]);
  }

  for (const [slotId, indices] of perSlot) {
    const cap = slotCapacity(slotId);
    if (cap === undefined || indices.length <= cap) continue;
    add(
      "error",
      "slot-over-capacity",
      `gear[${indices[cap]!}]`,
      `A character has ${cap} "${slotId}" slot${cap === 1 ? "" : "s"} (CharacterEquipment.java), ` +
        `but ${indices.length} items are in it: ${indices.map((i) => `gear[${i}]`).join(", ")}.`,
    );
  }

  for (const [family, indices] of perFamily) {
    const cap = slotFamilyCapacity(family);
    if (cap === undefined || indices.length <= cap) continue;
    add(
      "error",
      "slot-family-over-capacity",
      `gear[${indices[cap]!}]`,
      `A character has ${cap} ${family} slot${cap === 1 ? "" : "s"}, but ${indices.length} items ` +
        `fill it: ${indices.map((i) => `gear[${i}]`).join(", ")}. Which *kind* of weapon or ` +
        `offhand is a choice; how many is not.`,
    );
  }

  validateTwoHanded(doc, snapshot, perFamily, add);
}

/**
 * A two-handed weapon empties the offhand — so an offhand item beside one is contributing zero.
 *
 * The rule is **Better Combat's**, not Mine and Slash's; `two_handed` appears nowhere in the
 * mod source. `net.bettercombat.mixin.PlayerEntityMixin.getEquippedStack_Pre` intercepts
 * `getItemBySlot`, and when the slot is `OFFHAND` and a two-handed weapon is wielded it sets
 * the return value to `ItemStack.EMPTY` and cancels the call. Mine and Slash's `GearData` reads
 * that empty stack like any other, so the offhand grants nothing at all.
 *
 * Reported as an **error** rather than a warning for exactly that reason: the engine would
 * otherwise sum an offhand the game gives you nothing for, and a build planned around a shield
 * behind a greatsword is a build whose armour number is wrong.
 */
function validateTwoHanded(
  doc: BuildDoc,
  snapshot: Snapshot,
  perFamily: ReadonlyMap<string, number[]>,
  add: Add,
): void {
  const gear = doc.gear ?? [];
  const offhands = perFamily.get("OffHand") ?? [];
  if (offhands.length === 0) return;

  for (const index of perFamily.get("Weapon") ?? []) {
    const item = gear[index];
    if (item === undefined || !isTwoHanded(snapshot, item.base)) continue;
    add(
      "error",
      "offhand-with-two-handed-weapon",
      `gear[${offhands[0]!}]`,
      `"${item.base}" is two-handed, so Better Combat returns an empty offhand while it is held ` +
        `(PlayerEntityMixin.getEquippedStack_Pre) and ${
          offhands.length === 1 ? "this item grants" : "these items grant"
        } nothing. Remove ${offhands.map((i) => `gear[${i}]`).join(", ")}, or use a one-handed weapon.`,
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// Stat points
// ---------------------------------------------------------------------------

/**
 * Level-up points spent on core stats.
 *
 * Three rules, all from `AllocateStatPacket.onReceived` and `PlayerPointsType.getFreePoints`:
 *
 *   - the key must be a `CoreStat` — the packet rejects anything else outright, and an
 *     unregistered id resolves to `EmptyStat` rather than erroring, so a typo silently does
 *     nothing in game and must not silently do something here;
 *   - points are whole and non-negative, because the map is `HashMap<String, Integer>` and
 *     the only writes are `+1` and `-1`;
 *   - the total is bounded by `base_points + points_per_lvl * level`, capped at
 *     `max_total_points`. Spending past that but within `max_bonus_points` is a **warning**,
 *     not an error: bonus points come from sources a build document cannot see, exactly as
 *     with the tree budgets.
 */
function validateStatPoints(doc: BuildDoc, snapshot: Snapshot, balanceId: string, add: Add): void {
  const allocated = doc.character.statPoints;
  if (allocated === undefined) return;

  const legal = coreStatIds(snapshot);
  let spent = 0;

  for (const [statId, points] of Object.entries(allocated)) {
    const at = `character.statPoints.${statId}`;

    if (legal.length > 0 && !legal.includes(statId)) {
      add(
        "error",
        "not-a-core-stat",
        at,
        `AllocateStatPacket only accepts a CoreStat. Allocatable stats are: ${legal.join(", ")}.`,
      );
      continue;
    }
    if (!Number.isInteger(points) || points < 0) {
      add("error", "bad-stat-point-count", at, `Must be a non-negative whole number, got ${points}.`);
      continue;
    }
    spent += points;
  }

  if (spent === 0) return;

  checkPointSpend(doc, snapshot, balanceId, "STATS", spent, "character.statPoints", "points spent", {
    over: "stat-points-over-budget",
    beyondLevelling: "stat-points-beyond-levelling",
    unknown: "no-stat-point-budget",
  }, add);
}

// ---------------------------------------------------------------------------
// Spell schools
// ---------------------------------------------------------------------------

/**
 * Whether the school allocation is one the game would have let a player make.
 *
 * Four rules, all from `SpellSchoolsData.canLearn` and `SpellSchool`:
 *
 *  1. **At most two schools.** "MAX_2_CLASSES".
 *  2. **Never past `max_lvls`.** "PERK_MAXED".
 *  3. **The row gates the first point** — `lvl_reqs[point.y]` — and every point after it costs
 *     one more character level, compared **strictly**: `getLevel() > baselvl + bonus`.
 *  4. **Two separate budgets.** Spell perks spend `SPELLS`, everything else `PASSIVES`.
 *
 * Where `character.pointTotals` is present it wins over the level-derived budget, because only
 * the game knows `getBonusPoints` — quest and item rewards a document cannot derive. That is
 * what stops a legitimately boosted character reading as an overspend.
 */
function validateSchools(doc: BuildDoc, snapshot: Snapshot, balanceId: string, add: Add): void {
  const allocated = doc.character.schools;
  if (allocated === undefined) return;

  const level = doc.character.level;
  const spellsPerLevel = pointsPerLevel(snapshot, "SPELLS", balanceId);
  const spent: Record<"SPELLS" | "PASSIVES", number> = { SPELLS: 0, PASSIVES: 0 };

  for (const [perkId, perkLevel] of Object.entries(allocated)) {
    const at = `character.schools.${perkId}`;

    if (!Number.isInteger(perkLevel) || perkLevel < 0) {
      add("error", "bad-school-level", at, `Must be a non-negative whole number, got ${perkLevel}.`);
      continue;
    }
    if (perkLevel === 0) continue;

    const view = perk(snapshot, perkId);
    if (!view) {
      add("error", "unknown-school-perk", at, `No ${CATEGORY.perk} entry \`${perkId}\`.`);
      continue;
    }

    spent[perkPointType(snapshot, perkId)] += perkLevel;

    if (perkLevel > view.maxLevels) {
      add(
        "error",
        "school-perk-over-max",
        at,
        `Level ${perkLevel} on a perk whose \`max_lvls\` is ${view.maxLevels}.`,
      );
    }

    const schoolId = schoolOfPerk(snapshot, perkId);
    if (schoolId === undefined) {
      add(
        "error",
        "perk-not-in-any-school",
        at,
        `\`${perkId}\` is in no spell school's grid, so no screen in the game can allocate it. ` +
          `\`SpellSchoolsData.school()\` removes such an entry on its next read.`,
      );
      continue;
    }

    const school = spellSchool(snapshot, schoolId);
    const point = school?.perks.get(perkId);
    if (!school || !point) continue;

    const needed = levelNeededForNextPerkLevel(school, point, perkLevel - 1, spellsPerLevel);
    if (level < needed) {
      const rowReq = school.levelForRow(point.y);
      add(
        "error",
        "school-level-requirement",
        at,
        perkLevel === 1
          ? `Row ${point.y} of \`${schoolId}\` needs character level ${rowReq}; this character is ${level}.`
          : `Level ${perkLevel} of \`${perkId}\` needs character level ${needed} — row ${point.y} ` +
            `requires ${rowReq} and each level past the first costs one more. This character is ${level}.`,
      );
    }
  }

  const schools = allocatedSchools(snapshot, doc);
  if (schools.length > MAX_SCHOOLS) {
    add(
      "error",
      "too-many-schools",
      "character.schools",
      `Points in ${schools.length} schools (${schools.join(", ")}); the game allows ${MAX_SCHOOLS}.`,
    );
  }

  for (const pool of ["SPELLS", "PASSIVES"] as const) {
    if (spent[pool] === 0) continue;
    checkPointSpend(
      doc,
      snapshot,
      balanceId,
      pool,
      spent[pool],
      "character.schools",
      `${pool} point(s) spent`,
      {
        over: "school-points-over-budget",
        beyondLevelling: "school-points-beyond-levelling",
        unknown: "no-school-point-budget",
      },
      add,
    );
  }
}

// ---------------------------------------------------------------------------
// The omen
// ---------------------------------------------------------------------------

/**
 * Whether the omen describes one the game could have generated.
 *
 * An omen is not gear and its legality is a different shape. There is no roll on its own mods
 * — `OmenData.getStatPercent` derives one from the requirements — so what has to be checked is
 * the requirements themselves, which `OmenBlueprint` generates within the bands
 * `GearRarity.omens` declares per rarity:
 *
 *     public OmenDifficulty(MinMax runed, MinMax normal, MinMax unique,
 *                           MinMax specific_slots, MinMax affixes, float stat_multi)
 *
 * Those bands are checked as **warnings**, not errors. The generator is the only thing that
 * enforces them, and an omen can be modified after it drops — `OmenModification`, the
 * `upgrade_omen_rarity` currency and `RerollOmenStatsItemMod` all change one in place — so a
 * combination outside a band is suspicious rather than impossible. The things that *are*
 * errors are the ones no code path can produce: an unknown id, a rarity type that is not one
 * of the three, a negative count.
 */
function validateOmen(doc: BuildDoc, snapshot: Snapshot, add: Add): void {
  const setup = doc.omen;
  if (setup === undefined) return;

  const view = omen(snapshot, setup.id);
  if (!view) {
    add("error", "unknown-omen", "omen.id", `No ${CATEGORY.omen} entry "${setup.id}".`);
  }

  const rarity = gearRarity(snapshot, setup.rarity);
  if (!rarity) {
    add("error", "unknown-omen-rarity", "omen.rarity", `No ${CATEGORY.gearRarity} entry "${setup.rarity}".`);
  }

  if (!Number.isInteger(setup.itemLevel) || setup.itemLevel < 1) {
    add("error", "bad-omen-level", "omen.itemLevel", `Must be a whole level of 1 or more, got ${setup.itemLevel}.`);
  } else if (view !== undefined) {
    // `OmenPart.DroppableOmens` filters on `lvl >= MAX_LEVEL * lvl_req`, so `lvl_req` is a
    // *fraction*. Every omen in this pack is 0.5, i.e. level 50 at MAX_LEVEL 100.
    const min = omenMinLevel(snapshot, view);
    if (setup.itemLevel < min) {
      add(
        "warning",
        "omen-below-drop-level",
        "omen.itemLevel",
        `"${setup.id}" only drops at level ${min} or above (lvl_req ${view.levelRequirementFraction} ` +
          `of MAX_LEVEL), and this one is ${setup.itemLevel}.`,
      );
    }
  }

  for (const [type, count] of Object.entries(setup.requires ?? {})) {
    const at = `omen.requires.${type}`;
    if (!isGearRarityType(type)) {
      add(
        "error",
        "unknown-rarity-type",
        at,
        `Omen requirements are counted over GearRarityType, which is one of ${GEAR_RARITY_TYPES.join(", ")}.`,
      );
      continue;
    }
    if (!Number.isInteger(count) || count < 0) {
      add("error", "bad-omen-requirement", at, `Must be a non-negative whole number, got ${count}.`);
      continue;
    }
    // `OmenDifficulty` names its bands after the lowercased type.
    const band = omenBand(snapshot, setup.rarity, type.toLowerCase());
    if (band !== undefined && (count < band.min || count > band.max)) {
      add(
        "warning",
        "omen-requirement-outside-band",
        at,
        `A "${setup.rarity}" omen generates ${band.min}..${band.max} ${type} pieces, not ${count}. ` +
          `Legal if it was modified after dropping; impossible straight out of the generator.`,
      );
    }
  }

  for (const [i, req] of (setup.slotRequirements ?? []).entries()) {
    const at = `omen.slotRequirements[${i}]`;
    if (!has(snapshot, CATEGORY.gearSlot, req.slot)) {
      add("error", "unknown-slot", `${at}.slot`, `No ${CATEGORY.gearSlot} entry "${req.slot}".`);
    } else if (!omenCountsSlot(snapshot, req.slot)) {
      // `Omen.getRandomSlotReq` excludes weapons outright, with the reason in a comment:
      // "they're a lot of times swapped". And `recalcGears` never reads the mainhand anyway,
      // so a weapon requirement could never be met.
      add(
        "error",
        "omen-slot-requirement-on-weapon",
        `${at}.slot`,
        `"${req.slot}" is a mainhand slot. Omen counting never reads the mainhand ` +
          `(CachedEntityStats.recalcGears), and Omen.getRandomSlotReq excludes weapons, so this ` +
          `requirement could never be satisfied.`,
      );
    }
    if (!isGearRarityType(req.rarityType)) {
      add(
        "error",
        "unknown-rarity-type",
        `${at}.rarityType`,
        `Must be one of ${GEAR_RARITY_TYPES.join(", ")}, got "${req.rarityType}".`,
      );
    }
  }

  const slotBand = omenBand(snapshot, setup.rarity, "specific_slots");
  const slotCount = (setup.slotRequirements ?? []).length;
  if (slotBand !== undefined && (slotCount < slotBand.min || slotCount > slotBand.max)) {
    add(
      "warning",
      "omen-slot-count-outside-band",
      "omen.slotRequirements",
      `A "${setup.rarity}" omen generates ${slotBand.min}..${slotBand.max} slot requirements, not ${slotCount}.`,
    );
  }

  // The omen's affix pool is its own: `Omen.affix_types` is `chaos_stat` throughout this pack,
  // which is the corruption pool rather than the prefix/suffix one.
  const legalTypes = view?.affixTypes ?? [];
  for (const [i, roll] of (setup.affixes ?? []).entries()) {
    const at = `omen.affixes[${i}]`;
    const affixView = affix(snapshot, roll.affixId);
    if (!affixView) {
      add("error", "unknown-affix", `${at}.affixId`, `No ${CATEGORY.affix} entry "${roll.affixId}".`);
      continue;
    }
    if (legalTypes.length > 0 && !legalTypes.includes(affixView.type)) {
      add(
        "error",
        "affix-type-not-on-omen",
        at,
        `"${roll.affixId}" is a ${affixView.type}; "${setup.id}" accepts ${legalTypes.join(", ")}.`,
      );
    }
    // An omen's affixes carry their own tier and roll exactly as an item's do; the omen's
    // rarity bounds them the same way an item's rarity bounds its affixes.
    validateTier(roll, "chaos_stat", snapshot, rarity, at, add);
  }

  const affixBand = omenBand(snapshot, setup.rarity, "affixes");
  const affixCountOnOmen = (setup.affixes ?? []).length;
  if (affixBand !== undefined && (affixCountOnOmen < affixBand.min || affixCountOnOmen > affixBand.max)) {
    add(
      "warning",
      "omen-affix-count-outside-band",
      "omen.affixes",
      `A "${setup.rarity}" omen generates ${affixBand.min}..${affixBand.max} affixes, not ${affixCountOnOmen}.`,
    );
  }
}

/** One `MinMax` out of a rarity's `omens` block, by field name. */
function omenBand(
  snapshot: Snapshot,
  rarityId: string,
  field: string,
): { min: number; max: number } | undefined {
  const data = entry(snapshot, CATEGORY.gearRarity, rarityId)?.data;
  const omens = data?.["omens"];
  if (omens === null || typeof omens !== "object" || Array.isArray(omens)) return undefined;
  const band = (omens as Record<string, unknown>)[field];
  if (band === null || typeof band !== "object" || Array.isArray(band)) return undefined;
  const node = band as Record<string, unknown>;
  const min = node["min"];
  const max = node["max"];
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  return { min, max };
}
