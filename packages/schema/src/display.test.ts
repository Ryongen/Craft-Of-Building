import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHEET_GROUPS,
  UNCATEGORISED,
  compareForSheet,
  fillTemplate,
  humanise,
  isTemplate,
  modifierLine,
  modifierValue,
  parseFormatting,
  perkName,
  spellName,
  statDisplay,
  statName,
  stripFormatting,
  sheetGroupName,
  sheetGroupOf,
  sheetGroupRank,
  stripGlossaryMarkup,
  uniqueName,
} from "./display.js";
import { makeSnapshot, standardSnapshot } from "./test-support.js";

/** The real lang shapes: plain names, templated names, and the unique `.name` suffix. */
function langSnapshot(): ReturnType<typeof makeSnapshot> {
  const snapshot = makeSnapshot({
    mmorpg_stat: {
      accuracy: {
        id: "accuracy",
        group: "MAIN",
        gui_group: "NONE",
        order: 100,
        icon: "★",
        format: "aqua",
        is_perc: false,
        show_in_gui: true,
        minus_is_good: false,
      },
      armor: { id: "armor", group: "Misc", icon: "⚔", format: "red", is_perc: false },
      crit_chance: { id: "crit_chance", group: "WEAPON", format: "yellow", is_perc: true },
      // A derived-serializer stat: nests under `data`, declares none of the GUI fields.
      accuracy_per_10_dexterity: { id: "accuracy_per_10_dexterity", ser: "one_to_other" },
      // Referenced by nothing in lang — exercises the fallback.
      nameless_stat: { id: "nameless_stat", group: "Misc" },
    },
    mmorpg_perk: {
      // Named: a MAJOR node.
      acrobat: { id: "acrobat", type: "MAJOR", stats: [] },
      // Unnamed STAT node — falls back to the stat it grants, not the humanised id.
      accuracy_percent: {
        id: "accuracy_percent",
        type: "STAT",
        stats: [{ type: "PERCENT", stat: "accuracy", v1: 4 }],
      },
      // Unnamed, and its stat is templated — the id reads better as a node label.
      odd_node: {
        id: "odd_node",
        type: "STAT",
        stats: [{ type: "FLAT", stat: "accuracy_per_10_dexterity", v1: 4 }],
      },
      // Unnamed with no stats at all.
      bare_node: { id: "bare_node", type: "STAT", stats: [] },
    },
    mmorpg_spells: {
      // Both present and disagreeing — the real `lightning_golem_basic` case.
      fireball: { identifier: "fireball", loc_name: "Fire Golem Attack" },
      // `loc_name` only: 101 of the 372 spells are in this state.
      loc_only_spell: { identifier: "loc_only_spell", loc_name: "Axe Throw" },
      nameless_spell: { identifier: "nameless_spell" },
    },
    mmorpg_unique_gears: { windrunner: { guid: "windrunner" } },
  });

  snapshot.lang = {
    "mmorpg.stat.accuracy": "Accuracy",
    "mmorpg.stat.armor": "§cArmor",
    "mmorpg.stat.crit_chance": "Crit Chance",
    "mmorpg.stat.accuracy_per_10_dexterity":
      "§a[VAL1] §b★ Accuracy§7 per 10 §b★ Dexterity§7",
    "mmorpg.stat_desc.accuracy": "Increases your chance to hit an enemy.",
    "mmorpg.talent.acrobat": "Acrobat",
    "mmorpg.spell.fireball": "Lightning Golem Attack",
    "mmorpg.unique_gear.windrunner.name": "Windrunner",
  };
  return snapshot;
}

test("parseFormatting splits section codes into styled runs", () => {
  const spans = parseFormatting("§a12 §b★ Accuracy§7 per 10");
  assert.deepEqual(spans, [
    { text: "12 ", colour: "#55FF55" },
    { text: "★ Accuracy", colour: "#55FFFF" },
    { text: " per 10", colour: "#AAAAAA" },
  ]);
});

test("parseFormatting: a colour code resets styling, a style code accumulates", () => {
  const spans = parseFormatting("§lbold §cred§nunder§rplain");
  assert.deepEqual(spans, [
    { text: "bold ", bold: true },
    // The colour code cleared `bold` rather than merging with it.
    { text: "red", colour: "#FF5555" },
    { text: "under", colour: "#FF5555", underline: true },
    { text: "plain" },
  ]);
});

