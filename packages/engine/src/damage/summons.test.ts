/**
 * What a pet is worth.
 *
 * `summons.ts` quotes the Java these are derived from; these pin the arithmetic. The two facts
 * most worth holding still are that a pet's group is entered at `default_entity_name` rather than
 * cast, and that its extra-spell cooldown caps *attempts* rather than successes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  effectBlock,
  engineSnapshot,
  exact,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { simulateDps } from "./dps.js";

/**
 * A pet's basic attack: one damage act in `default_entity_name`, on hit, against the target.
 *
 * Exactly the shape every one of the pack's seventeen has — `zombie_basic` is this file verbatim
 * — and deliberately with an empty `on_cast`, because that is what made them report zero.
 */
function petBasic(id: string, calcId: string, summonSkillId: string): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", calcId, {
    config: {
      tags: { tags: ["summon", "damage"] },
      use_support_gems_from: summonSkillId,
      cast_speed_ticks: 20,
      cast_time_ticks: 0,
      cooldown_ticks: 0,
      times_to_cast: 1,
    },
  });
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [];
  (spell["attached"] as Record<string, unknown>)["entity_components"] = {
    default_entity_name: [
      {
        acts: [{ type: "damage", map: { element: "Physical", value_calculation: calcId } }],
        ifs: [{ type: "on_hit", map: {} }],
        targets: [{ type: "target", map: {} }],
        en_preds: [],
      },
    ],
  };
  return spell;
}

/** A summoning skill: one `summon_pet` act and no damage of its own, as the pack writes them. */
function summonSkill(
  id: string,
  opts: {
    petId: string;
    basic: string;
    summonType: string;
    count?: number;
    lifeTicks?: number;
    countsTowardsMax?: boolean;
    cooldownTicks?: number;
    castSpeedTicks?: number;
    summonSpells?: string[];
    summonSpellChance?: number;
    summonSpellCdTicks?: number;
    golem?: boolean;
  },
): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "nothing", {
    config: {
      tags: { tags: opts.golem === true ? ["summon", "golem"] : ["summon"] },
      use_support_gems_from: "",
      cast_speed_ticks: opts.castSpeedTicks ?? 20,
      cast_time_ticks: 0,
      cooldown_ticks: opts.cooldownTicks ?? 0,
      times_to_cast: 1,
      summonType: opts.summonType,
      summon_basic_atk: opts.basic,
      summon_spells: opts.summonSpells ?? [],
      summon_spell_chance: opts.summonSpellChance ?? 0,
      summon_spell_cd_ticks: opts.summonSpellCdTicks ?? 20,
    },
  });
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      acts: [
        {
          type: "summon_pet",
          map: {
            count: opts.count ?? 1,
            counts_towards_max_summons: opts.countsTowardsMax ?? true,
            entity_name: "default_entity_name",
            life_ticks: opts.lifeTicks ?? 12000,
            summon_id: opts.petId,
            summon_type: opts.summonType,
          },
        },
      ],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [],
      en_preds: [],
    },
  ];
  return spell;
}

/**
 * The cap wiring, exactly as the pack ships it.
 *
 * `max_<type>_summons` is an ordinary stat whose effect adds into the `bonus_total_summons`
 * number on `on_spell_stat_calc`, gated on a `string_matches` condition against the spell's own
 * `summon_type`. Nothing about summons is hardcoded anywhere: the cap a spell gets is whichever
 * of these conditions its `summonType` satisfies.
 */
function capStat(type: string): Record<string, unknown> {
  return statEntry(`max_${type}_summons`, {
    effect: [
      {
        effects: ["add_total_summons"],
        events: ["on_spell_stat_calc"],
        ifs: [`summon_type_is_${type}`],
        order: "data_modification",
        side: "Source",
      },
    ],
  });
}

