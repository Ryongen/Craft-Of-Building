import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILD_DOC_VERSION, isAuraEnabled, type BuildDoc, type Item } from "./build-doc.js";
import { isLegal, validateBuild, type Diagnostic } from "./validate.js";
import { countOmenPieces, omenBuckets, omenStatPercent } from "./queries.js";
import { BALANCE, RARITIES, baseGear, grid, makeSnapshot, rarity, standardSnapshot } from "./test-support.js";

function codes(diagnostics: readonly Diagnostic[], severity?: "error" | "warning"): string[] {
  return diagnostics
    .filter((d) => severity === undefined || d.severity === severity)
    .map((d) => d.code)
    .sort();
}

/** A legal rare pair of boots: exactly 3 affixes, 2 prefixes max, tiers at or below rare. */
function legalBoots(): Item {
  return {
    base: "boots",
    rarity: "rare",
    itemLevel: 30,
    baseRolls: [50],
    prefixes: [
      { affixId: "armor_prefix", tier: "rare", rollPercent: 40 },
      { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
    ],
    suffixes: [{ affixId: "armor_suffix", tier: "uncommon", rollPercent: 20 }],
  };
}

function build(overrides: Partial<BuildDoc> = {}): BuildDoc {
  return { schemaVersion: BUILD_DOC_VERSION, character: { level: 30 }, ...overrides };
}

test("a legal build produces no diagnostics at all", () => {
  const diagnostics = validateBuild(build({ gear: [legalBoots()] }), standardSnapshot());
  assert.deepEqual(diagnostics, []);
  assert.equal(isLegal(diagnostics), true);
});

test("an affix the base's tags exclude is rejected", () => {
  // no_bow_suffix targets weapon_family but excludes `bow`.
  const item: Item = {
    base: "bow",
    rarity: "common",
    itemLevel: 10,
    prefixes: [{ affixId: "no_bow_suffix", tier: "common", rollPercent: 5 }],
  };
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics).includes("affix-not-allowed-on-base"));
  // It is also in the wrong section, and both facts are worth reporting.
  assert.ok(codes(diagnostics).includes("affix-type-mismatch"));
});

test("too many prefixes for the rarity", () => {
  const item = legalBoots();
  item.prefixes = [
    { affixId: "armor_prefix", tier: "rare", rollPercent: 40 },
    { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
    { affixId: "solo_prefix", tier: "common", rollPercent: 10 },
    { affixId: "group_a_prefix", tier: "common", rollPercent: 10 },
  ];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics, "error").includes("too-many-prefixes"));
  assert.ok(codes(diagnostics, "error").includes("affix-count-mismatch"));
});

test("affix count must match the rarity exactly, even when under", () => {
  const item = legalBoots();
  item.suffixes = [];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics, "error").includes("affix-count-mismatch"));
});

test("a roll outside its tier's band is rejected", () => {
  const item = legalBoots();
  // 90 is a mythic-band roll; the affix claims the rare tier, which rolls 35..51.
  item.prefixes = [
    { affixId: "armor_prefix", tier: "rare", rollPercent: 90 },
    { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
  ];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.deepEqual(codes(diagnostics, "error"), ["roll-outside-tier-band"]);
});

test("an affix tier above the item's rarity is legal, because upgraded items carry them", () => {
  const item = legalBoots();
  item.prefixes = [
    // A mythic-tier affix on a rare item, rolled inside the mythic band. `randomizeTier` would
    // not hand this out at roll time, but `UpgradeRarityItemMod` walks an affix's tier up to
    // fit its rescaled roll with no ceiling at the item, and the pack ships that currency.
    { affixId: "armor_prefix", tier: "mythic", rollPercent: 90 },
    { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
  ];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.deepEqual(diagnostics, []);
});

test("a unique rarity can never be an affix tier", () => {
  const item = legalBoots();
  item.prefixes = [
    { affixId: "armor_prefix", tier: "unique", rollPercent: 40 },
    { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
  ];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics, "error").includes("unique-rarity-as-affix-tier"));
});

test("unknown ids are reported rather than ignored", () => {
  const item: Item = {
    base: "boots",
    rarity: "rare",
    itemLevel: 10,
    prefixes: [
      { affixId: "no_such_affix", tier: "common", rollPercent: 5 },
      { affixId: "armor_prefix", tier: "common", rollPercent: 5 },
    ],
    suffixes: [{ affixId: "armor_suffix", tier: "common", rollPercent: 5 }],
  };
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.deepEqual(codes(diagnostics, "error"), ["unknown-affix"]);
});

test("an unimplemented req_type fails loud instead of being assumed true", () => {
  const item: Item = {
    base: "boots",
    rarity: "common",
    itemLevel: 10,
    prefixes: [{ affixId: "weird_prefix", tier: "common", rollPercent: 5 }],
  };
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics, "error").includes("unknown-req-type"));
});

test("exclusivity flags are enforced", () => {
  const onlyOne: Item = {
    base: "boots",
    rarity: "uncommon",
    itemLevel: 10,
    prefixes: [
      { affixId: "solo_prefix", tier: "common", rollPercent: 5 },
      { affixId: "solo_prefix", tier: "common", rollPercent: 6 },
    ],
  };
  assert.ok(codes(validateBuild(build({ gear: [onlyOne] }), standardSnapshot())).includes("duplicate-only-one-per-item"));

  // Different affixes, same one_of_a_kind group, across two different sections.
  const sameGroup: Item = {
    base: "boots",
    rarity: "uncommon",
    itemLevel: 10,
    prefixes: [{ affixId: "group_a_prefix", tier: "common", rollPercent: 5 }],
    suffixes: [{ affixId: "group_b_suffix", tier: "common", rollPercent: 5 }],
  };
  assert.ok(codes(validateBuild(build({ gear: [sameGroup] }), standardSnapshot())).includes("one-of-a-kind-conflict"));
});

