/**
 * The item importer, checked against tooltips shaped exactly like the game's.
 *
 * The fixtures below are the in-depth (Shift-held) rendering `GearTooltipUtils` produces, with
 * the bracket suffix `NormalStatTooltip.getPercentageView` appends. Names come from the lang
 * table the test snapshot carries, not from hardcoded English, because that is how the reader
 * resolves them and the pack renames plenty of keys.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { importItem, importFailed, parseStatLine, rollFromDisplay } from "./import-item.js";
import { affixEntry, baseGear, includesAny, makeSnapshot, RARITIES } from "./test-support.js";

/**
 * A necklace snapshot mirroring the real jewellery pool: one base in the slot, four affixes,
 * and lang for every stat one of them grants. `magic_shield_regen` deliberately has **no**
 * registry entry — it is one of the 389 code-only stats, and the name index has to find it in
 * lang anyway.
 */
function necklaceSnapshot() {
  return makeSnapshot(
    {
      mmorpg_gear_rarity: RARITIES,
      mmorpg_gear_slot: { necklace: { id: "necklace", fam: "Jewelry" } },
      // `SocketData.g` holds a gem *or* a rune, told apart by which registry answers.
      mmorpg_gems: { amethyst0: { identifier: "amethyst0" } },
      mmorpg_runes: { el: { identifier: "el" } },
      mmorpg_runeword: { steel: { id: "steel" } },
      mmorpg_base_gear_types: {
        necklace: baseGear("necklace", "necklace", ["jewelry_family", "necklace"]),
      },
      mmorpg_stat: {
        lifesteal: { id: "lifesteal", ser: "basic" },
        all_water_damage: { id: "all_water_damage", ser: "basic" },
        dexterity: { id: "dexterity", ser: "core_stat" },
        intelligence: { id: "intelligence", ser: "core_stat" },
      },
      mmorpg_affixes: {
        vampiric: affixEntry("vampiric", "prefix", [includesAny(["jewelry_family"])], {
          stats: [{ type: "FLAT", stat: "lifesteal", min: 2, max: 4 }],
        }),
        promised: affixEntry("promised", "prefix", [includesAny(["jewelry_family"])], {
          stats: [{ type: "FLAT", stat: "magic_shield_regen", min: 40, max: 130 }],
        }),
        water_dmg: affixEntry("water_dmg", "suffix", [includesAny(["jewelry_family"])], {
          stats: [{ type: "PERCENT", stat: "all_water_damage", min: 4, max: 14 }],
        }),
        of_the_wind: affixEntry("of_the_wind", "suffix", [includesAny(["jewelry_family"])], {
          stats: [{ type: "FLAT", stat: "dexterity", min: 5, max: 16 }],
        }),
        lapis_amulet: affixEntry("lapis_amulet", "implicit", [includesAny(["necklace"])], {
          stats: [{ type: "FLAT", stat: "intelligence", min: 10, max: 30 }],
        }),
      },
    },
    {
      "mmorpg.item_tips.level_req": "Player Level Min: %1$s",
      "mmorpg.item_tips.rarity_line": "%1$s Item",
      "mmorpg.item_tips.item_type": "Item Type: %1$s",
      "mmorpg.item_tips.prefix_stats": "Prefix Stats: ",
      "mmorpg.item_tips.suffix_stats": "Suffix Stats: ",
      "mmorpg.item_tips.cor_stats": "Corruption Stats: ",
      "mmorpg.word.implicit_stats": "Implicit Stats: ",
      "mmorpg.item_tips.empty_socket": "[Socket]",
      "mmorpg.gearslot.necklace": "Necklace",
      "mmorpg.rarity.common": "Common",
      "mmorpg.rarity.uncommon": "Uncommon",
      "mmorpg.rarity.rare": "Rare",
      "mmorpg.rarity.epic": "Epic",
      "mmorpg.rarity.legendary": "Legendary",
      "mmorpg.rarity.mythic": "Mythic",
      "mmorpg.rarity.unique": "Unique",
      // Glossary markup and colour codes both appear in real stat names; the reader strips
      // them the same way the game's own `EnlightenMarkup.strip` does.
      "mmorpg.stat.lifesteal": "Attack [Hits](hit_damage) Health [Leech](leech)",
      "mmorpg.stat.all_water_damage": "Cold Damage",
      "mmorpg.stat.dexterity": "§bDexterity",
      "mmorpg.stat.intelligence": "Intelligence",
      // Code-only: named in lang, absent from `mmorpg_stat`.
      "mmorpg.stat.magic_shield_regen": "Magic Shield Regen",
    },
  );
}