const REGISTRIES = {
  mmorpg_stat: {
    max_undead_summons: capStat("undead"),
    max_spider_summons: capStat("spider"),
    max_golem_summons: capStat("golem"),
    golem_spell_chance: statEntry("golem_spell_chance"),
    // The real `summon_damage`: an ordinary increased-damage stat gated on the spell's tag, with
    // nothing about summons in it. A pet basic carries `summon`, so it applies; the summoning
    // skill's own (zero-damage) cast does not.
    summon_damage: statEntry("summon_damage", {
      is_perc: true,
      effect: [effectBlock("damage_layers", ["add_additive"], ["spell_has_tag_summon"])],
    }),
  },
  mmorpg_stat_effect: {
    add_total_summons: {
      id: "add_total_summons",
      ser: "add_to_number",
      number_id: "bonus_total_summons",
      num_provider: { type: "STAT_DATA", calc: "" },
    },
    add_additive: {
      id: "add_additive",
      ser: "modify_stat_layer",
      layer: "additive_damage",
      modification: "ADD",
      num_provider: { type: "STAT_DATA", calc: "" },
    },
  },
  mmorpg_stat_condition: {
    summon_type_is_undead: condition("summon_type_is_undead", "string_matches", {
      string_key: "summon_type",
      string_id: "undead",
    }),
    summon_type_is_spider: condition("summon_type_is_spider", "string_matches", {
      string_key: "summon_type",
      string_id: "spider",
    }),
    summon_type_is_golem: condition("summon_type_is_golem", "string_matches", {
      string_key: "summon_type",
      string_id: "golem",
    }),
    spell_has_tag_summon: condition("spell_has_tag_summon", "spell_has_tag", { tag: { id: "summon" } }),
  },
  mmorpg_value_calc: {
    bite: valueCalcEntry("bite", { min: 100, max: 100 }),
    nova: valueCalcEntry("nova", { min: 500, max: 500 }),
    nothing: valueCalcEntry("nothing", { min: 0, max: 0 }),
  },
  mmorpg_spells: {
    zombie_basic: petBasic("zombie_basic", "bite", "summon_zombie"),
    skeleton_basic: petBasic("skeleton_basic", "bite", "summon_skeletons"),
    golem_basic: petBasic("golem_basic", "bite", "summon_golem"),
    fire_nova: spellEntry("fire_nova", "Fire", "nova", {
      config: {
        tags: { tags: [] },
        use_support_gems_from: "",
        cast_speed_ticks: 20,
        cast_time_ticks: 0,
        cooldown_ticks: 0,
        times_to_cast: 1,
      },
    }),
    summon_zombie: summonSkill("summon_zombie", {
      petId: "mmorpg:zombie",
      basic: "zombie_basic",
      summonType: "UNDEAD",
    }),
    summon_skeletons: summonSkill("summon_skeletons", {
      petId: "mmorpg:skeleton",
      basic: "skeleton_basic",
      summonType: "UNDEAD",
    }),
    // A burst summon: exempt from the cull, bounded by its lifespan against its own cooldown.
    summon_spiders: summonSkill("summon_spiders", {
      petId: "mmorpg:spider",
      basic: "zombie_basic",
      summonType: "SPIDER",
      count: 2,
      lifeTicks: 400,
      countsTowardsMax: false,
      cooldownTicks: 200,
    }),
    summon_golem: summonSkill("summon_golem", {
      petId: "mmorpg:fire_golem",
      basic: "golem_basic",
      summonType: "GOLEM",
      golem: true,
      summonSpells: ["fire_nova"],
      summonSpellChance: 0,
      summonSpellCdTicks: 20,
    }),
  },
};

function run(main: string, stats: Record<string, unknown>[] = []) {
  const snapshot = engineSnapshot({
    ...REGISTRIES,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("max_undead_summons", "FLAT", 3),
        exact("max_spider_summons", "FLAT", 3),
        exact("max_golem_summons", "FLAT", 1),
        ...stats,
      ]),
    },
  });
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: main, main: true }],
  } as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result, `${main} produced no result`);
  return result;
}

test("a pet's swing is counted, though nothing casts its basic attack", () => {
  // `PetAttackUTIL` runs `tryActivate(DEFAULT_EN_NAME, onHit(...))`, so the pet's group is entered
  // directly. Walked from `on_cast` — which is empty — all seventeen pet basics in the pack
  // reported zero sources and their one real group as unreachable.
  const result = run("summon_zombie");
  assert.equal(result.dps, 0, "the summoning skill itself declares no damage act");
  assert.equal(result.summons.length, 1);
  assert.ok(result.summonDps > 0, "and all of its output is the pets");
  assert.equal(result.summons[0]!.basicSpellId, "zombie_basic");
});