test("uniques are a different shape, not a flag", () => {
  const snapshot = standardSnapshot();

  const wrongBase: Item = { base: "boots", rarity: "unique", itemLevel: 30, unique: "windrunner" };
  assert.ok(codes(validateBuild(build({ gear: [wrongBase] }), snapshot)).includes("unique-base-mismatch"));

  const tooLow: Item = { base: "bow", rarity: "unique", itemLevel: 5, unique: "windrunner" };
  assert.ok(codes(validateBuild(build({ gear: [tooLow] }), snapshot)).includes("unique-below-min-drop-level"));

  const withAffixes: Item = {
    base: "bow",
    rarity: "unique",
    itemLevel: 30,
    unique: "windrunner",
    prefixes: [{ affixId: "weapon_prefix", tier: "common", rollPercent: 5 }],
  };
  assert.ok(codes(validateBuild(build({ gear: [withAffixes] }), snapshot)).includes("unique-with-affixes"));

  // windrunner has two unique stats, so one roll leaves the second at 0%.
  const tooFewRolls: Item = {
    base: "bow",
    rarity: "unique",
    itemLevel: 30,
    unique: "windrunner",
    uniqueRolls: [50],
  };
  assert.ok(codes(validateBuild(build({ gear: [tooFewRolls] }), snapshot)).includes("unique-rolls-too-few"));

  // The game stores ten roll slots on every unique and reads only the first `uniqueStats`
  // of them, so a capture of a two-stat unique legitimately carries ten. Neither the
  // short-list error nor the over-slots warning should fire.
  const tenRolls: Item = {
    base: "bow",
    rarity: "unique",
    itemLevel: 30,
    unique: "windrunner",
    uniqueRolls: [50, 60, 70, 80, 90, 10, 20, 30, 40, 0],
  };
  const tenCodes = codes(validateBuild(build({ gear: [tenRolls] }), snapshot));
  assert.ok(!tenCodes.includes("unique-rolls-too-few"));
  assert.ok(!tenCodes.includes("unique-rolls-over-slots"));

  // More than the ten the game can store is a capture bug, but a harmless one: the engine
  // reads the first two either way.
  const elevenRolls: Item = { ...tenRolls, uniqueRolls: [...tenRolls.uniqueRolls!, 55] };
  assert.ok(codes(validateBuild(build({ gear: [elevenRolls] }), snapshot)).includes("unique-rolls-over-slots"));

  const legal: Item = {
    base: "bow",
    rarity: "unique",
    itemLevel: 30,
    unique: "windrunner",
    uniqueRolls: [50, 75],
  };
  assert.deepEqual(validateBuild(build({ gear: [legal] }), snapshot), []);
});

test("naming a gear slot where a base belongs names the real bases", () => {
  // `helmet` is a slot; the bases are `plate_helmet`, `leather_helmet`, ... This is the
  // easiest mistake to make by hand, so the message has to do more than say "unknown".
  const item: Item = { base: "helmet", rarity: "common", itemLevel: 10 };
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  const unknownBase = diagnostics.find((d) => d.code === "unknown-base");
  assert.ok(unknownBase);
  assert.match(unknownBase.message, /is a gear slot, not a base gear type/);
  assert.match(unknownBase.message, /leather_helmet/);
  assert.match(unknownBase.message, /plate_helmet/);
});

test("socket and rune caps come from the rarity", () => {
  const item = legalBoots();
  item.sockets = ["amethyst0", "amethyst0"]; // rare allows 1 socket
  item.runes = ["el", "ohm"]; // rare allows 1 rune
  item.runeword = "nonexistent";
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  const found = codes(diagnostics, "error");
  // `sockets.max` gates `canAddSocket` when an orb is used, not what an item may already
  // carry: a captured mythic helmet holds two socketed gems and the game applies both. So the
  // socket count reports as a warning while the rune and runeword rules still refuse.
  assert.ok(!found.includes("too-many-sockets"));
  assert.ok(codes(diagnostics, "warning").includes("too-many-sockets"));
  assert.ok(found.includes("too-many-runes"));
  assert.ok(found.includes("unknown-runeword"));
  assert.ok(found.includes("runeword-on-disallowed-rarity"));
});

test("gems and runes share one socket list, so the cap is on the total", () => {
  // `GearSocketsData.so` holds both and `getEmptySockets()` subtracts the whole list, so one
  // gem plus one rune already fills a rare's single socket. Counting them separately said this
  // item was within its caps twice over.
  const item = legalBoots();
  item.sockets = ["amethyst0"];
  item.runes = ["el"];
  const diagnostics = validateBuild(build({ gear: [item] }), standardSnapshot());
  assert.ok(codes(diagnostics, "warning").includes("too-many-sockets"));
  assert.ok(!codes(diagnostics, "error").includes("too-many-gems"));
});

test("a runed base refuses gems outright rather than capping them", () => {
  // `if (rar.max_gems > 0) { ...cap... } else { return failure(RARITY_CANT_HAVE_ANY_GEMS); }`
  const item: Item = {
    base: "boots",
    rarity: "runeword",
    itemLevel: 30,
    baseRolls: [50],
    sockets: ["amethyst0"],
    runes: ["el", "ohm"],
    runeword: "stealth",
    runewordRoll: 40,
  };
  const found = codes(validateBuild(build({ gear: [item] }), standardSnapshot()), "error");
  assert.ok(found.includes("gems-on-runed-gear"));
  // And it is the outright refusal, not the cap message.
  assert.ok(!found.includes("too-many-gems"));
});

test("a runeword's runes are an ordered, adjacent recipe", () => {
  const snapshot = standardSnapshot();
  const runed = (runes: string[]): Item => ({
    base: "boots",
    rarity: "runeword",
    itemLevel: 30,
    baseRolls: [50],
    runes,
    runeword: "stealth",
    runewordRoll: 40,
  });

  // `el` then `ohm` spells it.
  assert.deepEqual(validateBuild(build({ gear: [runed(["el", "ohm"])] }), snapshot), []);

  // The right set in the wrong order does not: `hasMatchingRunesToCreate` concatenates the ids
  // and asks for a substring, so "ohmel" does not contain "elohm".
  //
  // It warns rather than refuses. Nothing re-checks the recipe once the runeword is set —
  // `GetAllStats` reads only `isRegistered(rw)` — and the Amfk capture holds a spear carrying a
  // runeword whose slot list no longer includes spears, paid out in full.
  assert.ok(codes(validateBuild(build({ gear: [runed(["ohm", "el"])] }), snapshot), "warning")
    .includes("runeword-runes-mismatch"));

  // Interrupted is not adjacent either.
  assert.ok(codes(validateBuild(build({ gear: [runed(["el", "tal", "ohm"])] }), snapshot), "warning")
    .includes("runeword-runes-mismatch"));

  // A longer sequence that *contains* the recipe is fine — the test really is `contains`.
  assert.ok(!codes(validateBuild(build({ gear: [runed(["tal", "el", "ohm"])] }), snapshot))
    .includes("runeword-runes-mismatch"));
});

test("a runeword only goes on a slot it names", () => {
  // `bow_word` lists `bow`; these are boots.
  const item: Item = {
    base: "boots",
    rarity: "runeword",
    itemLevel: 30,
    baseRolls: [50],
    runes: ["el"],
    runeword: "bow_word",
  };
  // A gate on *making* one, so it warns: an item that already carries a runeword keeps paying
  // it out whatever the pack later says about slots.
  assert.ok(codes(validateBuild(build({ gear: [item] }), standardSnapshot()), "warning")
    .includes("runeword-wrong-slot"));
});

test("a rune with no stats for the base's family cannot be inserted at all", () => {
  // `tal` is weapon-only, and `Chats.NOT_FAMILY` is a refusal rather than a dead socket.
  const item = legalBoots();
  item.runes = ["tal"];
  assert.ok(codes(validateBuild(build({ gear: [item] }), standardSnapshot()), "error")
    .includes("rune-wrong-family"));

  // The same rune on a bow is fine.
  const bow: Item = { base: "bow", rarity: "common", itemLevel: 10, prefixes: [{ affixId: "weapon_prefix", tier: "common", rollPercent: 5 }], runes: ["tal"] };
  assert.ok(!codes(validateBuild(build({ gear: [bow] }), standardSnapshot()), "error")
    .includes("rune-wrong-family"));
});

