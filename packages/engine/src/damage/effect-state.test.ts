/**
 * Which effects a build can have up.
 *
 * The three questions this file answers are availability (can anything you own apply it), the
 * cap (`max_stacks` plus the `max_<id>_charges` stat), and exclusivity (`one_of_a_kind_id`).
 * Each is quoted from the jar in `effect-state.ts`; these pin the behaviour that falls out.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseStats, closeTo, condition, engineSnapshot, exact, spellEntry, statEntry } from "../test-support.js";
import { resolveEffectState } from "./effect-state.js";

/** An exile effect as the pack ships them, with only the fields this file reads. */
function effectEntry(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "beneficial",
    max_stacks: 1,
    mc_stats: [],
    one_of_a_kind_id: "",
    spell_tags: { tags: [] },
    stacks_affect_stats: true,
    stats: [{ type: "FLAT", min: 5, max: 5, stat: "armor" }],
    tags: { tags: [] },
    ...extra,
  };
}

/** A spell whose `on_cast` applies each of `effectIds` to whoever `selector` picks. */
function granting(id: string, ...effectIds: string[]): Record<string, unknown> {
  return grantingTo({ type: "self", map: {} }, id, ...effectIds);
}

function grantingTo(
  selector: Record<string, unknown>,
  id: string,
  ...effectIds: string[]
): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100");
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      // More than one act because a spell really can grant either of two effects from one cast —
      // `blasphemous_ritual` picks a ritual at cast time — and that is the case where nothing
      // about the bar says which one you ended up with.
      acts: effectIds.map((exile_potion_id) => ({
        type: "exile_effect",
        map: { exile_potion_id, potion_action: "GIVE_STACKS", count: 1, potion_dur: 200 },
      })),
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [selector],
      en_preds: [],
    },
  ];
  return spell;
}

function stateOf(
  registries: Record<string, Record<string, Record<string, unknown>>>,
  doc: Partial<BuildDoc> = {},
) {
  const snapshot = engineSnapshot(registries);
  const build: BuildDoc = {
    schemaVersion: 1,
    character: { level: 1 },
    ...doc,
  } as BuildDoc;
  const sheet = calculate(build, snapshot).stats;
  return resolveEffectState({ snapshot, build, sheet });
}

test("an effect nothing in the build applies is not offered", () => {
  const state = stateOf({
    mmorpg_exile_effect: { fortify: effectEntry("fortify") },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
  }, { skills: [{ spellId: "strike", main: true }] });

  assert.deepEqual(state.options.map((o) => o.id), []);
  assert.equal(state.active.size, 0);
});

test("a skill that applies an effect makes it available, and it defaults up", () => {
  const state = stateOf({
    mmorpg_exile_effect: { fury: effectEntry("fury") },
    mmorpg_spells: { war_cry: granting("war_cry", "fury") },
  }, { skills: [{ spellId: "war_cry", main: true }] });

  assert.deepEqual(state.options.map((o) => o.id), ["fury"]);
  assert.equal(state.options[0]!.side, "caster");
  assert.equal(state.options[0]!.chosen, false, "defaulted, not chosen");
  assert.equal(state.active.get("fury"), 1);
});

test("a disabled skill grants nothing", () => {
  // The whole point of the toggle: comparing two setups means one of them contributes nothing,
  // including the branch-opening effects it would have made available.
  const state = stateOf({
    mmorpg_exile_effect: { fury: effectEntry("fury") },
    mmorpg_spells: { war_cry: granting("war_cry", "fury") },
  }, { skills: [{ spellId: "war_cry", main: true, enabled: false }] });

  assert.deepEqual(state.options.map((o) => o.id), []);
});

test("an effect a skill applies to an enemy is a debuff, and sits on the target", () => {
  // Who holds it is the selector, not `ExileEffect.type`: `shred` is applied by an `in_front`
  // and lands on the mob, which is why its armour penalty belongs on the enemy's sheet.
  const state = stateOf({
    mmorpg_exile_effect: {
      shred: effectEntry("shred", { type: "negative", max_stacks: 10 }),
    },
    mmorpg_spells: {
      puncture: grantingTo({ type: "in_front", map: { distance: 3, width: 2 } }, "puncture", "shred"),
    },
  }, { skills: [{ spellId: "puncture", main: true }] });

  const shred = state.options[0]!;
  assert.equal(shred.side, "target");
  assert.equal(shred.kind, "negative");
  assert.equal(shred.stacks, 10, "an available effect sits at its cap");
});

test("an area that searches for allies is still the caster's own buff", () => {
  // `protection` buffs `aoe:allies`, and you are one of your own — reading only the selector
  // type would have put a self-buff on the mob.
  const state = stateOf({
    mmorpg_exile_effect: { protection: effectEntry("protection") },
    mmorpg_spells: {
      protection: grantingTo(
        { type: "aoe", map: { radius: 4, selection_type: "RADIUS", en_predicate: "allies" } },
        "protection",
        "protection",
      ),
    },
  }, { skills: [{ spellId: "protection", main: true }] });

  assert.equal(state.options[0]!.side, "caster");
});

test("a curse with no stats is still offered, because is_target_cursed reads it by tag", () => {
  // `curse_of_damnation` applies `damnation`, which carries no stats, beside `impending_doom`,
  // which is not a curse. Dropping the statless one left every `damage_to_cursed` unread.
  const noStats = { type: "negative", stats: [] };
  const state = stateOf({
    mmorpg_exile_effect: {
      damnation: effectEntry("damnation", { ...noStats, tags: { tags: ["negative", "curse"] } }),
      smoulder: effectEntry("smoulder", noStats),
    },
    mmorpg_spells: {
      hex: grantingTo({ type: "aoe", map: { radius: 4, en_predicate: "enemies" } }, "hex", "damnation", "smoulder"),
    },
    mmorpg_stat_condition: { is_target_cursed: condition("is_target_cursed", "is_target_cursed") },
  }, { skills: [{ spellId: "hex", main: true }] });

  assert.deepEqual(state.options.map((o) => o.id), ["damnation"]);
  assert.equal(state.options[0]!.side, "target");
});