const AMULET = `Promised Lapis Amulet of the Wind
✔ Player Level Min: 94

Implicit Stats:
+25 Intelligence

Prefix Stats:
+3.2% Attack Hits Health Leech   [3.1 - 3.7] [Epic]
+103 Magic Shield Regen   [90 - 109] [Epic]

Suffix Stats:
+10.3% Cold Damage   [9.2 - 11.2] [Epic]
+11.9 Dexterity   [10.4 - 12.6] [Epic]

[Socket]

Potential: 125
Quality: 0%

Item Type: Necklace
Tags: Jewelry Family, Necklace

Epic Item
Durability: 836/836
Salvageable`;

test("reads base, rarity and level off an in-depth tooltip", () => {
  const result = importItem(AMULET, necklaceSnapshot());
  assert.equal(result.format, "tooltip");
  assert.ok(!importFailed(result.issues), JSON.stringify(result.issues));
  assert.equal(result.item?.base, "necklace");
  assert.equal(result.item?.rarity, "epic");
  // `Player Level Min` is `gear.getLevel()`, not a separate requirement.
  assert.equal(result.item?.itemLevel, 94);
});

test("identifies every affix, including one whose stat is code-only", () => {
  const result = importItem(AMULET, necklaceSnapshot());
  assert.deepEqual(result.item?.prefixes?.map((p) => p.affixId).sort(), ["promised", "vampiric"]);
  assert.deepEqual(result.item?.suffixes?.map((s) => s.affixId).sort(), ["of_the_wind", "water_dmg"]);
  assert.deepEqual(result.item?.implicits?.map((i) => i.affixId), ["lapis_amulet"]);
  // Four prefixes+suffixes is exactly `epic.min_affixes`, so the read is self-consistent.
  assert.equal((result.item?.prefixes?.length ?? 0) + (result.item?.suffixes?.length ?? 0), 4);
});

test("takes each affix's own tier from the trailing bracket, not the item's rarity", () => {
  const result = importItem(AMULET, necklaceSnapshot());
  for (const roll of [...(result.item?.prefixes ?? []), ...(result.item?.suffixes ?? [])]) {
    assert.equal(roll.tier, "epic");
  }
});

test("recovers roll percents inside the tier's band", () => {
  const result = importItem(AMULET, necklaceSnapshot());
  const band = RARITIES.epic!["stat_percents"] as { min: number; max: number };
  for (const roll of [...(result.item?.prefixes ?? []), ...(result.item?.suffixes ?? [])]) {
    assert.ok(
      roll.rollPercent >= band.min && roll.rollPercent <= band.max,
      `${roll.affixId} rolled ${roll.rollPercent}, outside ${band.min}..${band.max}`,
    );
  }
});

test("an affix with a common-tier roll on an epic item keeps its own band", () => {
  // `AffixData.randomizeTier` picks any non-unique rarity at or below the item's, and the band
  // comes from *that* tier — so a Common line on an Epic item rolls 0-17, not 52-68.
  const tooltip = AMULET.replace(
    "+11.9 Dexterity   [10.4 - 12.6] [Epic]",
    "+5.6 Dexterity   [5.5 - 6.9] [Common]",
  );
  const result = importItem(tooltip, necklaceSnapshot());
  const wind = result.item?.suffixes?.find((s) => s.affixId === "of_the_wind");
  assert.equal(wind?.tier, "common");
  assert.ok(wind !== undefined && wind.rollPercent <= 17, `rolled ${wind?.rollPercent}`);
});

