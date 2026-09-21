/**
 * Synthetic snapshots for unit tests.
 *
 * Tests build their own tiny registries rather than reading `data/snapshot.json`: that file
 * is derived from whoever's install happens to be present, is git-ignored, and changes with
 * every pack update. A test that depends on it would fail for the wrong reasons.
 *
 * The shapes below mirror the real data closely — the rarity ladder, tag vocabulary and
 * affix requirement forms are copied from Craft to Exile 2 `2.0.2` — so a test that passes
 * here is testing the rule, not a caricature of it.
 */

import { SNAPSHOT_VERSION, type RegistryEntry, type Snapshot } from "@cte2/extractor";

export type Registries = Record<string, Record<string, Record<string, unknown>>>;

export function makeSnapshot(registries: Registries, lang: Record<string, string> = {}): Snapshot {
  const out: Record<string, Record<string, RegistryEntry>> = {};
  for (const [category, entries] of Object.entries(registries)) {
    const bucket: Record<string, RegistryEntry> = {};
    for (const [id, data] of Object.entries(entries)) {
      bucket[id] = { id, origin: `test:${category}/${id}.json`, source: { kind: "pack", packId: "test" }, data };
    }
    out[category] = bucket;
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    meta: {
      extractedAt: "2026-01-01T00:00:00.000Z",
      gameDir: "test",
      mineAndSlashVersion: "test",
      mineAndSlashJar: "test",
      libraryOfExileJar: null,
      openLoaderPackIds: ["test"],
      resourcePacks: [],
      fingerprint: { files: [] },
    },
    registries: out,
    registryLists: {},
    lang,
    externalConfig: { foodDiversity: null, serverConfig: null },
    diagnostics: {
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
    },
  };
}

/** The real rarity ladder: item_tier 0..5, non-overlapping roll bands, min_affixes 1..6. */
export function rarity(
  id: string,
  itemTier: number,
  minAffixes: number,
  statPercents: { min: number; max: number },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    guid: id,
    item_tier: itemTier,
    affix_rarity_weight: 1000,
    is_unique_item: false,
    min_affixes: minAffixes,
    stat_percents: statPercents,
    base_stat_percents: { min: 0, max: 100 },
    sockets: { min: 0, max: 1 },
    max_gems: 10,
    max_runes: 1,
    can_have_runewords: false,
    min_lvl: 0,
    // `GearRarityType` — the coarse grouping omen requirements are counted over.
    type: "NORMAL",
    // `GearRarity.omens` (`OmenDifficulty`): the bands an omen of this rarity generates
    // within, and the `stat_multi` its derived stat percent is scaled by.
    omens: {
      normal: { min: 1, max: 2 },
      unique: { min: 1, max: 2 },
      runed: { min: 1, max: 3 },
      specific_slots: { min: 0, max: 3 },
      affixes: { min: 0, max: 3 },
      stat_multi: 1,
    },
    ...extra,
  };
}

// `higher_rar` is the ladder a currency walks, stated in the data rather than derived from
// `item_tier` — `mythic` names nothing, and neither `unique` nor `runeword` is named by anybody,
// which is what keeps them out of it. See `rarityLadder`.
export const RARITIES: Record<string, Record<string, unknown>> = {
  common: rarity("common", 0, 1, { min: 0, max: 17 }, { sockets: { min: 0, max: 2 }, max_runes: 2, higher_rar: "uncommon" }),
  uncommon: rarity("uncommon", 1, 2, { min: 18, max: 34 }, { sockets: { min: 0, max: 2 }, max_runes: 2, higher_rar: "rare" }),
  rare: rarity("rare", 2, 3, { min: 35, max: 51 }, { higher_rar: "epic" }),
  epic: rarity("epic", 3, 4, { min: 52, max: 68 }, { min_lvl: 10, higher_rar: "legendary" }),
  legendary: rarity("legendary", 4, 5, { min: 69, max: 85 }, { min_lvl: 25, higher_rar: "mythic" }),
  mythic: rarity("mythic", 5, 6, { min: 86, max: 100 }, { min_lvl: 50, higher_rar: "" }),
  unique: rarity("unique", 5, 0, { min: 0, max: 100 }, { is_unique_item: true, type: "UNIQUE" }),
  // The only `RUNED` rarity, and the only one that may carry a runeword. `max_gems: 0` is the
  // pack's own value and is load-bearing: it is what `GemItem.canBeModified` reads to refuse a
  // gem outright rather than merely cap it.
  runeword: rarity("runeword", 10, 0, { min: 0, max: 100 }, {
    type: "RUNED",
    can_have_runewords: true,
    sockets: { min: 2, max: 6 },
    max_gems: 0,
    max_runes: 8,
  }),
};