test("the cap is max_stacks plus the max_<id>_charges stat", () => {
  // `ExileEffect.getMaxCharges` is `max_stacks + maxCharges.bonus.getOrDefault(GUID(), 0)`, and
  // that bonus map is filled by sweeping the container for `MaximumChargesStat`.
  const registries = {
    mmorpg_exile_effect: { endurance_charge: effectEntry("endurance_charge", { max_stacks: 3 }) },
    mmorpg_spells: { brace: granting("brace", "endurance_charge") },
    mmorpg_stat: { max_endurance_charge_charges: statEntry("max_endurance_charge_charges") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("max_endurance_charge_charges", "FLAT", 2),
      ]),
    },
  };
  const state = stateOf(registries, { skills: [{ spellId: "brace", main: true }] });

  const charge = state.options[0]!;
  assert.equal(charge.declaredMaxStacks, 3);
  assert.equal(charge.maxStacks, 5);
  assert.equal(charge.stacks, 5, "an active effect is assumed at the cap the build actually has");
});

test("a charge follows the cap, not the count a capture photographed", () => {
  // The Guardian bug. `max_endurance_charge_charges` is the only kind of cap an edit can move —
  // `MaximumChargesStat` is declared for `charm` and for the three `charge`-tagged effects, and
  // for nothing else — so a captured count is the one thing standing between the new cap and the
  // figure. Allocating two `+1 max endurance charge` nodes left the build at the three the
  // capture had recorded under the old ascendancy, and `dmg_per_endurance_charge` with it.
  const registries = {
    mmorpg_exile_effect: {
      endurance_charge: effectEntry("endurance_charge", { max_stacks: 3, tags: { tags: ["charge"] } }),
    },
    mmorpg_spells: { brace: granting("brace", "endurance_charge") },
    mmorpg_stat: { max_endurance_charge_charges: statEntry("max_endurance_charge_charges") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("max_endurance_charge_charges", "FLAT", 2),
      ]),
    },
  };
  const doc = {
    skills: [{ spellId: "brace", main: true }],
    // What the exporter wrote when the character's cap was still three.
    exileEffects: [{ id: "endurance_charge", stacks: 3 }],
  };

  const charge = stateOf(registries, doc).options[0]!;
  assert.equal(charge.maxStacks, 5);
  assert.equal(charge.capturedStacks, 3, "the capture is still recorded");
  assert.equal(charge.stacks, 5, "and a charge sits at the cap the build now has");

  // Typing a number still wins over both: the toggle is how you say "I run at four".
  const pinned = stateOf(registries, { ...doc, config: { effects: { endurance_charge: 4 } } });
  assert.equal(pinned.options[0]!.stacks, 4);
});

test("a non-charge buff keeps the count its capture recorded", () => {
  // The other half of the rule, and why it is not "captures never win". A stacking buff caught
  // at two of five was genuinely at two; only a charge is a resource you sit at the cap of.
  const registries = {
    mmorpg_exile_effect: { rage: effectEntry("rage", { max_stacks: 5 }) },
    mmorpg_spells: { roar: granting("roar", "rage") },
  };
  const state = stateOf(registries, {
    skills: [{ spellId: "roar", main: true }],
    exileEffects: [{ id: "rage", stacks: 2 }],
  });
  assert.equal(state.options[0]!.stacks, 2);
});

test("a pinned stack count is honoured, and clamped to the cap", () => {
  const registries = {
    mmorpg_exile_effect: { overheat: effectEntry("overheat", { max_stacks: 4 }) },
    mmorpg_spells: { magma: granting("magma", "overheat") },
  };
  const skills = [{ spellId: "magma", main: true }];

  assert.equal(stateOf(registries, { skills, config: { effects: { overheat: 2 } } }).active.get("overheat"), 2);
  assert.equal(stateOf(registries, { skills, config: { effects: { overheat: 9 } } }).active.get("overheat"), 4);
  assert.equal(stateOf(registries, { skills, config: { effects: { overheat: false } } }).active.get("overheat"), undefined);
});

test("only one member of a one_of_a_kind group is up at a time", () => {
  // The thirteen auras share `one_of_a_kind_id: "aura"`, the two stances share `"stance"`. One
  // spell grants both stances — casting `fighter_stance` swaps you if you already had it — so
  // availability alone cannot decide, and the spell you put on your bar does.
  const registries = {
    mmorpg_exile_effect: {
      fighter_stance: effectEntry("fighter_stance", { one_of_a_kind_id: "stance" }),
      defender_stance: effectEntry("defender_stance", { one_of_a_kind_id: "stance" }),
    },
    mmorpg_spells: {
      fighter_stance: granting("fighter_stance", "fighter_stance"),
      defender_stance: granting("defender_stance", "defender_stance"),
    },
  };

  const both = stateOf(registries, {
    skills: [
      { spellId: "fighter_stance", main: true },
      { spellId: "defender_stance" },
    ],
  });
  assert.equal(both.active.size, 1, "two stances cannot both be up");
  assert.equal(both.chosenOfGroup.get("stance"), "defender_stance", "ties go to the first by id");

  const chosen = stateOf(registries, {
    skills: [
      { spellId: "fighter_stance", main: true },
      { spellId: "defender_stance" },
    ],
    config: { effects: { fighter_stance: true } },
  });
  assert.equal(chosen.chosenOfGroup.get("stance"), "fighter_stance");
  assert.equal(chosen.options.find((o) => o.id === "defender_stance")!.excludedBy, "fighter_stance");
});