test("the same rune twice is one socket with a better roll, not two sockets", () => {
  const item = legalBoots();
  item.runes = ["el", "el"];
  assert.ok(codes(validateBuild(build({ gear: [item] }), standardSnapshot()), "error")
    .includes("duplicate-rune"));
});

test("rune and runeword rolls are 0-100", () => {
  const item = legalBoots();
  item.runes = ["el"];
  item.runeRolls = [140];
  item.runewordRoll = -3;
  const found = codes(validateBuild(build({ gear: [item] }), standardSnapshot()), "error");
  assert.ok(found.includes("rune-roll-out-of-range"));
  assert.ok(found.includes("runeword-roll-out-of-range"));
});

test("the hotbar holds eight Skills, and a disabled one does not take a slot", () => {
  const bar = (n: number, disabled = 0): BuildDoc =>
    build({
      character: { level: 30 },
      skills: [
        ...Array.from({ length: n }, () => ({ spellId: "arrow" })),
        ...Array.from({ length: disabled }, () => ({ spellId: "arrow", enabled: false })),
      ],
    });

  assert.ok(!codes(validateBuild(bar(8), standardSnapshot()), "error").includes("too-many-active-skills"));
  assert.ok(codes(validateBuild(bar(9), standardSnapshot()), "error").includes("too-many-active-skills"));
  // `GemInventoryHelper.MAX_SKILL_GEMS` bounds what is *on*, and keeping a setup you are
  // comparing against is exactly what `enabled: false` is for.
  assert.ok(!codes(validateBuild(bar(8, 4), standardSnapshot()), "error").includes("too-many-active-skills"));
});

test("tree allocations must land on perk cells", () => {
  const snapshot = standardSnapshot();

  // (1, 1) is empty, (6, 4) is [CENTER], (2, 3) is a connector glyph, (0, 0) is the border.
  for (const [row, col] of [[1, 1], [6, 4], [2, 3], [0, 0]] as const) {
    const doc = build({ tree: { talents: [[row, col]] } });
    assert.deepEqual(
      codes(validateBuild(doc, snapshot), "error"),
      ["cell-not-allocatable"],
      `[${row}, ${col}]`,
    );
  }

  const outside = build({ tree: { talents: [[99, 99]] } });
  assert.deepEqual(codes(validateBuild(outside, snapshot), "error"), ["coord-out-of-bounds"]);

  const twice = build({ tree: { talents: [[2, 2], [2, 2]] } });
  assert.deepEqual(codes(validateBuild(twice, snapshot), "error"), ["duplicate-allocation"]);

  // `start` is an entry perk and `armor_flat` is one `o`-channel hop from it.
  const legal = build({ tree: { talents: [[2, 2], [2, 4]] } });
  assert.deepEqual(validateBuild(legal, snapshot), []);
});

test("allocations must reach an entry perk, and only one perk per one_kind", () => {
  const snapshot = standardSnapshot();

  // `armor_flat` alone: connected to nothing allocated, and no start taken at all.
  const noStart = build({ tree: { talents: [[2, 4]] } });
  assert.deepEqual(codes(validateBuild(noStart, snapshot), "error"), [
    "no-entry-allocated",
  ]);

  // A start plus an island. `dodge_flat` only touches `armor_flat`, which is not allocated.
  const orphan = build({ tree: { talents: [[2, 2], [2, 6]] } });
  assert.deepEqual(codes(validateBuild(orphan, snapshot), "error"), ["not-connected"]);

  // Two entry perks sharing one_kind: "start". Both are individually allocatable — entry
  // perks need no neighbour — which is exactly why one_kind has to be checked separately.
  const twoStarts = build({ tree: { talents: [[2, 2], [5, 6]] } });
  assert.deepEqual(codes(validateBuild(twoStarts, snapshot), "error"), ["one-kind-conflict"]);

  // The full chain, including the `k` channel out to `far_perk`.
  const chain = build({ tree: { talents: [[2, 2], [2, 4], [2, 6], [5, 2]] } });
  assert.deepEqual(validateBuild(chain, snapshot), []);
});

test("an ascendancy is checked against the one_kind that defines the set", () => {
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_game_balance: { original_balance: BALANCE },
    mmorpg_perk: {
      lich_class: { id: "lich_class", type: "ASC", is_entry: true, one_kind: "ascendancy", stats: [] },
      hunter_class: { id: "hunter_class", type: "ASC", is_entry: true, one_kind: "ascendancy", stats: [] },
    },
  });

  const good = build({ character: { level: 10, ascendancy: "lich_class" } });
  assert.deepEqual(codes(validateBuild(good, snapshot), "error"), []);

  const bad = build({ character: { level: 10, ascendancy: "hunter" } });
  assert.deepEqual(codes(validateBuild(bad, snapshot), "error"), ["unknown-ascendancy"]);
});

test("point budgets: bonus points warn, impossible spends fail", () => {
  // A single row of 40 allocatable perks, so a low-level character can overspend.
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    // Every node an entry, so connectivity never fires and the test stays about budgets.
    // A row of adjacent talents with no connector beside them has no edges at all: the
    // game's search loops over `connectorTypes`, which is empty here.
    mmorpg_perk: {
      armor_flat: { id: "armor_flat", type: "STAT", is_entry: true, stats: [] },
    },
    mmorpg_talent_tree: { talents: grid([Array.from({ length: 40 }, () => "armor_flat")]) },
    mmorpg_game_balance: { original_balance: BALANCE },
  });
  const coords = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [0, i]);

  // Level 1 gives 2 points from levelling, 27 including every obtainable bonus point.
  const withinLevelling = build({ character: { level: 1 }, tree: { talents: coords(2) } });
  assert.deepEqual(validateBuild(withinLevelling, snapshot), []);

  const needsBonus = build({ character: { level: 1 }, tree: { talents: coords(10) } });
  const bonusDiagnostics = validateBuild(needsBonus, snapshot);
  assert.deepEqual(codes(bonusDiagnostics, "error"), []);
  assert.deepEqual(codes(bonusDiagnostics, "warning"), ["point-budget-needs-bonus"]);

  const impossible = build({ character: { level: 1 }, tree: { talents: coords(30) } });
  assert.deepEqual(codes(validateBuild(impossible, snapshot), "error"), ["point-budget-exceeded"]);
});