test("a melee pet swings once a second and a skeleton every 1.5", () => {
  // `MeleeAttackGoal` resets to 20 ticks. `RangedBowAttackGoal` counts down from the 10 the mod
  // passes and then spends 20 more drawing the bow, and only `SkeletonSummon` is ranged.
  closeTo(run("summon_zombie").summons[0]!.attackSeconds, 1);
  assert.equal(run("summon_zombie").summons[0]!.attackKind, "melee");

  closeTo(run("summon_skeletons").summons[0]!.attackSeconds, 1.5);
  assert.equal(run("summon_skeletons").summons[0]!.attackKind, "ranged");
});

test("the pet count is the type cap, and the cap comes off the sheet", () => {
  // `updatePlayerSummons` culls oldest-first down to `BONUS_TOTAL_SUMMONS`, which the
  // `max_<type>_summons` stats write into through `add_total_summons` on `on_spell_stat_calc`.
  const base = run("summon_zombie");
  assert.equal(base.summons[0]!.count, 3, "the base sheet's three undead");
  assert.equal(base.summons[0]!.capped, true);

  const more = run("summon_zombie", [exact("max_undead_summons", "FLAT", 2)]);
  assert.equal(more.summons[0]!.count, 5, "and a stat that raises it raises the count");
  closeTo(more.summonDps / base.summonDps, 5 / 3, "which is the whole of the difference");
});

test("a pet that counts against no cap is bounded by its lifespan instead", () => {
  // `counts_towards_max_summons: false` skips the cull entirely, so what limits it is how long a
  // pet lives against how often the button comes back: 20s of life, a 10s cycle, two at a time.
  const result = run("summon_spiders");
  const pets = result.summons[0]!;
  assert.equal(pets.capped, false);
  closeTo(pets.lifeSeconds, 20);
  // The cycle is the 10s cooldown plus the cast that arms it, so it is a shade under two full
  // waves rather than exactly two — 20 / 10.05, twice over.
  closeTo(pets.count, 2 * (20 / 10.05), "just under two waves of the two each cast summons");
});

test("a golem's nova is capped by its attempt cooldown, not by how often it hits", () => {
  // The order in `tryCastOnHit` is the whole of this: the cooldown is stamped *before* the roll,
  // so a pet hitting faster than the cooldown gets no extra chances. Computing `hits × chance`
  // and capping afterwards gives the same answer only when the two rates coincide, and
  // over-reports every melee pet whose swing is quicker than its cooldown.
  const result = run("summon_golem", [exact("golem_spell_chance", "FLAT", 10)]);
  const pets = result.summons[0]!;
  assert.equal(pets.count, 1, "one golem");
  assert.equal(pets.extraSpells.length, 1);

  const nova = pets.extraSpells[0]!;
  assert.deepEqual(nova.spellIds, ["fire_nova"]);
  // `summon_spell_chance` is 0 on all three of the pack's golems, so the stat is the whole of it.
  // The real base sheet grants 10 to every character; this one grants only what is passed.
  closeTo(nova.chance, 10);
  // One attempt a second — the swing and the cooldown are both 20 ticks — at 10%.
  closeTo(nova.perSecond, 0.1);
  closeTo(nova.dps, nova.damagePerCast * 0.1);
});

test("no golem spell chance means no attempt at all", () => {
  // `if (chance < 1) return;` sits before `setOnCooldown`, so this is not an unlucky pet — the
  // nova is not part of the build. A summon skill with no `summon_spells` is the same answer.
  const none = run("summon_golem", [exact("golem_spell_chance", "FLAT", -100)]);
  assert.deepEqual(none.summons[0]!.extraSpells, []);
  assert.deepEqual(run("summon_zombie").summons[0]!.extraSpells, []);
});

test("a pet's bite scales with the summoner's sheet, because the summoner casts it", () => {
  // `new SpellCastContext(caster, 0, basic)` is built from the summoner, so a pet is a spell of
  // yours rather than a second character. `summon_damage` is an ordinary datapack stat gated on
  // `spell_has_tag_summon`, and every pet basic carries that tag.
  const base = run("summon_zombie");
  const buffed = run("summon_zombie", [exact("summon_damage", "FLAT", 100)]);
  closeTo(
    buffed.summons[0]!.damagePerAttack / base.summons[0]!.damagePerAttack,
    2,
    "100% increased summon damage doubles the bite, off the player's own sheet",
  );
});