test("a captured member of a one_of_a_kind group beats the first by id", () => {
  // `blasphemous_ritual` grants either `ritual_of_blood` or `ritual_of_abyss`, both in the group
  // `ritual`. Neither is named after the spell, so the bar cannot say which, and the tie used to
  // fall through to the first id — handing a bleed character the chaos ritual. A capture saw
  // which one was actually up, and an observation outranks alphabetical order.
  const registries = {
    mmorpg_exile_effect: {
      ritual_of_abyss: effectEntry("ritual_of_abyss", { one_of_a_kind_id: "ritual" }),
      ritual_of_blood: effectEntry("ritual_of_blood", { one_of_a_kind_id: "ritual" }),
    },
    mmorpg_spells: { blasphemous_ritual: granting("blasphemous_ritual", "ritual_of_abyss", "ritual_of_blood") },
  };
  const skills = [{ spellId: "blasphemous_ritual", main: true }];

  const blind = stateOf(registries, { skills });
  assert.equal(blind.chosenOfGroup.get("ritual"), "ritual_of_abyss", "with nothing to go on, the first by id");

  // Still open-world — every effect is assumed up — so this is the planner reading, not the
  // fixture runner's closed one. The capture only breaks the tie.
  const seen = stateOf(registries, { skills, exileEffects: [{ id: "ritual_of_blood", stacks: 1 }] });
  assert.equal(seen.chosenOfGroup.get("ritual"), "ritual_of_blood");
  assert.equal(seen.options.find((o) => o.id === "ritual_of_abyss")!.excludedBy, "ritual_of_blood");

  // An explicit choice still wins over the capture: the point of the planner is to ask "what if".
  const overridden = stateOf(registries, {
    skills,
    exileEffects: [{ id: "ritual_of_blood", stacks: 1 }],
    config: { effects: { ritual_of_abyss: true } },
  });
  assert.equal(overridden.chosenOfGroup.get("ritual"), "ritual_of_abyss");
});

test("a stat that grants an effect makes it available, and says which stat", () => {
  // The only way to get `fortify` or any of the three charges: no spell in the pack applies
  // them, a support gem or an ascendancy node does.
  const state = stateOf({
    mmorpg_exile_effect: { fortify: effectEntry("fortify") },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: {
      fortify_on_melee_hit: statEntry("fortify_on_melee_hit", {
        effect: [{ effects: ["give_fortify_to_source"], events: ["on_damage"], side: "Source" }],
      }),
    },
    mmorpg_stat_effect: {
      give_fortify_to_source: {
        id: "give_fortify_to_source",
        ser: "give_exile_effect",
        effect: "fortify",
        give_to: "Source",
        seconds: 4,
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("fortify_on_melee_hit", "FLAT", 100)]),
    },
  }, { skills: [{ spellId: "strike", main: true }] });

  const fortify = state.options[0]!;
  assert.equal(fortify.id, "fortify");
  assert.equal(fortify.side, "caster");
  assert.deepEqual(
    fortify.grantedBy.map((g) => (g.kind === "stat" ? g.statId : g.kind)),
    ["fortify_on_melee_hit"],
  );
});

test("a support gem that grants an effect offers it, though the sheet never holds its stat", () => {
  // The real shape of Fortify in this pack: the stat is on the *support gem*, so it is a
  // `SUPPORT_GEM` context belonging to the linked Skill and `sheet.get("fortify_on_melee_hit")`
  // is 0. Reading only the sheet offered nothing, and the damage pass then complained that
  // `fortify` was switched off — with no toggle anywhere that could switch it on.
  const registries = {
    mmorpg_exile_effect: { fortify: effectEntry("fortify") },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_support_gem: {
      fortify: { id: "fortify", stats: [{ stat: "fortify_on_melee_hit", type: "FLAT", min: 70, max: 100 }] },
    },
    mmorpg_stat: {
      fortify_on_melee_hit: statEntry("fortify_on_melee_hit", {
        effect: [{ effects: ["give_fortify_to_source"], events: ["on_damage"], side: "Source" }],
      }),
    },
    mmorpg_stat_effect: {
      give_fortify_to_source: {
        id: "give_fortify_to_source",
        ser: "give_exile_effect",
        effect: "fortify",
        give_to: "Source",
        seconds: 4,
      },
    },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
  };

  const bare = stateOf(registries, { skills: [{ spellId: "strike", main: true }] });
  assert.deepEqual(bare.options.map((o) => o.id), [], "no gem socketed, nothing to offer");

  const socketed = stateOf(registries, {
    skills: [{ spellId: "strike", main: true, supports: [{ id: "fortify", rollPercent: 80 }] }],
  });
  const fortify = socketed.options[0]!;
  assert.equal(fortify.id, "fortify");
  assert.equal(fortify.side, "caster", "give_to Source on a Source-side event is you");
  assert.equal(fortify.stacks, 1, "available, so up");
  assert.deepEqual(
    fortify.grantedBy.map((g) => (g.kind === "support" ? `${g.gemId}@${g.spellId}` : g.kind)),
    ["fortify@strike"],
  );

  // A Skill you have switched off takes its gems with it — the hits that would fortify you
  // never happen.
  const off = stateOf(registries, {
    skills: [{ spellId: "strike", main: true, enabled: false, supports: [{ id: "fortify", rollPercent: 80 }] }],
  });
  assert.deepEqual(off.options.map((o) => o.id), []);
});