test("the merged (no-Shift) tooltip is refused rather than half-read", () => {
  // Without Shift, `GearTooltipUtils` sums every affix into one unsectioned list: no ranges,
  // no tiers, and two affixes granting the same stat already added together.
  const merged = `Promised Lapis Amulet of the Wind
✔ Player Level Min: 94

+25 Intelligence
+3.2% Attack Hits Health Leech
+103 Magic Shield Regen
+11.9 Dexterity

Item Type: Necklace
Tags: Jewelry Family, Necklace

Epic Item`;
  const result = importItem(merged, necklaceSnapshot());
  assert.ok(importFailed(result.issues));
  assert.equal(result.item, undefined);
  assert.ok(result.issues.some((i) => i.code === "not-in-depth-tooltip"));
});

test("an unrecognised stat line is reported and skipped, not guessed at", () => {
  const tooltip = AMULET.replace("+10.3% Cold Damage", "+10.3% Nonsense Stat");
  const result = importItem(tooltip, necklaceSnapshot());
  assert.ok(result.issues.some((i) => i.code === "stat-not-recognised"));
  assert.ok(!result.item?.suffixes?.some((s) => s.affixId === "water_dmg"));
});

test("imprecise rolls are flagged, because the game truncates large numbers", () => {
  const result = importItem(AMULET, necklaceSnapshot());
  // `[90 - 109]` is `(int)` truncation of the real endpoints, so the roll behind `+103` is
  // only pinned to an interval. Saying so is the point.
  assert.ok(result.issues.some((i) => i.code === "roll-imprecise"));
});

test("reads the gear NBT exactly, with no inference at all", () => {
  // What `/data get entity @s SelectedItem` prints: SNBT with the gear stored as a JSON
  // string, because `LoadSave.Save` is `gson.toJson(object)`.
  const nbt = `{Count: 1b, id: "roe_weapons:necklace_3", tag: {mmorpg_gear: '{"baseStats":{"p":62},` +
    `"imp":{"p":45,"imp":"lapis_amulet"},"affixes":{"pre":[{"p":55,"id":"vampiric","rar":"epic"},` +
    `{"p":63,"id":"promised","rar":"epic"}],"suf":[{"p":61,"id":"water_dmg","rar":"rare"}],"cor":[]},` +
    `"rar":"epic","lvl":94,"gtype":"necklace"}'}}`;
  const result = importItem(nbt, necklaceSnapshot());
  assert.equal(result.format, "nbt");
  assert.ok(!importFailed(result.issues), JSON.stringify(result.issues));
  assert.equal(result.item?.itemLevel, 94);
  assert.equal(result.item?.rarity, "epic");
  assert.deepEqual(result.item?.prefixes, [
    { affixId: "vampiric", tier: "epic", rollPercent: 55 },
    { affixId: "promised", tier: "epic", rollPercent: 63 },
  ]);
  // An affix carries its own tier, which is not the item's — `rare` here on an `epic` item.
  assert.deepEqual(result.item?.suffixes, [{ affixId: "water_dmg", tier: "rare", rollPercent: 61 }]);
  assert.deepEqual(result.item?.implicits, [
    { affixId: "lapis_amulet", tier: "epic", rollPercent: 45 },
  ]);
});

test("parseStatLine peels the two bracket groups from the right", () => {
  const line = parseStatLine("+3.2% Attack Hits Health Leech [3.1 - 3.7] [Epic]");
  assert.equal(line?.value, 3.2);
  assert.equal(line?.name, "Attack Hits Health Leech");
  assert.deepEqual(line?.range, { min: 3.1, max: 3.7 });
  assert.equal(line?.tierId, "Epic");
});

test("parseStatLine drops the MORE and increased wording the formatter prepends", () => {
  // `StatNameRegex.translate` prepends `getMultiUseType().prefixWord` for a MORE, and the
  // pack's `SPECIAL_CALC_STAT` formatter puts "Increased" in front of a PERCENT.
  assert.equal(parseStatLine("+12% Increased Armor")?.name, "Armor");
  assert.equal(parseStatLine("20% Less Armor")?.name, "Armor");
  assert.equal(parseStatLine("12% More Armor")?.name, "Armor");
});

