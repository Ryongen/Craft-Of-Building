import assert from "node:assert/strict";
import { test } from "node:test";

import {
  affixCount,
  affixesFor,
  allowedAffixTiers,
  basesForSlot,
  gearRarity,
  maxOfOneAffixType,
  meetsTagRequirement,
  perk,
  perksOfKind,
  PACK_MAX_BONUS_POINTS,
  pointBudget,
  treeGrid,
  uniquesForBase,
} from "./queries.js";
import { RARITIES, grid, makeSnapshot, standardSnapshot } from "./test-support.js";

test("affix count is exact, not a floor", () => {
  const snapshot = standardSnapshot();
  // `min_affixes` reads like a minimum but GearAffixesData.randomize() tops the item up to
  // exactly that many, so common items always have 1 affix and mythic always 6.
  const counts = ["common", "uncommon", "rare", "epic", "legendary", "mythic"].map((id) =>
    affixCount(gearRarity(snapshot, id)!),
  );
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6]);
});

test("per-type ceiling is the rounded-up half, not maximumOfOneAffixType", () => {
  const snapshot = standardSnapshot();
  // IGearRarity.maximumOfOneAffixType() returns min_affixes / 2, but the top-up loop in
  // randomize() can exceed it by one on odd counts: legendary ends up 3 prefixes / 2
  // suffixes even though the method reports 2.
  assert.equal(maxOfOneAffixType(gearRarity(snapshot, "legendary")!), 3);
  assert.equal(maxOfOneAffixType(gearRarity(snapshot, "mythic")!), 3);
  assert.equal(maxOfOneAffixType(gearRarity(snapshot, "rare")!), 2);
  assert.equal(maxOfOneAffixType(gearRarity(snapshot, "common")!), 1);
});

test("tag requirements: excluded wins over included", () => {
  const req = { reqType: "INCLUDES_ANY", included: ["weapon_family"], excluded: ["bow"] };
  assert.equal(meetsTagRequirement(req, ["weapon_family", "sword"]), true);
  assert.equal(meetsTagRequirement(req, ["weapon_family", "bow"]), false);
});

test("tag requirements: HAS_ALL needs every tag, INCLUDES_ANY needs one", () => {
  const all = { reqType: "HAS_ALL", included: ["leather", "boots"], excluded: [] };
  assert.equal(meetsTagRequirement(all, ["leather", "boots", "armor_family"]), true);
  assert.equal(meetsTagRequirement(all, ["leather"]), false);

  const any = { reqType: "INCLUDES_ANY", included: ["leather", "boots"], excluded: [] };
  assert.equal(meetsTagRequirement(any, ["leather"]), true);
  assert.equal(meetsTagRequirement(any, ["plate"]), false);
});

test("an unrecognised req_type never silently passes", () => {
  const req = { reqType: "SOMETHING_NEW", included: ["armor_family"], excluded: [] };
  assert.equal(meetsTagRequirement(req, ["armor_family"]), false);
});

test("affixesFor filters by type and by the base's tags", () => {
  const snapshot = standardSnapshot();

  const bowPrefixes = affixesFor(snapshot, "bow", "prefix").map((a) => a.id);
  assert.deepEqual(bowPrefixes, ["weapon_prefix"]);

  // no_bow_suffix targets weapon_family but excludes bow, so a bow must not offer it.
  const bowSuffixes = affixesFor(snapshot, "bow", "suffix").map((a) => a.id);
  assert.deepEqual(bowSuffixes, []);

  // HAS_ALL: boots carry both `leather` and `boots`, so the paired requirement matches.
  const bootPrefixes = affixesFor(snapshot, "boots", "prefix").map((a) => a.id).sort();
  assert.deepEqual(bootPrefixes, ["armor_prefix", "group_a_prefix", "leather_boots_prefix", "solo_prefix"]);

  assert.deepEqual(affixesFor(snapshot, "necklace", "prefix"), []);
});

test("allowed affix tiers exclude uniques and anything above the item", () => {
  const snapshot = standardSnapshot();
  const onRare = allowedAffixTiers(snapshot, gearRarity(snapshot, "rare")!).sort();
  assert.deepEqual(onRare, ["common", "rare", "uncommon"]);

  // `unique` has item_tier 5 but is_unique_item, so even mythic must not offer it.
  const onMythic = allowedAffixTiers(snapshot, gearRarity(snapshot, "mythic")!);
  assert.equal(onMythic.includes("unique"), false);
  assert.equal(onMythic.length, 6);
});

test("rarity roll bands do not overlap", () => {
  // Non-overlapping bands are what make a roll percent identify its tier, and what makes an
  // out-of-band roll a hard error rather than a judgement call.
  const ladder = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
  let previousMax = -1;
  for (const id of ladder) {
    const band = (RARITIES[id] as { stat_percents: { min: number; max: number } }).stat_percents;
    assert.ok(band.min > previousMax, `${id} band starts at ${band.min}, overlapping the previous tier`);
    previousMax = band.max;
  }
  assert.equal(previousMax, 100);
});