test("give_to is read against the event side, not absolutely", () => {
  // `endurance_charge_when_hit` is `side: Target, give_to: Target`: you are the target of the
  // event, and you are who gains the charge. Reading `give_to` on its own puts it on the mob.
  const state = stateOf({
    mmorpg_exile_effect: { endurance_charge: effectEntry("endurance_charge", { max_stacks: 3 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: {
      endurance_charge_when_hit: statEntry("endurance_charge_when_hit", {
        effect: [{ effects: ["give_endurance_charge_to_target"], events: ["on_damage"], side: "Target" }],
      }),
    },
    mmorpg_stat_effect: {
      give_endurance_charge_to_target: {
        id: "give_endurance_charge_to_target",
        ser: "give_exile_effect",
        effect: "endurance_charge",
        give_to: "Target",
        seconds: 10,
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("endurance_charge_when_hit", "FLAT", 25)]),
    },
  }, { skills: [{ spellId: "strike", main: true }] });

  assert.equal(state.options[0]!.side, "caster");
});

test("a player tick grants to you, whichever end give_to names", () => {
  // `OnServerTick` raises the ten-second tick as `new TenSecondPlayerTickEvent(player, player)`,
  // so `event.getSide(give_to)` returns the player whichever end is asked for. All eight of the
  // pack's tick grants are written `side: Source, give_to: Target`, and comparing the two filed
  // every one onto the enemy — including the only source of frenzy charges in the game.
  const state = stateOf({
    mmorpg_exile_effect: { frenzy_charge: effectEntry("frenzy_charge", { max_stacks: 3 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: {
      gain_frenzy_charges_every_10s: statEntry("gain_frenzy_charges_every_10s", {
        effect: [{
          effects: ["give_frenzy_charge_to_target"],
          events: ["player_tick_event_10s"],
          side: "Source",
        }],
      }),
    },
    mmorpg_stat_effect: {
      give_frenzy_charge_to_target: {
        id: "give_frenzy_charge_to_target",
        ser: "give_exile_effect",
        effect: "frenzy_charge",
        give_to: "Target",
        seconds: 30,
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("gain_frenzy_charges_every_10s", "FLAT", 1)]),
    },
  }, { skills: [{ spellId: "strike", main: true }] });

  const charge = state.options.find((o) => o.id === "frenzy_charge");
  assert.ok(charge, "the charge is offered");
  assert.equal(charge.side, "caster", "a tick event has one entity, and it is you");
});

test("an effect with no stats that nothing tests for is not offered", () => {
  // 212 toggles is not a user interface. `bleed_effect` has no stats and no gate reads it, so it
  // cannot change a number and does not earn a row.
  const state = stateOf({
    mmorpg_exile_effect: { bleed_effect: effectEntry("bleed_effect", { stats: [] }) },
    mmorpg_spells: { rend: granting("rend", "bleed_effect") },
  }, { skills: [{ spellId: "rend", main: true }] });

  assert.deepEqual(state.options.map((o) => o.id), []);
});

test("an effect with no stats is offered when a spell gates on it", () => {
  const spell = spellEntry("finisher", "Physical", "hit100");
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
      ifs: [
        { type: "on_spell_cast", map: {} },
        { type: "caster_has_mns_effect", map: { exile_potion_id: "combo_extender" } },
      ],
      targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
      en_preds: [],
    },
  ];

  const state = stateOf({
    mmorpg_exile_effect: { combo_extender: effectEntry("combo_extender", { stats: [] }) },
    mmorpg_spells: { finisher: spell, extender: granting("extender", "combo_extender") },
  }, { skills: [{ spellId: "finisher", main: true }, { spellId: "extender" }] });

  assert.deepEqual(state.options.map((o) => o.id), ["combo_extender"]);
});

// ---------------------------------------------------------------------------
// One list, one answer
// ---------------------------------------------------------------------------

/** The character sheet a build resolves to, so a toggle can be read as a number. */
function sheetOf(
  registries: Record<string, Record<string, Record<string, unknown>>>,
  doc: Partial<BuildDoc>,
) {
  const snapshot = engineSnapshot(registries);
  const build = { schemaVersion: 1, character: { level: 1 }, ...doc } as BuildDoc;
  return calculate(build, snapshot);
}

/** A build whose one skill grants `fury`, which grants +5 armor. */
const FURY = {
  mmorpg_exile_effect: { fury: effectEntry("fury") },
  mmorpg_spells: { war_cry: granting("war_cry", "fury") },
};

/**
 * `dmg_per_endurance_charge`-shaped: `total_damage` FLAT 1 for every point, times the stacks of
 * `endurance_charge` you are holding.
 */
function perEffectStat(id: string, effectId: string, statId: string): Record<string, unknown> {
  return {
    ser: "bonus_stat_per_effect",
    data: {
      id,
      base: 0,
      min: 0,
      max: 100000000,
      perc: false,
      scale: "NONE",
      effect_id: effectId,
      core_stat_data: { stats: [{ type: "FLAT", scale_to_lvl: false, stat: statId, v1: 1 }] },
    },
  };
}

/** A build holding `endurance_charge` from a skill, with 8 points of `dmg_per_endurance_charge`. */
const CHARGES = {
  mmorpg_exile_effect: {
    endurance_charge: effectEntry("endurance_charge", { max_stacks: 3, tags: { tags: ["charge"] } }),
  },
  mmorpg_spells: { brace: granting("brace", "endurance_charge") },
  mmorpg_stat: {
    total_damage: statEntry("total_damage"),
    max_endurance_charge_charges: statEntry("max_endurance_charge_charges"),
    dmg_per_endurance_charge: perEffectStat(
      "dmg_per_endurance_charge",
      "endurance_charge",
      "total_damage",
    ),
  },
  mmorpg_base_stats: {
    original_mode_player: baseStats("original_mode_player", [
      exact("dmg_per_endurance_charge", "FLAT", 8),
    ]),
  },
};

test("a per-charge stat counts the charges the build resolves, not the ones a capture caught", () => {
  // `BonusStatPerEffectStacks.getMods` is `data.statusEffects.getStacks(effect)` — what you are
  // holding *now*. This used to read `build.exileEffects` instead, which is a photograph: the
  // count could not be moved by the toggles, could not be moved by a cap the tree had raised,
  // and was zero for any build written by hand. Twenty of the pack's stats are this shape and
  // every one of them was affected.
  const sheet = sheetOf(CHARGES, { skills: [{ spellId: "brace", main: true }] });
  // Three charges at 8 points each, `total_damage` FLAT 1 per point.
  closeTo(sheet.stats.get("total_damage")?.value, 24);

  const grant = sheet.derived.find((d) => d.kind === "bonus_stat_per_effect");
  assert.ok(grant, "the contribution is recorded, so a breakdown can show where it came from");
  assert.equal(grant.from, "dmg_per_endurance_charge");
});

test("raising the charge cap raises what a per-charge stat is worth", () => {
  // The Guardian ascendancy end to end: its two `+1 max endurance charge` nodes and its
  // `dmg_per_endurance_charge` are on the same two perks, and the first has to reach the second.
  const registries = {
    ...CHARGES,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("dmg_per_endurance_charge", "FLAT", 8),
        exact("max_endurance_charge_charges", "FLAT", 2),
      ]),
    },
  };
  const sheet = sheetOf(registries, {
    skills: [{ spellId: "brace", main: true }],
    // The capture still says three, because three was the cap when it was taken.
    exileEffects: [{ id: "endurance_charge", stacks: 3 }],
  });
  closeTo(sheet.stats.get("total_damage")?.value, 40);
});