export function baseGear(
  id: string,
  gearSlot: string,
  tags: string[],
  baseStats: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return { guid: id, gear_slot: gearSlot, tags: { tags }, base_stats: baseStats, weight: 1000 };
}

export function affixEntry(
  id: string,
  type: string,
  tagRequirements: { req_type: string; included: string[]; excluded: string[] }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    guid: id,
    type,
    eye_aura_req: "",
    one_of_a_kind: "",
    only_one_per_item: false,
    requirements: { tag_requirements: tagRequirements },
    stats: [{ type: "FLAT", stat: "armor", min: 1, max: 10 }],
    weight: 1000,
    ...extra,
  };
}

export function includesAny(included: string[], excluded: string[] = []) {
  return { req_type: "INCLUDES_ANY", included, excluded };
}

export function hasAll(included: string[], excluded: string[] = []) {
  return { req_type: "HAS_ALL", included, excluded };
}

/** A grid string in the same CSV form as `mmorpg_talent_tree/*.json`. */
export function grid(rows: string[][]): Record<string, unknown> {
  return { identifier: "talents", school_type: "TALENTS", perks: rows.map((r) => r.join(",")).join("\n") };
}

export const BALANCE: Record<string, unknown> = {
  id: "original_balance",
  MAX_LEVEL: 100,
  // The pack's value, not the jar default of 5 — it is the headroom gear and perks may add
  // above a spell's own `max_lvl`.
  MAX_BONUS_SPELL_LEVELS: 8,
  player_points: {
    TALENTS: { type: "TALENTS", base_points: 1, max_bonus_points: 25, max_total_points: 200, points_per_lvl: 1 },
    ASCENDANCY: { type: "ASCENDANCY", base_points: 0, max_bonus_points: 9, max_total_points: 10, points_per_lvl: 0 },
    ATLAS: { type: "ATLAS", base_points: 0, max_bonus_points: 200, max_total_points: 200, points_per_lvl: 0 },
    STATS: { type: "STATS", base_points: 0, max_bonus_points: 50, max_total_points: 300, points_per_lvl: 1 },
    // The two pools the campaign's epilogue tops up. Half a passive point per level is the
    // pack's number and the reason a level-100 character has 50 of them before quests and 54
    // after — see `EPILOGUE_BONUS_POINTS`.
    PASSIVES: { type: "PASSIVES", base_points: 0, max_bonus_points: 10, max_total_points: 75, points_per_lvl: 0.5 },
    SPELLS: { type: "SPELLS", base_points: 0, max_bonus_points: 10, max_total_points: 150, points_per_lvl: 1 },
  },
};

/**
 * A snapshot with the pieces most tests need: the rarity ladder, a bow and a pair of boots,
 * a handful of affixes with real requirement shapes, a 3x3 talent grid and the balance file.
 */
