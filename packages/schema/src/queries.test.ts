import assert from "node:assert/strict";
import { test } from "node:test";

import {
  affixCount,
  affixesFor,
  jewelAffixesFor,
  jewelCorruptionAffixes,
  watcherEyeAffixes,
  jewelTags,
  allowedAffixTiers,
  basesForSlot,
  enchantCompats,
  attributeName,
  enchantName,
  gearRarity,
  maxOfOneAffixType,
  maxQuality,
  meetsTagRequirement,
  perk,
  perksOfKind,
  EPILOGUE_BONUS_POINTS,
  infusionRollPercent,
  PACK_MAX_BONUS_POINTS,
  pointBudget,
  pointsAvailable,
  rarityLadder,
  treeGrid,
  uniquesForBase,
} from "./queries.js";
import { RARITIES, grid, makeSnapshot, standardSnapshot, type Registries } from "./test-support.js";

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

test("jewelAffixesFor narrows the pool to the jewel's own play style", () => {
  const snapshot = standardSnapshot();

  // A jewel is not a gear base, so `affixesFor` cannot answer this: no base carries
  // `any_jewel` or `jewel_int`, and the tags come from the style instead.
  assert.deepEqual(jewelAffixesFor(snapshot, "int").map((a) => a.id).sort(), [
    "any_jewel_affix",
    "jewel_int_only",
  ]);
  assert.deepEqual(jewelAffixesFor(snapshot, "str").map((a) => a.id), ["any_jewel_affix"]);
  // `PlayStyle.fromID` falls back to STR, and so does an absent style.
  assert.deepEqual(jewelAffixesFor(snapshot, undefined).map((a) => a.id), ["any_jewel_affix"]);
  assert.deepEqual(jewelTags("dex"), ["any_jewel", "jewel_dex"]);

  // The style narrows `jewel` affixes and nothing else. A `jewel` affix is never in either of
  // the other two pools, either — the three lists a jewel carries never overlap.
  assert.equal(jewelAffixesFor(snapshot, "int").some((a) => a.id === "armor_eye"), false);
});