test("a per-charge stat follows the toggle, both ways", () => {
  const skills = [{ spellId: "brace", main: true }];
  const off = sheetOf(CHARGES, { skills, config: { effects: { endurance_charge: false } } });
  const one = sheetOf(CHARGES, { skills, config: { effects: { endurance_charge: 1 } } });

  closeTo(off.stats.get("total_damage")?.value, 0);
  closeTo(one.stats.get("total_damage")?.value, 8);
});

test("a per-charge stat does not count an effect sitting on the enemy", () => {
  // `data.statusEffects` is the caster's own list. `state.active` is side-blind by design, so
  // reading it directly would pay a `dmg_to_cursed_per_soul_stack` for the mob's stacks.
  const registries = {
    ...CHARGES,
    mmorpg_spells: { hex: grantingTo({ type: "aoe", map: { radius: 3, en_predicate: "enemies" } }, "hex", "endurance_charge") },
  };
  const sheet = sheetOf(registries, { skills: [{ spellId: "hex", main: true }] });
  closeTo(sheet.stats.get("total_damage")?.value, 0);
});

test("turning a captured effect off takes its stats off the sheet", () => {
  // The bug this whole file exists to prevent. `build.exileEffects` used to feed the stat sheet
  // directly, so unticking a buff switched off the spell *branch* that needed it while its armour
  // stayed on the character. One list, one answer: the tick decides both.
  const skills = [{ spellId: "war_cry", main: true }];
  const exileEffects = [{ id: "fury", stacks: 1, spellId: "war_cry", strMulti: 1 }];

  const on = sheetOf(FURY, { skills, exileEffects });
  const off = sheetOf(FURY, { skills, exileEffects, config: { effects: { fury: false } } });

  assert.equal(on.stats.get("armor")?.value, 5);
  assert.equal(off.stats.get("armor")?.value ?? 0, 0);
  assert.equal(off.effects.options.find((o) => o.id === "fury")?.stacks, 0);
});

test("an effect with no capture rolls at the rank of the skill that would apply it", () => {
  // `ExileEffect.getExactStats` interpolates over the applying spell's rank, and a toggle used to
  // have nothing to interpolate with, so every band read at its minimum. `hunters_focus` is
  // `FLAT 1..3 projectile_count`: the floor is the difference between two projectiles and four,
  // and the spell that grants it is sitting on the bar with a rank on it.
  const registries = {
    mmorpg_exile_effect: {
      hunters_focus: effectEntry("hunters_focus", {
        stats: [{ type: "FLAT", min: 1, max: 3, stat: "armor" }],
      }),
    },
    mmorpg_spells: { hunters_focus: granting("hunters_focus", "hunters_focus") },
  };

  // `max_lvl` 16 + `MAX_BONUS_SPELL_LEVELS` 8 is 24, so rank 12 is `(int) (100 / 24 * 12)` = 50.
  const mid = sheetOf(registries, { skills: [{ spellId: "hunters_focus", level: 12, main: true }] });
  assert.equal(mid.effects.options[0]!.rollPercent, 50);
  assert.equal(mid.stats.get("armor")?.value, 2, "halfway up a 1..3 band");

  const maxed = sheetOf(registries, {
    skills: [{ spellId: "hunters_focus", level: 24, main: true }],
  });
  assert.equal(maxed.effects.options[0]!.rollPercent, 100);
  assert.equal(maxed.stats.get("armor")?.value, 3);
});

test("str_multi is the inc_effect_of_<tag>_buff stats that match the effect's tags", () => {
  // `ExilePotionEvent` starts the event number at 1 and the stat pipeline adds every
  // `inc_effect_of_<tag>_buff_given`/`_on_you` whose `effect_has_tag_<tag>` condition holds, then
  // `extraData.str_multi = data.getNumber()`. So it is `1 + sum/100` over the effect's own tags.
  //
  // Pinned against the level-100 capture, which carries `positive` 64.7 and `defensive` 50 and
  // recorded 1.647 on a positive+offensive buff and 2.147 on a positive+defensive one.
  const registries = {
    mmorpg_exile_effect: {
      fury: effectEntry("fury", { tags: { tags: ["positive", "offensive"] } }),
      zen: effectEntry("zen", { tags: { tags: ["positive", "defensive"] } }),
    },
    mmorpg_spells: { fury: granting("fury", "fury"), zen: granting("zen", "zen") },
    mmorpg_stat: {
      inc_effect_of_positive_buff_given: statEntry("inc_effect_of_positive_buff_given"),
      inc_effect_of_defensive_buff_given: statEntry("inc_effect_of_defensive_buff_given"),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("inc_effect_of_positive_buff_given", "FLAT", 64.7),
        exact("inc_effect_of_defensive_buff_given", "FLAT", 50),
      ]),
    },
  };

  const state = sheetOf(registries, {
    skills: [{ spellId: "fury", main: true }, { spellId: "zen" }],
  }).effects;

  closeTo(state.options.find((o) => o.id === "fury")!.strMulti, 1.647);
  closeTo(state.options.find((o) => o.id === "zen")!.strMulti, 2.147);
});