test("`character.pointTotals` settles a spend that levelling alone could not explain", () => {
  // The same tree as above, so the only thing changing is whether the game counted the points.
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_perk: {
      armor_flat: { id: "armor_flat", type: "STAT", is_entry: true, stats: [] },
    },
    mmorpg_talent_tree: { talents: grid([Array.from({ length: 40 }, () => "armor_flat")]) },
    mmorpg_game_balance: { original_balance: BALANCE },
  });
  const coords = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [0, i]);

  // 10 points at level 1 is 8 past what levelling grants — a warning with nothing to go on.
  const derivedOnly = build({ character: { level: 1 }, tree: { talents: coords(10) } });
  assert.deepEqual(codes(validateBuild(derivedOnly, snapshot), "warning"), [
    "point-budget-needs-bonus",
  ]);

  // A capture records `getFreePoints`, bonus points included. That is the game's own count, so
  // there is nothing left to be suspicious about.
  const counted = build({
    character: { level: 1, pointTotals: { TALENTS: 10 } },
    tree: { talents: coords(10) },
  });
  assert.deepEqual(validateBuild(counted, snapshot), []);

  // And it cuts the other way: above the recorded total there is no band of doubt to warn in.
  const overCounted = build({
    character: { level: 1, pointTotals: { TALENTS: 9 } },
    tree: { talents: coords(10) },
  });
  assert.deepEqual(codes(validateBuild(overCounted, snapshot), "error"), ["point-budget-exceeded"]);

  // The stat screen spends from the same machinery, and used to ignore the recorded total.
  const statPoints = build({
    character: { level: 1, pointTotals: { STATS: 12 }, statPoints: { dexterity: 12 } },
  });
  assert.deepEqual(validateBuild(statPoints, snapshot), []);
});

test("references are checked and duplicates rejected", () => {
  const snapshot = standardSnapshot();
  const doc = build({
    character: { level: 30, school: "no_such_school" },
    auras: [{ id: "armor" }, { id: "armor" }, { id: "ghost" }],
    exileEffects: [{ id: "nope" }],
    config: { conditions: { on_low_life: true, invented_condition: true } },
  });
  const found = codes(validateBuild(doc, snapshot), "error");
  assert.ok(found.includes("unknown-spell-school"));
  assert.ok(found.includes("duplicate-aura"));
  assert.ok(found.includes("unknown-aura"));
  assert.ok(found.includes("unknown-exile-effect"));
  assert.ok(found.includes("unknown-condition"));
});

test("level bounds come from the balance file", () => {
  const snapshot = standardSnapshot();
  assert.deepEqual(codes(validateBuild(build({ character: { level: 0 } }), snapshot), "error"), ["level-out-of-range"]);
  assert.deepEqual(codes(validateBuild(build({ character: { level: 101 } }), snapshot), "error"), ["level-out-of-range"]);
  assert.deepEqual(validateBuild(build({ character: { level: 100 } }), snapshot), []);
});

test("a wrong schema version is reported without hiding other problems", () => {
  const doc: BuildDoc = { schemaVersion: 99, character: { level: 30 }, tree: { talents: [[0, 0]] } };
  const found = codes(validateBuild(doc, standardSnapshot()), "error");
  assert.deepEqual(found, ["cell-not-allocatable", "unsupported-schema-version"]);
});

test("auras are on unless explicitly turned off", () => {
  assert.equal(isAuraEnabled({ id: "armor" }), true);
  assert.equal(isAuraEnabled({ id: "armor", enabled: false }), false);
  assert.equal(isAuraEnabled({ id: "armor", enabled: true }), true);
});

// ---------------------------------------------------------------------------
// Equipment layout — settled in phase 4 from CharacterEquipment.java
// ---------------------------------------------------------------------------

/** A bare item in a slot, with no affixes, so only the layout rules can fire. */
function bare(base: string, rarity = "common"): Item {
  return { base, rarity, itemLevel: 1, prefixes: [{ affixId: "armor_prefix", tier: "common", rollPercent: 5 }] };
}

test("two rings are legal, two necklaces are not", () => {
  const snapshot = standardSnapshot();
  // `CURIO_BLOCKS` gives RING a count of 2 and NECKLACE a count of 1.
  const twoRings = validateBuild(
    build({ gear: [{ base: "ring", rarity: "common", itemLevel: 1 }, { base: "ring", rarity: "common", itemLevel: 1 }] }),
    snapshot,
  );
  assert.ok(!codes(twoRings).includes("slot-over-capacity"), JSON.stringify(twoRings));

  const twoNecklaces = validateBuild(
    build({
      gear: [
        { base: "necklace", rarity: "common", itemLevel: 1 },
        { base: "necklace", rarity: "common", itemLevel: 1 },
      ],
    }),
    snapshot,
  );
  assert.ok(codes(twoNecklaces, "error").includes("slot-over-capacity"));
});

test("three rings overflow the two the mod gives you", () => {
  const gear: Item[] = [1, 2, 3].map(() => ({ base: "ring", rarity: "common", itemLevel: 1 }));
  const diagnostics = validateBuild(build({ gear }), standardSnapshot());
  assert.ok(codes(diagnostics, "error").includes("slot-over-capacity"));
  // The complaint points at the first item past the cap, not at the whole list.
  assert.ok(diagnostics.some((d) => d.code === "slot-over-capacity" && d.path === "gear[2]"));
});

test("one helmet per character, whichever material it is", () => {
  // `plate_helmet` and `leather_helmet` are different bases in the *same* slot, which is
  // exactly the case a per-base check would miss.
  const diagnostics = validateBuild(
    build({ gear: [bare("plate_helmet"), bare("leather_helmet")] }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("slot-over-capacity"));
});

test("a character has one mainhand, whichever kind of weapon fills it", () => {
  // The limit is on the family: `bow` and `greatsword` are separate `mmorpg_gear_slot`
  // entries, so only a family-level check catches this.
  const diagnostics = validateBuild(
    build({
      gear: [
        { base: "bow", rarity: "common", itemLevel: 1 },
        { base: "greatsword", rarity: "common", itemLevel: 1 },
      ],
    }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("slot-family-over-capacity"));
});

test("a slot the mod says nothing about is not checked at all", () => {
  // `head` is a pack-added Jewelry slot matching no CurioBlock. Guessing a capacity of 1 for it
  // would be inventing a rule, which is what phase 0.5 refused to do.
  //
  // This used to be written against `elytra`, which is no longer an example of the case: it has
  // a capacity now, on the pack author's own report that the pack gives exactly one elytra slot.
  // `SLOT_CAPACITY` records where that number came from, since the Java does not say it.
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_gear_slot: { head: { id: "head", fam: "Jewelry" } },
    mmorpg_base_gear_types: { head: baseGear("head", "head", ["head"]) },
    mmorpg_game_balance: { original_balance: BALANCE },
  });
  const gear: Item[] = [1, 2, 3].map(() => ({ base: "head", rarity: "common", itemLevel: 1 }));
  const diagnostics = validateBuild(build({ gear }), snapshot);
  assert.ok(!codes(diagnostics).includes("slot-over-capacity"), JSON.stringify(diagnostics));
});

test("the elytra slot holds one, which is a stated fact rather than a derived one", () => {
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_gear_slot: { elytra: { id: "elytra", fam: "Jewelry" } },
    mmorpg_base_gear_types: { elytra: baseGear("elytra", "elytra", ["elytra"]) },
    mmorpg_game_balance: { original_balance: BALANCE },
  });
  const two: Item[] = [1, 2].map(() => ({ base: "elytra", rarity: "common", itemLevel: 1 }));
  assert.ok(codes(validateBuild(build({ gear: two }), snapshot)).includes("slot-over-capacity"));

  const one: Item[] = [{ base: "elytra", rarity: "common", itemLevel: 1 }];
  assert.ok(!codes(validateBuild(build({ gear: one }), snapshot)).includes("slot-over-capacity"));
});