test("tree cells are classified by token length, exactly as GridPoint does", () => {
  const snapshot = standardSnapshot();
  const tree = treeGrid(snapshot, "talents")!;

  assert.equal(tree.rows, 8);
  assert.equal(tree.cols, 9);
  // `E` is a single character, so the game classifies it as a connector on channel "e" —
  // not as empty. The ring exists to stop its unguarded 3x3 reads running off the array.
  assert.deepEqual(tree.cellAt(0, 0), { kind: "connector", raw: "E", id: "e", glyph: "e" });
  assert.equal(tree.cellAt(1, 1)?.kind, "empty");
  assert.equal(tree.cellAt(2, 2)?.kind, "perk");
  assert.equal(tree.cellAt(2, 2)?.perkId, "start");
  assert.equal(tree.cellAt(6, 4)?.kind, "center");
  assert.deepEqual(tree.center, [6, 4]);
  // Connector glyphs are channel ids, not line directions.
  assert.equal(tree.cellAt(2, 3)?.glyph, "o");
  assert.equal(tree.cellAt(3, 4)?.glyph, "k");
  assert.equal(tree.perkCellCount, 5);
  assert.deepEqual(tree.unknownPerkIds, []);
  assert.equal(tree.cellAt(99, 99), undefined);
});

test("a grid token naming no registered perk is still a node, and is reported", () => {
  const snapshot = makeSnapshot({
    mmorpg_perk: { real_perk: { id: "real_perk", type: "STAT", stats: [] } },
    mmorpg_talent_tree: {
      talents: grid([
        ["E", "E", "E"],
        ["E", "real_perk", "E"],
        ["E", "ghost_perk", "E"],
      ]),
    },
  });
  const tree = treeGrid(snapshot, "talents")!;
  // `TalentTree.CalcData.getPerk` resolves the miss to UnknownStat rather than dropping the
  // cell, so it still occupies a position and still costs a point.
  assert.equal(tree.cellAt(2, 1)?.kind, "perk");
  assert.equal(tree.perkCellCount, 2);
  assert.deepEqual(tree.unknownPerkIds, ["ghost_perk"]);
});

test("perk views expose the fields that decide allocation", () => {
  const snapshot = standardSnapshot();
  assert.deepEqual(perk(snapshot, "start"), {
    id: "start",
    type: "START",
    isEntry: true,
    oneKind: "start",
    maxLevels: 1,
    icon: "",
  });
  assert.equal(perk(snapshot, "armor_flat")?.isEntry, false);
  assert.equal(perk(snapshot, "armor_flat")?.oneKind, undefined);
  assert.deepEqual(perksOfKind(snapshot, "start"), ["start", "start_b"]);
  assert.equal(perk(snapshot, "nope"), undefined);
});

test("point budgets separate what levelling gives from what is merely obtainable", () => {
  const snapshot = standardSnapshot();
  const atTen = pointBudget(snapshot, "talents", 10)!;
  assert.equal(atTen.fromLevel, 11); // base_points 1 + 1/level
  assert.equal(atTen.ceiling, 36); // + 25 bonus points from other sources

  // Caps bite before the ceiling does.
  const atMax = pointBudget(snapshot, "talents", 100)!;
  assert.equal(atMax.fromLevel, 101);
  assert.equal(atMax.ceiling, 126);

  // Ascendancy points do not come from levelling at all.
  const asc = pointBudget(snapshot, "ascendancy", 100)!;
  assert.equal(asc.fromLevel, 0);
  assert.equal(asc.ceiling, 9);
});

test("the pack's atlas total overrides the balance file's cap, and never raises one", () => {
  // `max_bonus_points` bounds `getBonusPoints`; it is not a statement of how many the pack gives.
  // Craft to Exile 2 ships the mod's own 200 for ATLAS and awards 104, so a planner offered twice
  // the tree anyone can allocate — see `PACK_MAX_BONUS_POINTS`.
  const snapshot = standardSnapshot();
  const atlas = pointBudget(snapshot, "atlas", 100)!;
  assert.equal(atlas.fromLevel, 0);
  assert.equal(atlas.maxBonus, 104);
  assert.equal(atlas.ceiling, 104);

  // The test snapshot's ATLAS allows 200 bonus, so 104 binding proves the override applied. A
  // pack that allowed fewer than the override would keep its own smaller number: the entry says
  // what this pack awards, not what the mod permits.
  assert.ok(PACK_MAX_BONUS_POINTS.ATLAS !== undefined && PACK_MAX_BONUS_POINTS.ATLAS <= 200);
});

test("lookups by slot and by unique base", () => {
  const snapshot = standardSnapshot();
  assert.deepEqual(basesForSlot(snapshot, "bow").map((b) => b.id), ["bow"]);
  assert.deepEqual(uniquesForBase(snapshot, "bow").map((u) => u.id), ["windrunner"]);
  assert.deepEqual(uniquesForBase(snapshot, "boots"), []);
});