test("the planner assumes what you could apply; a fixture assumes only what was measured", () => {
  // Two readings, and the default is the planner one because that is what this is. An effect your
  // gear or your bar can put up is one you want the number for. `"captured"` is the closed-world
  // reading `compareFixture` asks for, where the question is whether the engine reproduces a
  // sheet the game actually printed, and a buff the capture did not list was not running.
  const skills = [{ spellId: "war_cry", main: true }];
  const exileEffects = [{ id: "other", stacks: 1 }];

  const planning = sheetOf(FURY, { skills, exileEffects });
  assert.equal(planning.effects.assume, "available");
  assert.equal(planning.stats.get("armor")?.value, 5);

  const measured = sheetOf(FURY, {
    skills,
    exileEffects,
    config: { assumeEffects: "captured" },
  });
  assert.equal(measured.effects.assume, "captured");
  assert.equal(measured.stats.get("armor")?.value ?? 0, 0, "fury was not running when captured");
  assert.equal(
    measured.effects.options.find((o) => o.id === "fury")?.stacks,
    0,
    "still offered, so it can be turned on",
  );
});

test("an explicit entry can assume an effect nothing in the build would apply", () => {
  // Availability is an aid to whoever fills in the form, not a veto over what they wrote.
  // "Assume the target is shredded" is a reasonable thing to ask of a planner.
  const registries = {
    mmorpg_exile_effect: { fortify: effectEntry("fortify") },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
  };
  const skills = [{ spellId: "strike", main: true }];

  assert.equal(sheetOf(registries, { skills }).effects.options.length, 0);

  const asked = sheetOf(registries, { skills, config: { effects: { fortify: true } } });
  assert.deepEqual(
    asked.effects.options.map((o) => o.grantedBy[0]!.kind),
    ["declared"],
  );
  assert.equal(asked.stats.get("armor")?.value, 5);
});

test("the capture's stacks are the default, and ticking it back on restores them", () => {
  // `true` and an absent entry mean the same thing — up, at whatever it would naturally be at —
  // so unticking and re-ticking a captured two-stack buff does not silently promote it to its cap.
  const registries = {
    mmorpg_exile_effect: { rage: effectEntry("rage", { max_stacks: 5 }) },
    mmorpg_spells: { roar: granting("roar", "rage") },
  };
  const doc = {
    skills: [{ spellId: "roar", main: true }],
    exileEffects: [{ id: "rage", stacks: 2 }],
  };

  assert.equal(sheetOf(registries, doc).effects.active.get("rage"), 2);
  assert.equal(
    sheetOf(registries, { ...doc, config: { effects: { rage: true } } }).effects.active.get("rage"),
    2,
  );
  assert.equal(
    sheetOf(registries, { ...doc, config: { effects: { rage: 5 } } }).effects.active.get("rage"),
    5,
  );
});

test("disabling the skill that sustained a captured buff takes the buff with it", () => {
  // The skill toggle is for asking what the build is worth without a skill, and a capture that
  // names the spell which applied each effect is exactly enough to answer it.
  const registries = {
    mmorpg_exile_effect: { fury: effectEntry("fury") },
    mmorpg_spells: { war_cry: granting("war_cry", "fury") },
  };
  const exileEffects = [{ id: "fury", stacks: 1, spellId: "war_cry", strMulti: 1 }];

  const on = sheetOf(registries, { skills: [{ spellId: "war_cry", main: true }], exileEffects });
  const off = sheetOf(registries, {
    skills: [{ spellId: "war_cry", main: true, enabled: false }],
    exileEffects,
  });

  assert.equal(on.stats.get("armor")?.value, 5);
  assert.equal(off.stats.get("armor")?.value ?? 0, 0);
  assert.deepEqual(off.effects.options, []);
});

/** The pack's real shape for a self-applied on-hit grant: stat effect, stat, and the two ids. */
const GRANT_REGISTRIES = {
  mmorpg_stat: {
    give_tailwind_on_hit: statEntry("give_tailwind_on_hit", {
      effect: [{ effects: ["give_tailwind_to_source"], events: ["on_damage"], side: "Source" }],
    }),
    tailwind_when_hit: statEntry("tailwind_when_hit", {
      effect: [{ effects: ["give_tailwind_to_target"], events: ["on_damage"], side: "Target" }],
    }),
  },
  mmorpg_stat_effect: {
    give_tailwind_to_source: {
      id: "give_tailwind_to_source",
      ser: "give_exile_effect",
      effect: "tailwind",
      give_to: "Source",
      seconds: 4,
    },
    give_tailwind_to_target: {
      id: "give_tailwind_to_target",
      ser: "give_exile_effect",
      effect: "tailwind",
      give_to: "Target",
      seconds: 4,
    },
  },
  // A band, so the roll percent is observable: at 0% this is 1 and at 100% it is 3.
  mmorpg_exile_effect: {
    tailwind: effectEntry("tailwind", {
      stats: [{ type: "FLAT", min: 1, max: 3, stat: "projectile_count" }],
    }),
  },
  mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
};

test("a spell's own statsForSkillGem grant is available, though the sheet never holds its stat", () => {
  // `Spell.getStats` interpolates `statsForSkillGem` over the spell's rank and files the result
  // as an `INNATE_SPELL` context on the Skill, exactly as a support gem's stats are filed on it.
  // So the character sheet never carries the stat, the sheet scan could not see it, and
  // `tailwind_sweep`'s own `give_tailwind_on_hit` — a flat 100, meaning every hit — read as
  // unavailable. The sweep would then run the grant and report the effect as switched off.
  const sweep = spellEntry("sweep", "Physical", "hit100", {
    statsForSkillGem: [{ type: "FLAT", min: 100, max: 100, stat: "give_tailwind_on_hit" }],
  });
  const plain = spellEntry("plain", "Physical", "hit100");

  const withInnate = stateOf(
    { ...GRANT_REGISTRIES, mmorpg_spells: { sweep, plain } },
    { skills: [{ spellId: "sweep", level: 16, main: true }] },
  );
  const tailwind = withInnate.options[0]!;
  assert.equal(tailwind.id, "tailwind");
  assert.equal(tailwind.side, "caster");
  assert.equal(tailwind.stacks, 1, "available, so up");
  assert.deepEqual(
    tailwind.grantedBy.map((g) => (g.kind === "skill_gem" ? `${g.statId}@${g.spellId}` : g.kind)),
    ["give_tailwind_on_hit@sweep"],
  );

  // A spell without the innate stat offers nothing, and neither does one switched off.
  const without = stateOf(
    { ...GRANT_REGISTRIES, mmorpg_spells: { sweep, plain } },
    { skills: [{ spellId: "plain", level: 16, main: true }] },
  );
  assert.deepEqual(without.options.map((o) => o.id), []);

  const off = stateOf(
    { ...GRANT_REGISTRIES, mmorpg_spells: { sweep, plain } },
    { skills: [{ spellId: "sweep", level: 16, main: true, enabled: false }] },
  );
  assert.deepEqual(off.options.map((o) => o.id), []);
});