export function standardSnapshot(): Snapshot {
  return makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_base_gear_types: {
      bow: baseGear("bow", "bow", ["dexterity", "ranged_weapon", "weapon_family", "bow"], [
        { type: "FLAT", stat: "weapon_damage", min: 6, max: 12 },
      ]),
      boots: baseGear("boots", "boots", ["armor_family", "boots", "armor_stat", "leather"], [
        { type: "FLAT", stat: "armor", min: 4, max: 8 },
      ]),
      necklace: baseGear("necklace", "necklace", ["jewelry_family", "necklace"]),
      ring: baseGear("ring", "ring", ["jewelry_family", "ring"]),
      // The three bases the pack tags `two_handed`; a greatsword stands in for all of them.
      greatsword: baseGear("greatsword", "greatsword", [
        "sword",
        "strength",
        "melee_weapon",
        "weapon_family",
        "two_handed",
      ]),
      shield: baseGear("shield", "shield", ["shield", "strength", "offhand_family", "armor_stat"]),
      // Armour bases are material-specific in the real data, and the slot name is only a
      // tag. `helmet` below is therefore a slot with no base of the same name.
      plate_helmet: baseGear("plate_helmet", "helmet", ["armor_family", "helmet", "plate_helmet", "plate"]),
      leather_helmet: baseGear("leather_helmet", "helmet", ["armor_family", "helmet", "leather_helmet", "leather"]),
    },
    mmorpg_gear_slot: {
      bow: { id: "bow", fam: "Weapon" },
      boots: { id: "boots", fam: "Armor" },
      necklace: { id: "necklace", fam: "Jewelry" },
      ring: { id: "ring", fam: "Jewelry" },
      helmet: { id: "helmet", fam: "Armor" },
      greatsword: { id: "greatsword", fam: "Weapon" },
      shield: { id: "shield", fam: "OffHand" },
    },
    mmorpg_affixes: {
      // Weapons only.
      weapon_prefix: affixEntry("weapon_prefix", "prefix", [includesAny(["weapon_family"])]),
      // Anything, but never a bow — the `excluded` path.
      no_bow_suffix: affixEntry("no_bow_suffix", "suffix", [includesAny(["weapon_family"], ["bow"])]),
      // Armour only.
      armor_suffix: affixEntry("armor_suffix", "suffix", [includesAny(["armor_family"])]),
      armor_prefix: affixEntry("armor_prefix", "prefix", [includesAny(["armor_family"])]),
      // Needs both tags at once.
      leather_boots_prefix: affixEntry("leather_boots_prefix", "prefix", [hasAll(["leather", "boots"])]),
      // Exclusivity flags.
      solo_prefix: affixEntry("solo_prefix", "prefix", [includesAny(["armor_family"])], {
        only_one_per_item: true,
      }),
      group_a_prefix: affixEntry("group_a_prefix", "prefix", [includesAny(["armor_family"])], {
        one_of_a_kind: "resist_group",
      }),
      group_b_suffix: affixEntry("group_b_suffix", "suffix", [includesAny(["armor_family"])], {
        one_of_a_kind: "resist_group",
      }),
      boots_implicit: affixEntry("boots_implicit", "implicit", [includesAny(["boots"])]),
      // The corruption pool, which is the only pool an omen draws from — `Omen.affix_types`
      // is `chaos_stat` on all nine. No tag requirement, because an omen is not gear and has
      // no tags for one to match against.
      chaos_armor: affixEntry("chaos_armor", "chaos_stat", []),
      // Jewels have a tag space of their own that no gear base carries. `any_jewel` rolls on
      // all three styles; `jewel_int_only` rolls on a Stardust Jewel and nowhere else.
      any_jewel_affix: affixEntry("any_jewel_affix", "jewel", [includesAny(["any_jewel"])]),
      jewel_int_only: affixEntry("jewel_int_only", "jewel", [includesAny(["jewel_int"])]),
      // An unimplemented requirement mode must fail loud rather than be assumed true.
      weird_prefix: affixEntry("weird_prefix", "prefix", [
        { req_type: "SOMETHING_NEW", included: ["armor_family"], excluded: [] },
      ]),
    },
    mmorpg_perk: {
      start: { id: "start", type: "START", is_entry: true, one_kind: "start", stats: [] },
      // A second start, deliberately placed where no wire reaches it. Entry perks need no
      // neighbour, so it is allocatable on its own — `one_kind` is the only thing stopping a
      // character holding both.
      start_b: { id: "start_b", type: "START", is_entry: true, one_kind: "start", stats: [] },
      armor_flat: { id: "armor_flat", type: "STAT", stats: [] },
      dodge_flat: { id: "dodge_flat", type: "STAT", stats: [] },
      far_perk: { id: "far_perk", type: "MAJOR", stats: [] },
    },
    // Small, but it exercises every rule that matters. `armor_flat` is reached from `start`
    // along the `o` channel and from `far_perk` along `k`, and the two channels cross at
    // (2, 4) without joining. `dodge_flat` hangs off `armor_flat`, so `start` does *not*
    // connect to it — a path never runs through an intermediate talent. No talent touches
    // the `E` border ring, which is why no edge is ever drawn on the `e` channel.
    mmorpg_talent_tree: {
      talents: grid([
        ["E", "E", "E", "E", "E", "E", "E", "E", "E"],
        ["E", "", "", "", "", "", "", "", "E"],
        ["E", "", "start", "o", "armor_flat", "o", "dodge_flat", "", "E"],
        ["E", "", "", "", "k", "", "", "", "E"],
        ["E", "", "", "", "k", "", "", "", "E"],
        ["E", "", "far_perk", "k", "", "", "start_b", "", "E"],
        ["E", "", "", "", "[CENTER]", "", "", "", "E"],
        ["E", "E", "E", "E", "E", "E", "E", "E", "E"],
      ]),
    },
    // Nine omens ship in the real pack; one is enough to exercise the set machinery.
    // `lvl_req` is a *fraction of MAX_LEVEL*, not a level — 0.5 means level 50.
    mmorpg_omen: {
      blood: {
        id: "blood",
        lvl_req: 0.5,
        weight: 1000,
        affix_types: ["chaos_stat"],
        mods: [
          { type: "PERCENT", stat: "health", min: 5, max: 25 },
          { type: "PERCENT", stat: "armor", min: 2, max: 10 },
        ],
      },
    },
    mmorpg_game_balance: { original_balance: BALANCE },
    // Only a `core_stat` serializer may be allocated into; `bonus_stat_per_effect` carries a
    // `core_stat_data` block too and must not be mistaken for one.
    mmorpg_stat: {
      strength: { id: "strength", ser: "core_stat" },
      dexterity: { id: "dexterity", ser: "core_stat" },
      intelligence: { id: "intelligence", ser: "core_stat" },
      armor: { id: "armor", ser: "basic" },
      aoe_per_power_charge: { id: "aoe_per_power_charge", ser: "bonus_stat_per_effect" },
    },
    mmorpg_spell_school: { hunter: { id: "hunter" } },
    // `min_lvl` is the CHARACTER level needed, `max_lvl` the spell's own top rank. They are
    // not two ends of one range, and `guard` is the pack shape that proves it: it unlocks at
    // character level 15 and ranks only to 12.
    mmorpg_spells: {
      arrow: { id: "arrow", min_lvl: 1, max_lvl: 20, default_lvl: 0 },
      guard: { id: "guard", min_lvl: 15, max_lvl: 12, default_lvl: 0 },
    },
    mmorpg_gems: { amethyst0: { identifier: "amethyst0", gem_type: "amethyst", tier: 0 } },
    // A rune declares one stat list per `SlotFamily`; an empty list is `NOT_FAMILY`, which is a
    // refusal to insert rather than a rune that grants nothing. `tal` is weapon-only for that.
    mmorpg_runes: {
      el: {
        identifier: "el",
        on_armor_stats: [{ type: "PERCENT", stat: "armor", min: 6, max: 10 }],
        on_jewelry_stats: [{ type: "PERCENT", stat: "armor", min: 6, max: 10 }],
        on_weapons_stats: [{ type: "FLAT", stat: "weapon_damage", min: 1, max: 2 }],
      },
      ohm: {
        identifier: "ohm",
        on_armor_stats: [{ type: "FLAT", stat: "armor", min: 1, max: 2 }],
        on_jewelry_stats: [{ type: "FLAT", stat: "armor", min: 1, max: 2 }],
        on_weapons_stats: [{ type: "FLAT", stat: "weapon_damage", min: 1, max: 2 }],
      },
      tal: { identifier: "tal", on_weapons_stats: [{ type: "FLAT", stat: "weapon_damage", min: 1, max: 2 }] },
    },
    // `slots` is the base's `gear_slot`, and `runes` is an ordered recipe.
    mmorpg_runeword: {
      stealth: { id: "stealth", runes: ["el", "ohm"], slots: ["boots"], stats: [{ type: "FLAT", stat: "armor", min: 10, max: 20 }] },
      bow_word: { id: "bow_word", runes: ["el"], slots: ["bow"], stats: [] },
    },
    mmorpg_aura: { armor: { id: "armor" } },
    mmorpg_stat_condition: { on_low_life: { id: "on_low_life" } },
    mmorpg_unique_gears: {
      windrunner: {
        guid: "windrunner",
        base_gear: "bow",
        min_drop_lvl: 20,
        rarity: "unique",
        unique_stats: [
          { type: "FLAT", stat: "dexterity", min: 10, max: 20 },
          { type: "PERCENT", stat: "attack_speed", min: 5, max: 10 },
        ],
      },
    },
  });
}