test("an offhand beside a two-handed weapon is an error, because it grants nothing", () => {
  // Better Combat's `getEquippedStack_Pre` returns EMPTY for OFFHAND while a two-handed
  // weapon is held, so Mine and Slash sums nothing from the shield.
  const diagnostics = validateBuild(
    build({
      gear: [
        { base: "greatsword", rarity: "common", itemLevel: 1 },
        { base: "shield", rarity: "common", itemLevel: 1 },
      ],
    }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("offhand-with-two-handed-weapon"));
});

test("an offhand beside a one-handed weapon is fine", () => {
  const diagnostics = validateBuild(
    build({
      gear: [
        { base: "bow", rarity: "common", itemLevel: 1 },
        { base: "shield", rarity: "common", itemLevel: 1 },
      ],
    }),
    standardSnapshot(),
  );
  assert.ok(!codes(diagnostics).includes("offhand-with-two-handed-weapon"), JSON.stringify(diagnostics));
});

test("a two-handed weapon on its own raises no layout complaint", () => {
  const diagnostics = validateBuild(
    build({ gear: [{ base: "greatsword", rarity: "common", itemLevel: 1 }] }),
    standardSnapshot(),
  );
  // The affix-count rule still fires — `common` is exactly one affix and this has none — so
  // assert on the layout codes rather than on silence.
  assert.ok(!codes(diagnostics).includes("offhand-with-two-handed-weapon"));
  assert.ok(!codes(diagnostics).includes("slot-family-over-capacity"));
});

// ---------------------------------------------------------------------------
// Stat points
// ---------------------------------------------------------------------------

test("stat points may only go into a CoreStat", () => {
  const snapshot = standardSnapshot();
  const legal = validateBuild(
    build({ character: { level: 30, statPoints: { strength: 10, dexterity: 5 } } }),
    snapshot,
  );
  assert.deepEqual(codes(legal, "error"), []);

  // `aoe_per_power_charge` carries a `core_stat_data` block but is a `bonus_stat_per_effect`,
  // and `AllocateStatPacket` rejects it. So must this.
  const wrong = validateBuild(
    build({ character: { level: 30, statPoints: { aoe_per_power_charge: 1 } } }),
    snapshot,
  );
  assert.ok(codes(wrong, "error").includes("not-a-core-stat"));

  const madeUp = validateBuild(
    build({ character: { level: 30, statPoints: { not_a_stat: 1 } } }),
    snapshot,
  );
  assert.ok(codes(madeUp, "error").includes("not-a-core-stat"));
});

test("stat points are whole and non-negative", () => {
  const snapshot = standardSnapshot();
  for (const bad of [-1, 2.5]) {
    const diagnostics = validateBuild(
      build({ character: { level: 30, statPoints: { strength: bad } } }),
      snapshot,
    );
    assert.ok(codes(diagnostics, "error").includes("bad-stat-point-count"), `${bad} was accepted`);
  }
});

test("the stat point budget is one per level, and bonus points only warn", () => {
  const snapshot = standardSnapshot();
  // `points_per_lvl: 1`, so level 30 grants 30.
  const exact = validateBuild(
    build({ character: { level: 30, statPoints: { strength: 30 } } }),
    snapshot,
  );
  assert.deepEqual(codes(exact), []);

  // Past levelling but inside `max_bonus_points: 50` — legal in game, unverifiable here.
  const bonus = validateBuild(
    build({ character: { level: 30, statPoints: { strength: 60 } } }),
    snapshot,
  );
  assert.deepEqual(codes(bonus, "error"), []);
  assert.ok(codes(bonus, "warning").includes("stat-points-beyond-levelling"));

  // Past even that: impossible.
  const over = validateBuild(
    build({ character: { level: 30, statPoints: { strength: 200 } } }),
    snapshot,
  );
  assert.ok(codes(over, "error").includes("stat-points-over-budget"));
});

// ---------------------------------------------------------------------------
// Omens
// ---------------------------------------------------------------------------

/** `blood` at the level it actually drops, with requirements inside the generator's bands. */
function legalOmen(): NonNullable<BuildDoc["omen"]> {
  return {
    id: "blood",
    itemLevel: 60,
    rarity: "rare",
    requires: { NORMAL: 2, RUNED: 1 },
    slotRequirements: [{ slot: "helmet", rarityType: "NORMAL" }],
  };
}

test("a legal omen produces no diagnostics", () => {
  const diagnostics = validateBuild(build({ omen: legalOmen() }), standardSnapshot()).filter((d) =>
    d.path.startsWith("omen"),
  );
  assert.deepEqual(diagnostics, []);
});

test("omen requirements are counted over GearRarityType, not over rarities", () => {
  // `rare` is a rarity; `NORMAL` is the type. Naming the rarity is the obvious mistake.
  const diagnostics = validateBuild(
    build({ omen: { ...legalOmen(), requires: { rare: 2 } } }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("unknown-rarity-type"));
});

test("an omen slot requirement can never name the mainhand", () => {
  // `Omen.getRandomSlotReq` excludes weapons — "they're a lot of times swapped" — and
  // `recalcGears` never reads the mainhand, so such a requirement is unsatisfiable.
  const diagnostics = validateBuild(
    build({ omen: { ...legalOmen(), slotRequirements: [{ slot: "bow", rarityType: "NORMAL" }] } }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("omen-slot-requirement-on-weapon"));
});

test("lvl_req is a fraction of MAX_LEVEL, not a level", () => {
  // 0.5 of MAX_LEVEL 100 is 50. Reading it as a level would make every omen legal at 1.
  const low = validateBuild(build({ omen: { ...legalOmen(), itemLevel: 20 } }), standardSnapshot());
  assert.ok(codes(low, "warning").includes("omen-below-drop-level"));

  const fine = validateBuild(build({ omen: { ...legalOmen(), itemLevel: 50 } }), standardSnapshot());
  assert.ok(!codes(fine).includes("omen-below-drop-level"));
});

test("requirements outside the rarity's band warn rather than error", () => {
  // `OmenBlueprint` is the only thing enforcing the bands, and currencies modify an omen after
  // it drops, so an odd combination is suspicious rather than impossible.
  const diagnostics = validateBuild(
    build({ omen: { ...legalOmen(), requires: { NORMAL: 9 } } }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "warning").includes("omen-requirement-outside-band"));
  assert.ok(!codes(diagnostics, "error").includes("omen-requirement-outside-band"));
});

test("an omen only accepts the affix types it declares", () => {
  // `Omen.affix_types` is `chaos_stat` throughout this pack — the corruption pool, not
  // prefixes and suffixes.
  const diagnostics = validateBuild(
    build({
      omen: {
        ...legalOmen(),
        affixes: [{ affixId: "armor_prefix", tier: "common", rollPercent: 5 }],
      },
    }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "error").includes("affix-type-not-on-omen"));
});

test("an omen's affix is not held inside its tier's band, because it never rolled", () => {
  // `OmenBlueprint` writes `adata.p = OmenData.getStatPercent(...)` and never calls
  // `RerollNumbers`, so nothing puts `p` inside the band `rar` names. One NORMAL piece and one
  // RUNED derive 20, where `rare` rolls 35..51 — and this is the omen the generator makes, at
  // the bottom of its own difficulty bands. It used to be a `roll-outside-tier-band` error.
  const diagnostics = validateBuild(
    build({
      omen: {
        ...legalOmen(),
        requires: { NORMAL: 1, RUNED: 1 },
        slotRequirements: [],
        affixes: [{ affixId: "chaos_armor", tier: "rare", rollPercent: 20 }],
      },
    }),
    standardSnapshot(),
  );
  assert.deepEqual(diagnostics.filter((d) => d.path.startsWith("omen")), []);
});

test("a stored omen affix tier or roll that disagrees with the omen warns, and is ignored", () => {
  // Both fields are copies: `adata.rar` is the omen's rarity and `adata.p` its derived
  // percent, and `UpgradeOmenRarityItemMod` rewrites both whenever the rarity moves. So a
  // disagreement means the document was written without re-deriving — worth saying, not worth
  // refusing over, since `omenBuckets` re-derives anyway.
  const diagnostics = validateBuild(
    build({
      omen: {
        ...legalOmen(),
        requires: { NORMAL: 1, RUNED: 1 },
        slotRequirements: [],
        affixes: [{ affixId: "chaos_armor", tier: "mythic", rollPercent: 95 }],
      },
    }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics, "warning").includes("omen-affix-tier-not-omen-rarity"));
  assert.ok(codes(diagnostics, "warning").includes("omen-affix-roll-not-derived"));
  assert.deepEqual(codes(diagnostics, "error").filter((c) => c.startsWith("omen") || c === "roll-outside-tier-band"), []);
});

test("the stat percent is earned from the requirements, and is not capped at 100", () => {
  const snapshot = standardSnapshot();
  // (2 + 1) * 10 + 1 slot req * 10 = 40, times `rare`'s stat_multi of 1.
  assert.equal(omenStatPercent(snapshot, { NORMAL: 2, RUNED: 1 }, 1, "rare"), 40);
  // Nothing clamps it: `ExactStatData.fromStatModifier` is a bare interpolation, so a heavily
  // conditioned omen puts its mods above their declared maximum.
  assert.equal(omenStatPercent(snapshot, { NORMAL: 2, UNIQUE: 2, RUNED: 3 }, 3, "rare"), 100);
  assert.ok(omenStatPercent(snapshot, { NORMAL: 5, UNIQUE: 5, RUNED: 5 }, 3, "rare") > 100);
});

test("the stat percent truncates the stat_multi, as Java's compound assignment does", () => {
  // `int num; num *= float stat_multi` narrows back to int. 70 * 1.25 is 87, not 87.5.
  const snapshot = makeSnapshot({
    mmorpg_gear_rarity: {
      ...RARITIES,
      mythic: rarity("mythic", 5, 6, { min: 86, max: 100 }, {
        omens: { stat_multi: 1.25, normal: { min: 1, max: 2 } },
      }),
    },
    mmorpg_omen: { blood: { id: "blood", lvl_req: 0.5, mods: [] } },
  });
  assert.equal(omenStatPercent(snapshot, { NORMAL: 4 }, 3, "mythic"), 87);
});

test("piece counting excludes the mainhand, caps per type, and needs the level", () => {
  const snapshot = standardSnapshot();
  const setup = { ...legalOmen(), requires: { NORMAL: 2 }, slotRequirements: [] };

  const armour: Item[] = [
    { base: "plate_helmet", rarity: "rare", itemLevel: 1 },
    { base: "leather_helmet", rarity: "epic", itemLevel: 1 },
    { base: "boots", rarity: "common", itemLevel: 1 },
  ];
  // Three NORMAL pieces against a requirement of two counts two — `map.getOrDefault(type, 0)
  // < rarities.getOrDefault(type, 0)` is the cap.
  assert.equal(countOmenPieces(snapshot, armour, setup, 60), 2);

  // A weapon never counts: `recalcGears` collects armour, the offhand and the curios only.
  const weaponOnly: Item[] = [{ base: "bow", rarity: "rare", itemLevel: 1 }];
  assert.equal(countOmenPieces(snapshot, weaponOnly, setup, 60), 0);

  // `getGear()` filters on `isUsableBy`, which refuses an item above the holder's level.
  assert.equal(countOmenPieces(snapshot, armour, setup, 0), 0);

  // A type the omen did not ask for is capped at zero, so it contributes nothing.
  const uniques: Item[] = [{ base: "plate_helmet", rarity: "unique", itemLevel: 1 }];
  assert.equal(countOmenPieces(snapshot, uniques, setup, 60), 0);
});

test("a slot requirement disqualifies a piece rather than adding one", () => {
  const snapshot = standardSnapshot();
  const setup = {
    ...legalOmen(),
    requires: { NORMAL: 2 },
    slotRequirements: [{ slot: "helmet", rarityType: "UNIQUE" }],
  };
  // The helmet is NORMAL where the requirement says UNIQUE, so it stops counting entirely —
  // and the boots, in a slot nobody named, are unaffected.
  const gear: Item[] = [
    { base: "plate_helmet", rarity: "rare", itemLevel: 1 },
    { base: "boots", rarity: "rare", itemLevel: 1 },
  ];
  assert.equal(countOmenPieces(snapshot, gear, setup, 60), 1);
});

test("buckets put the omen's own mods at the full requirement and each affix one earlier", () => {
  const snapshot = standardSnapshot();
  const buckets = omenBuckets(snapshot, {
    ...legalOmen(),
    requires: { NORMAL: 2, RUNED: 2 },
    affixes: [
      { affixId: "armor_suffix", tier: "common", rollPercent: 5 },
      { affixId: "armor_prefix", tier: "common", rollPercent: 5 },
    ],
  });
  assert.deepEqual(
    buckets.map((b) => b.pieces),
    [4, 3, 2],
  );
  assert.ok(buckets[0]!.mods !== undefined, "the omen's own mods sit at the full requirement");
  assert.equal(buckets[1]!.affix?.affixId, "armor_suffix");
});

test("every bucket carries the one derived percent, affixes included", () => {
  // (2 + 1) * 10 for the requirements + 10 for the slot requirement, times `rare`'s
  // `stat_multi` of 1. The document says `mythic` at 95 on both affixes and neither survives:
  // `adata.rar` and `adata.p` are the omen's, so `omenBuckets` re-derives them.
  const buckets = omenBuckets(standardSnapshot(), {
    ...legalOmen(),
    affixes: [
      { affixId: "chaos_armor", tier: "mythic", rollPercent: 95 },
      { affixId: "chaos_armor", tier: "mythic", rollPercent: 95 },
    ],
  });
  assert.deepEqual(buckets.map((b) => b.statPercent), [40, 40, 40]);
  for (const bucket of buckets.slice(1)) {
    assert.deepEqual(bucket.affix, { affixId: "chaos_armor", tier: "rare", rollPercent: 40 });
  }
});

test("the affix index floors at two, so surplus affixes collide there", () => {
  // `if (index < 2) { index = 2; }` — an omen with more affixes than its requirement has room
  // for stacks them all on bucket 2 rather than going to 1 or 0.
  const buckets = omenBuckets(standardSnapshot(), {
    ...legalOmen(),
    requires: { NORMAL: 2 },
    affixes: [
      { affixId: "armor_suffix", tier: "common", rollPercent: 5 },
      { affixId: "armor_prefix", tier: "common", rollPercent: 5 },
      { affixId: "solo_prefix", tier: "common", rollPercent: 5 },
    ],
  });
  assert.deepEqual(
    buckets.map((b) => b.pieces),
    [2, 1, 2, 2],
  );
});

test("min_lvl gates the character, max_lvl caps the rank, and they are not one range", () => {
  // `guard` is min_lvl 15 / max_lvl 12 — read as a range that is "levels 15-12", which no
  // skill can satisfy. `Spell.getRequiredLevel()` returns min_lvl and `getMaxLevel()` returns
  // max_lvl; only the second has anything to do with the rank.
  const snapshot = standardSnapshot();

  const legal = build({ character: { level: 30 }, skills: [{ spellId: "guard", level: 5 }] });
  assert.deepEqual(codes(validateBuild(legal, snapshot)), []);

  // Rank 0 is not a rank a slotted spell can be at.
  const zero = build({ character: { level: 30 }, skills: [{ spellId: "guard", level: 0 }] });
  assert.ok(codes(validateBuild(zero, snapshot)).includes("spell-level-out-of-range"));

  // The character-level gate is real, and was checked by nothing before.
  const tooYoung = build({ character: { level: 10 }, skills: [{ spellId: "guard", level: 5 }] });
  assert.ok(codes(validateBuild(tooYoung, snapshot)).includes("spell-below-required-level"));
});

test("a spell may exceed max_lvl by the balance file's bonus ranks", () => {
  // `spell.bonus_ranks` is clamped to MAX_BONUS_SPELL_LEVELS (8 here) and then added to the
  // rank, so a unique granting "+2 to buff levels" legitimately puts a 20-rank spell at 22.
  const snapshot = standardSnapshot();

  const boosted = build({ character: { level: 30 }, skills: [{ spellId: "arrow", level: 22 }] });
  assert.deepEqual(codes(validateBuild(boosted, snapshot)), []);

  // 20 + 8 is the ceiling; 29 is past it.
  const atCeiling = build({ character: { level: 30 }, skills: [{ spellId: "arrow", level: 28 }] });
  assert.deepEqual(codes(validateBuild(atCeiling, snapshot)), []);
  const past = build({ character: { level: 30 }, skills: [{ spellId: "arrow", level: 29 }] });
  assert.ok(codes(validateBuild(past, snapshot)).includes("spell-level-out-of-range"));
});

test("an implicit has no tier and rolls the full 0-100 on any rarity", () => {
  // `ImplicitStatsData` saves only `p` and `imp`, and is the one gear part that does not
  // override `IGearPartTooltip.getMinMax`'s default `new MinMax(0, 100)`. Holding it to the
  // item's rarity band rejects ordinary items.
  const snapshot = standardSnapshot();

  // 96% is far outside rare's own band, which is the point: the implicit does not use it.
  const item: Item = { ...legalBoots(), implicits: [{ affixId: "boots_implicit", rollPercent: 96 }] };
  assert.deepEqual(codes(validateBuild(build({ gear: [item] }), snapshot)), []);

  // Out of 0..100 is still wrong.
  const over: Item = { ...item, implicits: [{ affixId: "boots_implicit", rollPercent: 101 }] };
  assert.ok(codes(validateBuild(build({ gear: [over] }), snapshot)).includes("roll-outside-tier-band"));

  // A tier on an implicit is exporter noise, not an error: it changes no number.
  const tiered: Item = {
    ...item,
    implicits: [{ affixId: "boots_implicit", tier: "common", rollPercent: 96 }],
  };
  const d = validateBuild(build({ gear: [tiered] }), snapshot);
  assert.deepEqual(codes(d, "error"), []);
  assert.ok(codes(d, "warning").includes("implicit-has-tier"));
});

test("a tiered affix still needs its tier", () => {
  const item: Item = {
    ...legalBoots(),
    prefixes: [
      { affixId: "armor_prefix", rollPercent: 10 },
      { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
    ],
  };
  assert.ok(codes(validateBuild(build({ gear: [item] }), standardSnapshot())).includes("missing-affix-tier"));
});

/** A support gem and an Augment, plus the rarity ladder their rolls are drawn from. */
function gemSnapshot() {
  return makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_game_balance: { original_balance: BALANCE },
    mmorpg_spells: { fury: { id: "fury", min_lvl: 1, max_lvl: 4, default_lvl: 0 } },
    mmorpg_support_gem: {
      crit_support: { id: "crit_support", stats: [] },
      gmp: { id: "gmp", stats: [], one_of_a_kind: "proj_count" },
      lmp: { id: "lmp", stats: [], one_of_a_kind: "proj_count" },
    },
    mmorpg_aura: { armor_aura: { id: "armor_aura", stats: [] } },
  });
}

test("a gem's roll must sit inside its rarity's band, and the two directions differ", () => {
  // `data.perc = rar.stat_percents.random()` and `UpgradeSkillGemRarityItemMod` rescales it into
  // the new band on an upgrade, so the six bands do not overlap.
  const legal = build({
    skills: [{ spellId: "fury", supports: [{ id: "crit_support", rarity: "mythic", rollPercent: 95 }] }],
    auras: [{ id: "armor_aura", rarity: "rare", rollPercent: 40 }],
  });
  assert.deepEqual(codes(validateBuild(legal, gemSnapshot()), "error"), []);

  // *Below* the band is what a typo looks like and nothing in the game writes one: an error.
  const under = build({ auras: [{ id: "armor_aura", rarity: "mythic", rollPercent: 12 }] });
  assert.deepEqual(codes(validateBuild(under, gemSnapshot()), "error"), ["gem-roll-outside-rarity-band"]);

  // *Above* it is the stale-item case and the pack has real ones — `SkillGemData.perc` is a bare
  // int with no clamp anywhere in the class, so a gem rolled before a band changed keeps its
  // number and the game keeps using it. A warning, because a capture of one is a measurement.
  const over = build({
    skills: [{ spellId: "fury", supports: [{ id: "crit_support", rarity: "common", rollPercent: 95 }] }],
  });
  assert.deepEqual(codes(validateBuild(over, gemSnapshot()), "error"), []);
  assert.ok(codes(validateBuild(over, gemSnapshot()), "warning").includes("gem-roll-outside-rarity-band"));
});

test("one Skill may not hold the same support gem, or two of one one_of_a_kind group", () => {
  // Not a redundancy but a wipe: `SocketedGem.checkIfCanUseGems` force-unequips *every* support
  // gem on the Skill when it finds either, so the document would describe a Skill the game
  // strips bare. Both gmp and lmp are `proj_count`.
  const twice = build({
    skills: [{ spellId: "fury", supports: [{ id: "crit_support" }, { id: "crit_support" }] }],
  });
  assert.deepEqual(codes(validateBuild(twice, gemSnapshot()), "error"), ["duplicate-support-gem"]);

  const group = build({ skills: [{ spellId: "fury", supports: [{ id: "gmp" }, { id: "lmp" }] }] });
  assert.deepEqual(codes(validateBuild(group, gemSnapshot()), "error"), ["support-gem-one-of-a-kind"]);

  // Per Skill, not per build: `SocketedGem` is the thing that holds the links, and a second
  // Skill has its own.
  const shared = build({
    skills: [
      { spellId: "fury", supports: [{ id: "gmp" }] },
      { spellId: "fury", supports: [{ id: "gmp" }] },
    ],
  });
  assert.deepEqual(codes(validateBuild(shared, gemSnapshot()), "error"), []);

  // A gem with no group is unconstrained beyond the duplicate rule.
  const mixed = build({ skills: [{ spellId: "fury", supports: [{ id: "gmp" }, { id: "crit_support" }] }] });
  assert.deepEqual(codes(validateBuild(mixed, gemSnapshot()), "error"), []);
});

test("a gem rarity must exist and must not be a unique-item rarity", () => {
  const unknown = build({ auras: [{ id: "armor_aura", rarity: "nonexistent", rollPercent: 40 }] });
  assert.ok(codes(validateBuild(unknown, gemSnapshot()), "error").includes("unknown-gem-rarity"));

  // `randomizeTier` excludes unique rarities, and nothing rolls a gem at one either.
  const unique = build({ auras: [{ id: "armor_aura", rarity: "unique", rollPercent: 40 }] });
  assert.ok(codes(validateBuild(unique, gemSnapshot()), "error").includes("unique-rarity-as-gem-rarity"));
});

test("a gem with no rarity: negative is an error, above the bands is a warning", () => {
  const legal = build({ auras: [{ id: "armor_aura", rollPercent: 40 }] });
  assert.deepEqual(codes(validateBuild(legal, gemSnapshot()), "error"), []);

  // Not a percent at all.
  const negative = build({ auras: [{ id: "armor_aura", rollPercent: -1 }] });
  assert.ok(codes(validateBuild(negative, gemSnapshot()), "error").includes("gem-percent-out-of-range"));

  // The `protection` case from the 2026-09-15 capture: the exporter read it off the live gem.
  const stale = build({ auras: [{ id: "armor_aura", rollPercent: 108 }] });
  assert.deepEqual(codes(validateBuild(stale, gemSnapshot()), "error"), []);
  assert.ok(codes(validateBuild(stale, gemSnapshot()), "warning").includes("gem-percent-above-band"));
});

// ---------------------------------------------------------------------------
// The item pool
// ---------------------------------------------------------------------------

test("a benched item is checked as an item, and reported under its own path", () => {
  // An impossible roll is impossible whether or not you are wearing it, and a pool full of
  // items the game cannot make is a pool of comparisons worth nothing.
  const bad = legalBoots();
  bad.prefixes = [
    { affixId: "armor_prefix", tier: "rare", rollPercent: 40 },
    { affixId: "leather_boots_prefix", tier: "common", rollPercent: 10 },
    { affixId: "solo_prefix", tier: "common", rollPercent: 10 },
  ];
  const diagnostics = validateBuild(build({ itemPool: [bad] }), standardSnapshot());

  assert.ok(codes(diagnostics).includes("too-many-prefixes"));
  // Under `itemPool[0]`, not `gear[0]`: the editor filters diagnostics by path to decide which
  // ones belong to the item on screen, and two lists sharing a path would cross the streams.
  assert.ok(diagnostics.every((d) => !d.path.startsWith("gear[")));
  assert.ok(diagnostics.some((d) => d.path.startsWith("itemPool[0]")));
});

test("the pool is not a loadout, so slot capacity ignores it", () => {
  // Nine pairs of boots on the bench is what a bench is for. The same nine equipped is an
  // error, and the two must not be the same check.
  const nine = Array.from({ length: 9 }, () => legalBoots());

  const benched = validateBuild(build({ itemPool: nine }), standardSnapshot());
  assert.deepEqual(benched, []);
  assert.equal(isLegal(benched), true);

  const worn = validateBuild(build({ gear: nine }), standardSnapshot());
  assert.ok(codes(worn, "error").length > 0);
});

test("a benched item contributes nothing, so it cannot complete anything either", () => {
  // The engine reads `gear` and never `itemPool`; this pins the validator agreeing with it, so
  // a jewel socket granted by a unique on the bench does not unlock a jewel.
  const worn = validateBuild(build({ gear: [legalBoots()] }), standardSnapshot());
  const benched = validateBuild(build({ itemPool: [legalBoots()] }), standardSnapshot());
  assert.deepEqual(worn, []);
  assert.deepEqual(benched, []);
});

test("a jewel's style narrows its affix pool, so an off-style affix is not a real item", () => {
  const withAffix = (affixId: string, style?: string) =>
    build({
      jewels: [
        {
          rarity: "rare",
          itemLevel: 30,
          ...(style === undefined ? {} : { style }),
          affixes: [{ affixId, tier: "rare", rollPercent: 40 }],
        },
      ],
    });

  // `generateAffixes` rolls from `any_jewel` plus the style's own tag and nothing else, so
  // `jewel_int_only` on a Meteorite (str) jewel is something the game cannot drop.
  const offStyle = validateBuild(withAffix("jewel_int_only", "str"), standardSnapshot());
  assert.ok(codes(offStyle, "error").includes("affix-not-allowed-on-jewel"));

  // The same affix on a Stardust jewel is legal.
  const onStyle = validateBuild(withAffix("jewel_int_only", "int"), standardSnapshot());
  assert.ok(!codes(onStyle).includes("affix-not-allowed-on-jewel"));

  // `any_jewel` rolls on every style, including the default one a document may omit.
  const anyStyle = validateBuild(withAffix("any_jewel_affix"), standardSnapshot());
  assert.ok(!codes(anyStyle).includes("affix-not-allowed-on-jewel"));

  // A document that never stated a style is not claiming `str`, it is a capture taken before
  // the exporter recorded one. The assumption is reported, but it is not called impossible.
  const assumed = validateBuild(withAffix("jewel_int_only"), standardSnapshot());
  assert.ok(codes(assumed, "warning").includes("affix-not-allowed-on-jewel"));
  assert.ok(!codes(assumed, "error").includes("affix-not-allowed-on-jewel"));
});

test("an unknown play style is reported rather than quietly treated as str", () => {
  // `PlayStyle.fromID` falls back to STR, which would make this a jewel with the wrong name
  // and the wrong pool — exactly the silent default this validator exists to refuse.
  const diagnostics = validateBuild(
    build({ jewels: [{ rarity: "rare", itemLevel: 30, style: "wis" }] }),
    standardSnapshot(),
  );
  assert.ok(codes(diagnostics).includes("unknown-jewel-style"));
});