test("a grant triggered by your own hit rolls over that skill's rank, not over nothing", () => {
  // `GiveExileStatusEffect.activate` copies the triggering event's spell onto the effect when
  // `event.isSpell()`, and the mod's own comment on those lines says that without it "even a
  // spell triggered grant lands unbound and scales its stats off nothing". A support gem or an
  // innate stat belongs to exactly one Skill, so the hit that fires it is that skill's.
  const sweep = spellEntry("sweep", "Physical", "hit100", {
    statsForSkillGem: [{ type: "FLAT", min: 100, max: 100, stat: "give_tailwind_on_hit" }],
  });

  const bound = stateOf(
    { ...GRANT_REGISTRIES, mmorpg_spells: { sweep } },
    { skills: [{ spellId: "sweep", level: 16, main: true }] },
  ).options[0]!;
  assert.equal(bound.spellId, "sweep");
  assert.ok(bound.rollPercent > 0, `bound to a rank 16 spell, got ${bound.rollPercent}%`);

  // The same effect off a Target-side stat is a hit *you took*: the bound spell is whatever hit
  // you, which a build document has no way to name, so it genuinely rolls its minimum.
  const whenHit = stateOf(
    {
      ...GRANT_REGISTRIES,
      mmorpg_spells: { sweep: spellEntry("sweep", "Physical", "hit100") },
      mmorpg_base_stats: {
        original_mode_player: baseStats("original_mode_player", [
          exact("tailwind_when_hit", "FLAT", 100),
        ]),
      },
    },
    { skills: [{ spellId: "sweep", level: 16, main: true }] },
  ).options[0]!;
  assert.equal(whenHit.spellId, undefined);
  assert.equal(whenHit.rollPercent, 0);
});

// ---------------------------------------------------------------------------
// Gated grants — `blasphemous_ritual`'s shape
// ---------------------------------------------------------------------------

/**
 * A spell whose `entity_components` grant one effect per gate, the way `blasphemous_ritual`
 * declares a ritual per aura. Each entry is `[gate, negated, granted]`.
 */
function gatedGrants(
  id: string,
  ...parts: [gate: string, negated: boolean, granted: string][]
): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100");
  (spell["attached"] as Record<string, unknown>)["entity_components"] = {
    stack_adder: parts.map(([gate, negated, granted]) => ({
      acts: [
        {
          type: "exile_effect",
          map: { exile_potion_id: granted, potion_action: "GIVE_STACKS", count: 1, potion_dur: 20 },
        },
      ],
      ifs: [
        { type: "on_entity_expire", map: {} },
        { type: "caster_has_mns_effect", map: negated ? { exile_potion_id: gate, is_false: true } : { exile_potion_id: gate } },
      ],
      targets: [{ type: "self", map: {} }],
      en_preds: [],
    })),
  };
  return spell;
}

test("a grant behind a caster_has_mns_effect gate needs that effect to be reachable", () => {
  // `blasphemous_ritual` in miniature: three rituals, one per aura, and the character owns the
  // spell that applies only one of the auras. Reading the acts without their gates offered all
  // three, and the group's id-order tiebreak then picked `ritual_of_abyss` — the one whose aura
  // the character cannot even learn — while the sanguine aura it was actually running sat up
  // beside it. The state contradicted itself and the sheet carried the wrong ritual's stats.
  const state = stateOf({
    mmorpg_exile_effect: {
      sanguine_aura: effectEntry("sanguine_aura", { one_of_a_kind_id: "aura" }),
      abyssal_aura: effectEntry("abyssal_aura", { one_of_a_kind_id: "aura" }),
      ritual_of_abyss: effectEntry("ritual_of_abyss", { one_of_a_kind_id: "ritual" }),
      ritual_of_blood: effectEntry("ritual_of_blood", { one_of_a_kind_id: "ritual" }),
    },
    mmorpg_spells: {
      sanguine_aura: granting("sanguine_aura", "sanguine_aura"),
      blasphemous_ritual: gatedGrants(
        "blasphemous_ritual",
        ["abyssal_aura", false, "ritual_of_abyss"],
        ["sanguine_aura", false, "ritual_of_blood"],
      ),
    },
  }, {
    skills: [{ spellId: "sanguine_aura", main: true }, { spellId: "blasphemous_ritual" }],
  });

  const by = (id: string) => state.options.find((o) => o.id === id)!;
  assert.equal(by("ritual_of_blood").stacks, 1, "the aura on the bar earns its own ritual");
  assert.equal(by("ritual_of_abyss").stacks, 0);
  assert.deepEqual(by("ritual_of_abyss").needs, ["abyssal_aura"], "and says what it wanted");
  assert.equal(state.chosenOfGroup.get("ritual"), "ritual_of_blood");
});

test("a negated gate is not a requirement", () => {
  // "When you do *not* already have it" is how `blasphemous_ritual` avoids re-applying itself.
  // Reading that as a precondition would make the effect unavailable exactly when it is up.
  const state = stateOf({
    mmorpg_exile_effect: { ritual: effectEntry("ritual") },
    mmorpg_spells: { rite: gatedGrants("rite", ["ritual", true, "ritual"]) },
  }, { skills: [{ spellId: "rite", main: true }] });

  assert.equal(state.options.find((o) => o.id === "ritual")!.stacks, 1);
});