test("parseStatLine keeps a range with no tier beside it", () => {
  // Base stats print a range but no rarity — `BaseStatsData` leaves `affix_rarity` null.
  const line = parseStatLine("+47 Armor [40 - 60]");
  assert.deepEqual(line?.range, { min: 40, max: 60 });
  assert.equal(line?.tierId, undefined);
});

test("rollFromDisplay returns the interval the rounding allows, not a false exact", () => {
  const band = { min: 52, max: 68 };
  // One-decimal numbers: a tight interval.
  const tight = rollFromDisplay(11.9, { min: 10.4, max: 12.6 }, band);
  assert.ok(tight !== undefined && tight.max - tight.min < 2);
  // Truncated integers: wider, because `[90 - 109]` could be `[90.9 - 109.9]`.
  const loose = rollFromDisplay(103, { min: 90, max: 109 }, band);
  assert.ok(loose !== undefined && loose.max - loose.min > tight!.max - tight!.min);
});

test("rollFromDisplay refuses a band that prints one number", () => {
  // `min === max` means every roll in the band renders identically; there is nothing to invert.
  assert.equal(rollFromDisplay(5, { min: 5, max: 5 }, { min: 52, max: 68 }), undefined);
});

test("a tooltip with no recognisable base is an error, not an invented item", () => {
  const result = importItem("Some Random Text\nNot an item at all", necklaceSnapshot());
  assert.ok(importFailed(result.issues));
  assert.equal(result.item, undefined);
});

test("sockets read gems and runes out of the same field, by asking the registries", () => {
  // `GearSocketsData.so` is a list of `SocketData`, and `SocketData.g` is commented "gem id"
  // but holds either — `isGem()` and `isRune()` distinguish them by registry lookup, not by a
  // field, so an importer that filed everything under `sockets` would put runes there too.
  const nbt =
    `{mmorpg_gear: '{"affixes":{"pre":[],"suf":[],"cor":[]},` +
    `"sockets":{"so":[{"g":"amethyst0","p":40},{"g":"el","p":0},{"g":"","p":0}],"sl":3,` +
    `"rw":"steel","rp":50},"rar":"epic","lvl":50,"gtype":"necklace"}'}`;
  const result = importItem(nbt, necklaceSnapshot());
  assert.equal(result.format, "nbt");
  assert.deepEqual(result.item?.sockets, ["amethyst0"]);
  assert.deepEqual(result.item?.runes, ["el"]);
  assert.equal(result.item?.runeword, "steel");
});

test("an empty socket is stored as an id in neither registry, and is skipped", () => {
  const nbt =
    `{mmorpg_gear: '{"sockets":{"so":[{"g":"","p":0}],"sl":1,"rw":"","rp":0},` +
    `"rar":"common","lvl":1,"gtype":"necklace"}'}`;
  const result = importItem(nbt, necklaceSnapshot());
  assert.equal(result.item?.sockets, undefined);
  assert.equal(result.item?.runes, undefined);
  assert.equal(result.item?.runeword, undefined);
});

// ---------------------------------------------------------------------------
// This app's own item JSON — what `Copy item` writes and duplicating pastes
// ---------------------------------------------------------------------------

/** A fully-featured item, so the round trip is exercised on every optional field at once. */
const DOCUMENT_ITEM = {
  base: "necklace",
  rarity: "epic",
  itemLevel: 94,
  baseRolls: [60],
  implicits: [{ affixId: "lapis_amulet", rollPercent: 50 }],
  prefixes: [
    { affixId: "vampiric", tier: "epic", rollPercent: 30 },
    { affixId: "promised", tier: "rare", rollPercent: 80 },
  ],
  suffixes: [{ affixId: "of_the_wind", tier: "epic", rollPercent: 100 }],
  sockets: ["amethyst0"],
  runes: ["el"],
  runeRolls: [25],
  runeword: "steel",
  runewordRoll: 50,
  quality: 12,
  enchantments: { "minecraft:protection": 4 },
};