test("stripFormatting removes codes and keeps the text", () => {
  assert.equal(stripFormatting("§a12 §b★ Accuracy§7 per 10 §b★ Dexterity§7"), "12 ★ Accuracy per 10 ★ Dexterity");
  assert.equal(stripFormatting("no codes here"), "no codes here");
  // A trailing lone section sign is text, not a truncated code.
  assert.equal(stripFormatting("trailing §"), "trailing §");
});

test("fillTemplate replaces 1-based placeholders and leaves unsupplied ones visible", () => {
  assert.equal(fillTemplate("[VAL1] per 10 Dex", [12]), "12 per 10 Dex");
  assert.equal(fillTemplate("[VAL1] then [VAL2]", [1, 2]), "1 then 2");
  // Under-supplied: the placeholder stays so the gap is visible rather than silently blank.
  assert.equal(fillTemplate("[VAL1] then [VAL2]", [1]), "1 then [VAL2]");
  assert.equal(fillTemplate("[VAL1]", [12.505]), "12.51");
});

test("isTemplate detects the placeholder form", () => {
  assert.equal(isTemplate("§a[VAL1] Accuracy"), true);
  assert.equal(isTemplate("Accuracy"), false);
});

test("humanise turns an id into a legible stand-in", () => {
  assert.equal(humanise("crit_damage"), "Crit Damage");
  assert.equal(humanise("mmorpg:textures/gui"), "Mmorpg Textures Gui");
});

test("statName falls back to the humanised id, never a blank", () => {
  const snapshot = langSnapshot();
  assert.equal(statName(snapshot, "accuracy"), "Accuracy");
  // Formatting is stripped.
  assert.equal(statName(snapshot, "armor"), "Armor");
  assert.equal(statName(snapshot, "nameless_stat"), "Nameless Stat");
});

test("perkName: lang, then the granted stat's name, then the id", () => {
  const snapshot = langSnapshot();
  assert.equal(perkName(snapshot, "acrobat"), "Acrobat");
  // 700 of 1,064 perks have no lang key; the game renders them from their stat lines.
  assert.equal(perkName(snapshot, "accuracy_percent"), "Accuracy");
  // A templated stat name is a whole sentence, so the id is the better label.
  assert.equal(perkName(snapshot, "odd_node"), "Odd Node");
  assert.equal(perkName(snapshot, "bare_node"), "Bare Node");
});

test("spellName prefers lang over loc_name, because loc_name is the stale one", () => {
  const snapshot = langSnapshot();
  // Where the two disagree the registry is wrong: the real `lightning_golem_basic` declares
  // `loc_name: "Fire Golem Attack"`. `resources.zip` overrides lang, so lang is what shows.
  assert.equal(spellName(snapshot, "fireball"), "Lightning Golem Attack");
  // `loc_name` still covers the 101 spells with no lang key.
  assert.equal(spellName(snapshot, "loc_only_spell"), "Axe Throw");
  assert.equal(spellName(snapshot, "nameless_spell"), "Nameless Spell");
});

test("uniqueName reads the `.name` suffix uniques alone carry", () => {
  assert.equal(uniqueName(langSnapshot(), "windrunner"), "Windrunner");
});

test("statDisplay reads the GUI fields off the stat, with Stat's defaults", () => {
  const snapshot = langSnapshot();

  const accuracy = statDisplay(snapshot, "accuracy");
  assert.equal(accuracy.group, "MAIN");
  assert.equal(accuracy.icon, "★");
  assert.equal(accuracy.colour, "#55FFFF");
  assert.equal(accuracy.showInGui, true);
  assert.equal(accuracy.templated, false);

  // A derived-serializer stat declares none of them and takes the defaults.
  const derived = statDisplay(snapshot, "accuracy_per_10_dexterity");
  assert.equal(derived.group, "Misc");
  assert.equal(derived.icon, "★");
  assert.equal(derived.colour, "#55FFFF");
  assert.equal(derived.templated, true);

  assert.equal(statDisplay(snapshot, "armor").colour, "#FF5555");
  assert.equal(statDisplay(snapshot, "crit_chance").isPerc, true);
});

test("modifierValue interpolates a range and clamps the roll", () => {
  assert.equal(modifierValue({ min: 4, max: 8 }, 50), 6);
  assert.equal(modifierValue({ min: 4, max: 8 }, 0), 4);
  assert.equal(modifierValue({ min: 4, max: 8 }, 100), 8);
  assert.equal(modifierValue({ min: 4, max: 8 }, 300), 8);
  assert.equal(modifierValue({ v1: 12 }), 12);
});