test("an unconditional grant is not hidden behind a gated one walked first", () => {
  // Grants are alternatives: one route needing nothing is enough, however many gated routes the
  // same spell also declares.
  const state = stateOf({
    mmorpg_exile_effect: {
      fury: effectEntry("fury"),
      unreachable: effectEntry("unreachable"),
    },
    mmorpg_spells: {
      war_cry: gatedGrants("war_cry", ["unreachable", false, "fury"]),
      shout: granting("shout", "fury"),
    },
  }, { skills: [{ spellId: "war_cry", main: true }, { spellId: "shout" }] });

  const fury = state.options.find((o) => o.id === "fury")!;
  assert.equal(fury.stacks, 1);
  assert.equal(fury.needs, undefined);
});

test("an explicit entry overrides an unmet gate", () => {
  // Availability is an aid to the person filling in the form, never a veto over what they wrote
  // — the same rule that lets a document assume a debuff none of its own skills apply.
  const registries = {
    mmorpg_exile_effect: {
      ritual_of_abyss: effectEntry("ritual_of_abyss"),
      abyssal_aura: effectEntry("abyssal_aura"),
    },
    mmorpg_spells: {
      blasphemous_ritual: gatedGrants("blasphemous_ritual", ["abyssal_aura", false, "ritual_of_abyss"]),
    },
  };
  const skills = [{ spellId: "blasphemous_ritual", main: true }];

  const off = stateOf(registries, { skills });
  assert.equal(off.options.find((o) => o.id === "ritual_of_abyss")!.stacks, 0);

  const on = stateOf(registries, { skills, config: { effects: { ritual_of_abyss: true } } });
  assert.equal(on.options.find((o) => o.id === "ritual_of_abyss")!.stacks, 1);
});

/**
 * Zap and Cold Snap's Conduction combo, in miniature.
 *
 * The pack builds it as a **two-level** chain, and each level is a different mechanism:
 *
 *     conduction (a stance spell)  --grants-->  conduction
 *     zap        --needs conduction-->  grants conduction_zap
 *     cold_snap  --needs conduction-->  grants conduction_cold_snap
 *     zap's bonus damage act        --needs conduction_cold_snap
 *     cold_snap's bonus damage act  --needs conduction_zap
 *
 * So each spell's extra hit is paid for by *the other one* being cast while the stance is up,
 * and none of it exists unless all three are on the bar. `conduction_zap` and
 * `conduction_cold_snap` carry no stats of their own — they are pure markers, and the only
 * reason they are listed at all is that a damage act tests for them.
 */
function conductionRegistries(): Record<string, Record<string, Record<string, unknown>>> {
  /** A spell that grants `marker` when `conduction` is up, and hits harder when `needs` is. */
  const combo = (id: string, marker: string, needs: string): Record<string, unknown> => {
    const spell = gatedGrants(id, ["conduction", false, marker]);
    const attached = spell["attached"] as Record<string, unknown>;
    // The bonus hit, gated on the partner's marker — this is also what puts a stats-less
    // marker into the option list, since an effect nothing tests for is not offered.
    (attached["on_cast"] as unknown[]).push({
      acts: [{ type: "damage", map: { element: "Cold", value_calculation: "hit100" } }],
      ifs: [{ type: "caster_has_mns_effect", map: { exile_potion_id: needs } }],
      targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
      en_preds: [],
    });
    return spell;
  };

  return {
    mmorpg_exile_effect: {
      conduction: effectEntry("conduction"),
      conduction_zap: effectEntry("conduction_zap", { stats: [] }),
      conduction_cold_snap: effectEntry("conduction_cold_snap", { stats: [] }),
    },
    mmorpg_spells: {
      conduction: granting("conduction", "conduction"),
      zap: combo("zap", "conduction_zap", "conduction_cold_snap"),
      cold_snap: combo("cold_snap", "conduction_cold_snap", "conduction_zap"),
    },
  };
}

test("a grant behind a gate that is itself granted resolves both, a level at a time", () => {
  const registries = conductionRegistries();
  const stacks = (state: ReturnType<typeof stateOf>, id: string): number | undefined =>
    state.options.find((o) => o.id === id)?.stacks;

  // Both spells on the bar, no stance: neither marker is reachable, and each says what it wants.
  const without = stateOf(registries, {
    skills: [{ spellId: "zap", main: true }, { spellId: "cold_snap" }],
  });
  assert.equal(stacks(without, "conduction_zap"), 0);
  assert.equal(stacks(without, "conduction_cold_snap"), 0);
  assert.deepEqual(without.options.find((o) => o.id === "conduction_zap")?.needs, ["conduction"]);

  // Add the stance and the whole chain lights up — the second level is only reachable because
  // the first one resolved, which is the part a single pass would have missed.
  const withIt = stateOf(registries, {
    skills: [{ spellId: "zap", main: true }, { spellId: "cold_snap" }, { spellId: "conduction" }],
  });
  assert.equal(stacks(withIt, "conduction"), 1);
  assert.equal(stacks(withIt, "conduction_zap"), 1);
  assert.equal(stacks(withIt, "conduction_cold_snap"), 1);

  // The stance without the partner skill grants only its own marker. `conduction_cold_snap` is
  // Cold Snap's to give, and with Cold Snap off the bar nothing in the build can put it up at
  // all — so it is not *offered*, which is a stronger statement than "offered at zero" and the
  // one the header argues for: a list of 212 toggles is not a user interface.
  const zapOnly = stateOf(registries, {
    skills: [{ spellId: "zap", main: true }, { spellId: "conduction" }],
  });
  assert.equal(stacks(zapOnly, "conduction_zap"), 1);
  assert.equal(stacks(zapOnly, "conduction_cold_snap"), undefined);

  // A disabled skill grants nothing, so unticking Cold Snap takes Zap's bonus with it.
  const coldSnapOff = stateOf(registries, {
    skills: [
      { spellId: "zap", main: true },
      { spellId: "cold_snap", enabled: false },
      { spellId: "conduction" },
    ],
  });
  assert.equal(stacks(coldSnapOff, "conduction_cold_snap"), undefined);
});