test("an item copied out of this app pastes back identically", () => {
  const result = importItem(JSON.stringify(DOCUMENT_ITEM, null, 2), necklaceSnapshot());

  assert.equal(result.format, "document");
  assert.equal(importFailed(result.issues), false);
  // Every field survives, and nothing is inferred: this is the round trip `Copy item` promises.
  assert.deepEqual(result.item, DOCUMENT_ITEM);
});

test("the document reader is told apart from the gear NBT by its field names alone", () => {
  // Same registry ids, the other JSON shape. Detection must not be "looks like JSON".
  const nbt = `{"rar":"epic","lvl":50,"gtype":"necklace"}`;
  assert.equal(importItem(nbt, necklaceSnapshot()).format, "nbt");
  assert.equal(
    importItem(JSON.stringify({ base: "necklace", rarity: "epic", itemLevel: 50 }), necklaceSnapshot())
      .format,
    "document",
  );
});

test("an id that is not in the loaded snapshot is reported, and the item still lands", () => {
  const stale = {
    ...DOCUMENT_ITEM,
    prefixes: [{ affixId: "affix_from_another_version", tier: "epic", rollPercent: 30 }],
    sockets: ["gem_that_moved"],
  };
  const result = importItem(JSON.stringify(stale), necklaceSnapshot());

  assert.equal(result.format, "document");
  // Warnings, not errors: a pasted item you can see and correct beats a paragraph about why not.
  assert.equal(importFailed(result.issues), false);
  assert.equal(result.item?.prefixes?.[0]?.affixId, "affix_from_another_version");
  const unknown = result.issues.filter((i) => i.code === "unknown-id").map((i) => i.message);
  assert.equal(unknown.length, 2);
  assert.ok(unknown.some((m) => m.includes("affix_from_another_version")));
  assert.ok(unknown.some((m) => m.includes("gem_that_moved")));
});

test("a base that is not in the snapshot is an error, as it is for the NBT reader", () => {
  const result = importItem(
    JSON.stringify({ base: "boots_that_do_not_exist", rarity: "epic", itemLevel: 94 }),
    necklaceSnapshot(),
  );
  assert.equal(result.item, undefined);
  assert.equal(importFailed(result.issues), true);
  assert.equal(result.issues[0]?.code, "unknown-base");
});

test("an unknown rarity warns rather than failing — the editor can still set one", () => {
  const result = importItem(
    JSON.stringify({ base: "necklace", rarity: "ultra", itemLevel: 94 }),
    necklaceSnapshot(),
  );
  assert.equal(importFailed(result.issues), false);
  assert.equal(result.item?.rarity, "ultra");
  assert.ok(result.issues.some((i) => i.code === "unknown-rarity"));
});

test("fields that are not part of an Item do not survive the paste", () => {
  // An importer is a trust boundary: what a person pasted is arbitrary text, and the item is
  // rebuilt field by field rather than cast, so nothing else can reach the document. `__proto__`
  // is written into the raw JSON rather than an object literal, where it would set a prototype
  // instead of a key and prove nothing.
  const raw = JSON.stringify({ ...DOCUMENT_ITEM, notAField: "hello" }).replace(
    '"base"',
    '"__proto__":{"polluted":true},"base"',
  );
  const result = importItem(raw, necklaceSnapshot());

  assert.notEqual(result.item, undefined);
  assert.deepEqual(result.item, DOCUMENT_ITEM);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("a roll percent outside 0-100 is coerced rather than carried into the document", () => {
  const result = importItem(
    JSON.stringify({
      base: "necklace",
      rarity: "epic",
      itemLevel: 94,
      prefixes: [{ affixId: "vampiric", tier: "epic", rollPercent: 4000 }],
      baseRolls: [-7],
    }),
    necklaceSnapshot(),
  );
  assert.equal(result.item?.prefixes?.[0]?.rollPercent, 100);
  assert.deepEqual(result.item?.baseRolls, [0]);
});