test("modifierLine renders each modifier type the way the game words it", () => {
  const snapshot = langSnapshot();
  assert.equal(modifierLine(snapshot, { type: "FLAT", stat: "accuracy", min: 4, max: 8 }, 50), "+6 Accuracy");
  assert.equal(modifierLine(snapshot, { type: "PERCENT", stat: "accuracy", v1: 12 }), "+12% Increased Accuracy");
  assert.equal(modifierLine(snapshot, { type: "MORE", stat: "accuracy", v1: 12 }), "12% More Accuracy");
  // A negative MORE is "less" — `acrobat` really does trade away 20% of your armour.
  assert.equal(modifierLine(snapshot, { type: "MORE", stat: "accuracy", v1: -20 }), "20% Less Accuracy");
  assert.equal(modifierLine(snapshot, { type: "FLAT", stat: "accuracy", v1: -5 }), "-5 Accuracy");
  // `is_perc` puts the sign on a FLAT line.
  assert.equal(modifierLine(snapshot, { type: "FLAT", stat: "crit_chance", v1: 5 }), "+5% Crit Chance");
});

test("modifierLine: a templated stat name takes over the whole line", () => {
  const snapshot = langSnapshot();
  assert.equal(
    modifierLine(snapshot, { type: "FLAT", stat: "accuracy_per_10_dexterity", v1: 4 }),
    "4 ★ Accuracy per 10 ★ Dexterity",
  );
});

test("modifierLine survives a snapshot with no lang at all", () => {
  // `standardSnapshot` ships an empty `lang`, which is the state every unit test runs in.
  assert.equal(
    modifierLine(standardSnapshot(), { type: "FLAT", stat: "armor", min: 1, max: 10 }, 0),
    "+1 Armor",
  );
});

test("Enlighten glossary markup is reduced to its display text", () => {
  // Craft to Exile 2 writes `[Display Text](term_id)` into 1,673 lang values, stat names
  // included, for its tooltip mod to turn into hoverable terms. Anything else that draws the
  // string strips it first (`EnlightenMarkup.strip`), so rendering it raw shows brackets the
  // game never shows.
  assert.equal(stripGlossaryMarkup("[Gear's Defense](defences)"), "Gear's Defense");
  assert.equal(stripGlossaryMarkup("Elemental [Skill Damage](skill_damage)"), "Elemental Skill Damage");
  assert.equal(stripGlossaryMarkup("Lethargy ([Slow](slow))"), "Lethargy (Slow)");
  assert.equal(
    stripGlossaryMarkup("[Augment](augment) [Reservation](reservation): "),
    "Augment Reservation: ",
  );
});

test("stripping glossary markup leaves value placeholders alone", () => {
  // `[VAL1]` is never followed by `(...)`, which is exactly why the mod's pattern is safe.
  assert.equal(stripGlossaryMarkup("§a[VAL1]§7 Accuracy"), "§a[VAL1]§7 Accuracy");
  assert.equal(
    stripGlossaryMarkup("[VAL1]% increased [Skill Damage](skill_damage)"),
    "[VAL1]% increased Skill Damage",
  );
});

test("a lang value with no markup is returned untouched", () => {
  assert.equal(stripGlossaryMarkup("Magic Find"), "Magic Find");
});

test("statName strips glossary markup from the lang value", () => {
  const snapshot = makeSnapshot({ mmorpg_stat: { gear_defense: { id: "gear_defense" } } });
  snapshot.lang = { "mmorpg.stat.gear_defense": "[Gear's Defense](defences)" };
  assert.equal(statName(snapshot, "gear_defense"), "Gear's Defense");
});

/**
 * The sheet taxonomy.
 *
 * What these pin is not "armor is a defence" — that is a judgement, and it is allowed to change.
 * It is the two rules that decide what the taxonomy *means*, both of which are easy to break by
 * editing a list and neither of which shows up on screen until a sheet looks wrong.
 */

/** A snapshot is only needed for the pack-group fallback, so an empty one exercises the rest. */
function taxonomySnapshot(): ReturnType<typeof makeSnapshot> {
  return makeSnapshot({
    mmorpg_stat: {
      summon_damage: { id: "summon_damage", group: "Misc" },
      all_fire_damage: { id: "all_fire_damage", group: "ELEMENTAL" },
      fire_resist: { id: "fire_resist", group: "Misc" },
      max_fire_resist: { id: "max_fire_resist", group: "Misc" },
      // Declares nothing at all, like 191 of the pack's stats.
      some_future_stat: { id: "some_future_stat" },
      // Declares only the pack's catch-all, like another 536.
      another_future_stat: { id: "another_future_stat", group: "Misc" },
      // Reachable only through the pack-group fallback.
      axe_damage: { id: "axe_damage", group: "WEAPON" },
      health_on_hit_hit: { id: "health_on_hit_hit", group: "RESTORATION" },
    },
  });
}