test("a jewel's other two pools are filtered by type alone", () => {
  const snapshot = standardSnapshot();

  // `JewelItemData.corrupt` rolls `x -> x.type == AffixSlot.jewel_corruption` and the eye
  // branch of `JewelBlueprint.createData` rolls `x -> x.type == AffixSlot.watcher_eye`. Neither
  // consults a tag, which is why these two fixtures carry a `jewel_int` requirement that a
  // tag-aware filter would use to exclude them.
  assert.deepEqual(jewelCorruptionAffixes(snapshot).map((a) => a.id), ["jewel_corrupt_armor"]);

  const eyes = watcherEyeAffixes(snapshot);
  assert.deepEqual(eyes.map((a) => a.id), ["armor_eye"]);
  // Which Augment gates the line is on the affix — the record that carries it never names one.
  assert.equal(eyes[0]?.eyeAuraReq, "armor");
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

test("allowed affix tiers come back in the ladder's order, not the registry's", () => {
  // The registry is keyed alphabetically, so an unsorted list reads "common, epic, legendary,
  // mythic, rare, uncommon" — an ordering that says nothing, over a value whose whole meaning is
  // its rank. Every tier dropdown in the app renders this list in the order it arrives in.
  const snapshot = standardSnapshot();
  assert.deepEqual(allowedAffixTiers(snapshot, gearRarity(snapshot, "mythic")!), [
    "common",
    "uncommon",
    "rare",
    "epic",
    "legendary",
    "mythic",
  ]);
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

/**
 * The three quality currencies Craft to Exile 2 `2.0.2` actually ships, with the `data` shapes
 * copied off the pack rather than off `ItemMods` — the whole point of deriving the ceiling is
 * that the two disagree. `add_1_to_5_gear_quality` is declared `MinMax(1, 5)` in the Java and
 * is named for it; the pack overrides it to 1-10.
 */
function qualityRegistries(): Registries {
  return {
    library_of_exile_item_modification: {
      add_gear_quality: { serializer: "add_quality", data: { add_quality: { min: 1, max: 1 } } },
      add_1_to_5_gear_quality: { serializer: "add_quality", data: { add_quality: { min: 1, max: 10 } } },
      corrupt_gear_no_affix: { serializer: "corrupt_gear" },
      sharpening_stone_quality_0: { serializer: "add_quality", data: { add_quality: { min: 2, max: 2 } } },
      sharpening_stone_quality_5: { serializer: "add_quality", data: { add_quality: { min: 12, max: 12 } } },
      increment_uses_sharpening_stone: { serializer: "increment_uses" },
    },
    library_of_exile_item_requirement: {
      is_gear: { serializer: "is_gear" },
      is_under_20_quality: { serializer: "is_under_quality", data: { max_quality: 20 } },
      is_under_21_quality: { serializer: "is_under_quality", data: { max_quality: 21 } },
      max_uses_sharpening_stone: {
        serializer: "max_uses",
        data: { max_uses: 1, use_id: "sharpening_stone" },
      },
    },
    library_of_exile_currency: {
      orb_of_quality: {
        req: ["is_not_corrupted", "is_under_20_quality"],
        always_do_item_mods: [{ id: "add_gear_quality", weight: 1 }],
        pick_one_item_mod: [],
      },
      entangled_quality: {
        req: ["is_not_corrupted", "is_under_21_quality"],
        always_do_item_mods: [],
        pick_one_item_mod: [
          { id: "add_1_to_5_gear_quality", weight: 75 },
          { id: "corrupt_gear_no_affix", weight: 25 },
        ],
      },
      sharpening_stone_0: {
        req: ["is_not_corrupted", "max_uses_sharpening_stone"],
        always_do_item_mods: [
          { id: "sharpening_stone_quality_0", weight: 1 },
          { id: "increment_uses_sharpening_stone", weight: 1 },
        ],
        pick_one_item_mod: [],
      },
      sharpening_stone_5: {
        req: ["is_not_corrupted", "max_uses_sharpening_stone"],
        always_do_item_mods: [
          { id: "sharpening_stone_quality_5", weight: 1 },
          { id: "increment_uses_sharpening_stone", weight: 1 },
        ],
        pick_one_item_mod: [],
      },
    },
  };
}

test("the quality ceiling comes from the pack's currencies, not from the mod's defaults", () => {
  const snapshot = makeSnapshot(qualityRegistries());

  // Orb of Quality sits at 19 (`quality < 20`) and adds 1, so 20. The Entangled Orb is gated at
  // 21 and adds up to 10, so 30 — and it is the better gate, so it is the one that binds. A
  // Godly Sharpening Stone has no quality gate at all, only one use per item, so its 12 lands
  // on top: 42.
  assert.equal(maxQuality(snapshot), 42);
});

test("sharpening stones share one use budget rather than getting one each", () => {
  // Every `sharpening_stone_N` names `use_id: "sharpening_stone"`, and `MaximumUsesReq` counts
  // that id on the item. Summing the tiers instead would add 2 and 12 for a 14-point ceiling
  // the game cannot reach, so the best add in a `use_id` group is taken once.
  const registries = qualityRegistries();
  delete registries["library_of_exile_currency"]!["orb_of_quality"];
  delete registries["library_of_exile_currency"]!["entangled_quality"];
  assert.equal(maxQuality(makeSnapshot(registries)), 12);
});

test("a quality currency with neither a gate nor a use budget has no ceiling", () => {
  // Nothing would stop it being applied to the same item for ever, so there is no number to
  // give and callers must not be handed a made-up one.
  const registries = qualityRegistries();
  registries["library_of_exile_currency"]!["endless_quality"] = {
    req: ["is_gear"],
    always_do_item_mods: [{ id: "add_gear_quality", weight: 1 }],
    pick_one_item_mod: [],
  };
  assert.equal(maxQuality(makeSnapshot(registries)), undefined);
});

test("maxQuality returns undefined when currency registry is missing or has no quality currencies", () => {
  // When a snapshot is on an older schema or missing Library of Exile registries,
  // maxQuality must return undefined (unbounded / no maximum derived) rather than 0,
  // so the UI does not clamp quality inputs to 0 and validation does not reject quality.
  assert.equal(maxQuality(makeSnapshot({})), undefined);

  const emptyCurrencies = qualityRegistries();
  delete emptyCurrencies["library_of_exile_currency"];
  assert.equal(maxQuality(makeSnapshot(emptyCurrencies)), undefined);

  assert.equal(maxQuality(makeSnapshot({ library_of_exile_currency: {} })), undefined);

  const nonQuality = {
    library_of_exile_currency: {
      chaos_orb: {
        req: ["is_gear"],
        always_do_item_mods: [],
        pick_one_item_mod: [],
      },
    },
  };
  assert.equal(maxQuality(makeSnapshot(nonQuality)), undefined);
});


// ---------------------------------------------------------------------------
// Vanilla enchantments
// ---------------------------------------------------------------------------

function compatRegistries(): Registries {
  return {
    mmorpg_stat_compat: {
      // The enchantment half: `enchant_id` set, no attribute.
      protection_compat: {
        enchant_id: "minecraft:protection",
        attribute_id: "",
        mns_stat_id: "armor",
        mod_type: "PERCENT",
        conversion: 2,
        per_item_min: 0,
        per_item_max: 12,
        minimum_cap: 0,
        maximum_cap: 36,
        scaling: "NONE",
      },
      looting_compat: {
        enchant_id: "minecraft:looting",
        attribute_id: "",
        mns_stat_id: "increased_quantity",
        mod_type: "FLAT",
        conversion: 1,
        per_item_min: 0,
        per_item_max: 6,
        minimum_cap: 0,
        maximum_cap: 18,
        scaling: "NONE",
      },
      wrd_reinforced_compat: {
        enchant_id: "wrd:reinforced",
        attribute_id: "",
        mns_stat_id: "armor",
        mod_type: "PERCENT",
        conversion: 2,
        per_item_min: 0,
        per_item_max: 12,
        minimum_cap: 0,
        maximum_cap: 36,
        scaling: "NONE",
      },
      // The attribute half, which belongs to a different stat context entirely.
      max_health_compat: {
        enchant_id: "",
        attribute_id: "minecraft:generic.max_health",
        mns_stat_id: "health",
        mod_type: "FLAT",
        conversion: 0.5,
      },
    },
  };
}

test("only the enchantment half of mmorpg_stat_compat is an enchantment", () => {
  // `getResult` and `getEnchantCompatResult` are two different methods feeding two different
  // stat contexts (VANILLA_STAT_COMPAT against ENCHANT_COMPAT). An entry with an `attribute_id`
  // and no `enchant_id` is a vanilla attribute — food diversity, the held weapon's damage — and
  // offering it as something to put on an item would be offering a control that does nothing.
  const compats = enchantCompats(makeSnapshot(compatRegistries()));
  assert.deepEqual(
    compats.map((c) => c.enchantId).sort(),
    ["minecraft:looting", "minecraft:protection", "wrd:reinforced"],
  );
});

test("an enchantment carries both of its clamps, which are different limits", () => {
  const compats = enchantCompats(makeSnapshot(compatRegistries()));
  const protection = compats.find((c) => c.enchantId === "minecraft:protection");

  // The per-item clamp bounds what one piece contributes; the total clamp bounds the sum over
  // every equipped piece. Collapsing them into one is how Protection IV on four pieces and
  // Protection XVI on one become the same number, and they are not.
  assert.equal(protection?.perItem.max, 12);
  assert.equal(protection?.cap.max, 36);
  assert.equal(protection?.conversion, 2);
  assert.equal(protection?.modType, "PERCENT");
  assert.equal(protection?.statId, "armor");
});

test("an enchantment entry falls back to the Java's own field defaults", () => {
  // `StatCompat` declares `conversion = 0.5`, `minimum_cap = 0`, `maximum_cap = 100`,
  // `per_item_min = 0`, `per_item_max = 100`. An entry that omits them must read as the Java
  // reads it, not as zero — a conversion silently defaulting to 0 makes the enchantment inert.
  const compats = enchantCompats(
    makeSnapshot({
      mmorpg_stat_compat: {
        sparse: { enchant_id: "minecraft:sharpness", mns_stat_id: "all_physical_damage" },
      },
    }),
  );
  assert.equal(compats[0]?.conversion, 0.5);
  assert.equal(compats[0]?.perItem.max, 100);
  assert.equal(compats[0]?.cap.max, 100);
  assert.equal(compats[0]?.modType, "PERCENT");
});

test("an enchantment's name keeps the namespace when it is not vanilla's", () => {
  // Eleven of this pack's enchantment compats come from other mods, and two of them are called
  // "Reinforced". Dropping the namespace makes those indistinguishable in a picker.
  assert.equal(enchantName("minecraft:fire_protection"), "Fire Protection");
  assert.equal(enchantName("wrd:reinforced"), "Reinforced (wrd)");
  // An id with no namespace at all is vanilla's, which is how the registry spells some of them.
  assert.equal(enchantName("looting"), "Looting");
});

test("an attribute's name drops vanilla's `generic.` and keeps everyone else's namespace", () => {
  // `generic.` is on every vanilla attribute and says nothing; the namespace on the rest is the
  // useful half, since `kubejs:magic_shield` is food diversity rather than anything Minecraft
  // ships and a bare "Magic Shield" would read as the real stat of that name.
  assert.equal(attributeName("minecraft:generic.max_health"), "Max Health");
  assert.equal(attributeName("kubejs:magic_shield"), "Magic Shield (kubejs)");
  assert.equal(attributeName("luck"), "Luck");
});

// ---------------------------------------------------------------------------
// The rarity ladder, and what an infusion rolls at
// ---------------------------------------------------------------------------

test("the rarity ladder is the `higher_rar` chain, not an item_tier sort", () => {
  const snapshot = standardSnapshot();
  // `unique` shares mythic's item_tier and `runeword` sits above it at 10, so sorting on the
  // tier would put one or both in the ladder. Nothing links to either, and `mythic` links to
  // nothing, so walking the chain leaves exactly the six a currency can climb.
  assert.deepEqual(rarityLadder(snapshot), [
    "common",
    "uncommon",
    "rare",
    "epic",
    "legendary",
    "mythic",
  ]);
  assert.deepEqual(rarityLadder(snapshot, "legendary"), ["legendary", "mythic"]);
  assert.deepEqual(rarityLadder(snapshot, "mythic"), ["mythic"]);
  // A rarity outside the chain is its own one-entry ladder rather than an error: `runeword`
  // names no higher rarity and nothing names it.
  assert.deepEqual(rarityLadder(snapshot, "runeword"), ["runeword"]);
});

test("an infusion does not roll: it is its rarity's band maximum", () => {
  const snapshot = standardSnapshot();
  // `GearInfusionData.getPercent()` returns `stat_percents.max` and the class stores no percent
  // of its own, so these are the only six values an infusion can ever resolve at. Common's 17 is
  // why `ench_pants_damage_when_hit`, a 10-to-30 affix, is always exactly 13.4 in game.
  assert.deepEqual(
    rarityLadder(snapshot).map((id) => infusionRollPercent(snapshot, id)),
    [17, 34, 51, 68, 85, 100],
  );
  assert.equal(infusionRollPercent(snapshot, "nonesuch"), undefined);
});

// ---------------------------------------------------------------------------
// The epilogue's point reward
// ---------------------------------------------------------------------------

test("finishing the epilogue is +4 passive and +10 spell points", () => {
  const snapshot = standardSnapshot();
  const plain = { level: 100 };
  const done = { level: 100, questsComplete: true };

  // `points_per_lvl` alone: 0.5/level and 1/level.
  assert.equal(pointsAvailable(snapshot, plain, "PASSIVES").total, 50);
  assert.equal(pointsAvailable(snapshot, plain, "SPELLS").total, 100);

  // The two numbers the game reports on a finished character, which is where they came from.
  assert.equal(pointsAvailable(snapshot, done, "PASSIVES").total, 54);
  assert.equal(pointsAvailable(snapshot, done, "SPELLS").total, 110);

  // Neither is `recorded`: it is still a level-derived budget, just one with the quest in it.
  assert.equal(pointsAvailable(snapshot, done, "PASSIVES").recorded, false);

  // A pool the quest does not touch is unmoved.
  assert.equal(
    pointsAvailable(snapshot, plain, "TALENTS").total,
    pointsAvailable(snapshot, done, "TALENTS").total,
  );
  assert.equal(EPILOGUE_BONUS_POINTS.TALENTS, undefined);
});

test("the epilogue bonus is clamped by max_total_points, and loses to a recorded total", () => {
  const snapshot = standardSnapshot();
  // PASSIVES caps at 75. At level 150 the level alone gives 75, so the quest's four have
  // nowhere to go: `Math.min(current + getBonusPoints(p), data.max_total_points)`.
  assert.equal(pointsAvailable(snapshot, { level: 150, questsComplete: true }, "PASSIVES").total, 75);

  // A document the companion mod produced carries the game's own count, and a checkbox cannot
  // improve on it — `pointTotals` wins outright, ticked or not.
  const captured = { level: 100, questsComplete: true, pointTotals: { PASSIVES: 54 } };
  const answer = pointsAvailable(snapshot, captured, "PASSIVES");
  assert.equal(answer.total, 54);
  assert.equal(answer.recorded, true);
});