test("an explicit member beats a pattern in any group, not just a later one", () => {
  const snapshot = taxonomySnapshot();
  // `summon_damage` ends in `_damage`, which Offence claims as a family, and Offence sorts well
  // before Minions. Without explicit-first the group list's own order would silently decide the
  // taxonomy and this stat would read as a damage stat.
  assert.equal(sheetGroupOf(snapshot, "summon_damage"), "minions");
  assert.equal(sheetGroupOf(snapshot, "all_fire_damage"), "offence");
});

test("a family is caught by pattern, so a new element needs no edit here", () => {
  const snapshot = taxonomySnapshot();
  // Neither is in any explicit list; both are resists.
  assert.equal(sheetGroupOf(snapshot, "shadow_resist"), "resistances");
  assert.equal(sheetGroupOf(snapshot, "max_shadow_resist"), "resistances");
  assert.equal(sheetGroupOf(snapshot, "learn_some_new_spell"), "skills");
  assert.equal(sheetGroupOf(snapshot, "proc_something_on_hit"), "triggers");
});

test("a stat nothing places lands in Uncategorised rather than in a plausible section", () => {
  const snapshot = taxonomySnapshot();
  // This is the state the audit's check 7 exists to catch. Guessing a section for it would be
  // worse than admitting there isn't one: a wrong section is invisible, a bottom-of-sheet pile
  // is not.
  assert.equal(sheetGroupOf(snapshot, "some_future_stat"), UNCATEGORISED);
  assert.equal(sheetGroupOf(snapshot, "another_future_stat"), UNCATEGORISED);
});

test("the pack's own group is the last resort, and Misc is deliberately not mapped", () => {
  const snapshot = taxonomySnapshot();
  // WEAPON and RESTORATION say something, so they resolve.
  assert.equal(sheetGroupOf(snapshot, "axe_damage"), "offence");
  assert.equal(sheetGroupOf(snapshot, "health_on_hit_hit"), "life");
  // Misc says nothing. Mapping it would place 536 stats in a named group and make check 7
  // incapable of ever finding anything.
  assert.equal(sheetGroupOf(snapshot, "another_future_stat"), UNCATEGORISED);
});

test("Uncategorised sorts last, whatever its name would do alphabetically", () => {
  assert.equal(sheetGroupRank(UNCATEGORISED), SHEET_GROUPS.length);
  assert.ok(sheetGroupRank("offence") < sheetGroupRank("utility"));
  assert.ok(sheetGroupRank("utility") < sheetGroupRank(UNCATEGORISED));
});

test("within a section the authored order holds, and A-Z only breaks ties", () => {
  const snapshot = taxonomySnapshot();
  const display = (id: string) => statDisplay(snapshot, id);
  // The old rule was group-then-name, which was name alone: every stat that declares `order`
  // declares 100. So health used to sort after health_regen, and a resist after its own cap.
  assert.ok(compareForSheet(snapshot, display("fire_resist"), display("max_fire_resist")) < 0);
  // A pattern-caught member sorts after every explicit one, so tomorrow's stat appends rather
  // than shuffling what is already there.
  assert.ok(compareForSheet(snapshot, display("fire_resist"), display("shadow_resist")) < 0);
});

test("every section has a heading, and an unknown id still renders something", () => {
  for (const group of SHEET_GROUPS) {
    assert.ok(sheetGroupName(group.id).length > 0, `${group.id} has no name`);
  }
  assert.equal(sheetGroupName(UNCATEGORISED), "Uncategorised");
});

test("no stat is claimed explicitly by two sections", () => {
  // A duplicate is resolved silently by whichever group comes first, which makes the taxonomy
  // depend on list order in exactly the way explicit-first is meant to prevent.
  const seen = new Map<string, string>();
  for (const group of SHEET_GROUPS) {
    for (const id of group.stats) {
      const existing = seen.get(id);
      assert.equal(existing, undefined, `${id} is in both ${existing} and ${group.id}`);
      seen.set(id, group.id);
    }
  }
});
