/**
 * Effective HP.
 *
 * The mitigation is the offensive pipeline with the sheets swapped, so these do not re-test the
 * layers — `simulate.test.ts` already pins those. What is new is the pools, the chaos bypass, and
 * the two avoidance stats that had no code-only effect until eHP needed them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  engineSnapshot,
  exact,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { defence } from "./defence.js";

/**
 * Gear bases carrying no stats of their own, so equipping one changes nothing but the slot.
 *
 * `BlockChance` gates on `instanceof ShieldItem`, which the engine answers from the base's
 * `shield` tag — so a test of that gate needs a real base to equip, and a two-handed one to
 * prove the offhand is emptied by it.
 */
const GEAR_TYPES = {
  test_shield: {
    guid: "test_shield",
    gear_slot: "shield",
    base_stats: [],
    tags: { tags: ["shield", "offhand_family"] },
  },
  test_tome: {
    guid: "test_tome",
    gear_slot: "tome",
    base_stats: [],
    tags: { tags: ["tome", "offhand_family"] },
  },
  test_greatsword: {
    guid: "test_greatsword",
    gear_slot: "sword",
    weapon_type: "sword",
    base_stats: [],
    tags: { tags: ["two_handed"] },
  },
};

const SHIELD = { base: "test_shield", rarity: "common", itemLevel: 1 };

/** A character whose whole sheet is the stats named. */
function character(stats: Record<string, number>, doc: Partial<BuildDoc> = {}) {
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
    mmorpg_base_gear_types: GEAR_TYPES,
    mmorpg_gear_slot: {
      shield: { id: "shield", fam: "OffHand" },
      tome: { id: "tome", fam: "OffHand" },
      sword: { id: "sword", fam: "Weapon", weapon_data: { damage_multiplier: 1 } },
    },
    mmorpg_gear_rarity: {
      common: {
        id: "common",
        stat_percents: { min: 0, max: 100 },
        base_stat_percents: { min: 0, max: 100 },
      },
    },
  });
  const build = {
    schemaVersion: 1,
    // Level 1 keeps the curves at `valueNeededAtLevelOne`, so 100 armour is exactly half
    // mitigation and the arithmetic on screen is the arithmetic in the test.
    character: { level: 1 },
    ...doc,
  } as BuildDoc;
  // The free starting resists would be noise in every assertion here.
  return defence(build, snapshot, { hitSize: 1000, newbieResists: false });
}

test("effective HP is the pool divided by what gets through", () => {
  // 50 fire resist halves a fire hit, so the same pool lasts twice as long against it. Nothing
  // else is set, so every other element takes the hit whole.
  const result = character({ health: 1000, fire_resist: 50 });

  const fire = result.byElement.find((e) => e.element === "Fire")!;
  const cold = result.byElement.find((e) => e.element === "Cold")!;

  closeTo(fire.taken, 0.5);
  closeTo(fire.effectiveHealth, 2000);
  closeTo(cold.taken, 1);
  closeTo(cold.effectiveHealth, 1000);
  assert.equal(result.weakest.effectiveHealth, Math.min(...result.byElement.map((e) => e.effectiveHealth)));
});

test("magic shield adds to the pool, and half of chaos walks past it", () => {
  // `MagicShield.modifyEntityDamage` takes the hit before health does, and
  // `CHAOS_BYPASS_PERCENT = 50` sends half a chaos hit straight to health. With a shield larger
  // than health the bypassing half is what kills you, so the chaos pool stops at twice health.
  const big = character({ health: 1000, magic_shield: 4000 });
  const chaos = big.byElement.find((e) => e.element === "Shadow")!;
  const fire = big.byElement.find((e) => e.element === "Fire")!;

  assert.equal(fire.pool, 5000, "everything but chaos gets the whole shield");
  assert.equal(chaos.pool, 2000, "min(health + shield, 2 x health)");

  // Below that crossover the shield empties first and the pool is simply the sum.
  const small = character({ health: 4000, magic_shield: 1000 });
  assert.equal(small.byElement.find((e) => e.element === "Shadow")!.pool, 5000);

  // The stat that turns the bypass off gives chaos the whole shield back.
  const held = character({ health: 1000, magic_shield: 4000, chaos_doesnt_bypass_magic_shield: 1 });
  assert.equal(held.byElement.find((e) => e.element === "Shadow")!.pool, 5000);
});

test("dodge is averaged rather than rolled, and only against physical hits", () => {
  // `DodgeRating` zeroes the hit on a roll; a figure averaged over many hits multiplies by
  // `1 - chance` instead. The curve is `points / (points + 100)` at level 1, so 100 dodge is 50%.
  const result = character({ health: 1000, dodge: 100 });

  const physical = result.byElement.find((e) => e.element === "Physical")!;
  const fire = result.byElement.find((e) => e.element === "Fire")!;

  closeTo(physical.taken, 0.5);
  closeTo(physical.effectiveHealth, 2000);
  closeTo(fire.taken, 1, "dodge never applies to an elemental hit");
});

test("a block stops `block_damage_reduction` of the hit, and that defaults to all of it", () => {
  // `applyBlock` reads `getBlockDamageReduction`, whose stat has **base 100** — so a blocked hit
  // is avoided outright unless something lowered it, and 40% block chance averages to 40% less.
  // The port this replaced reduced the suppression layer by a hardcoded 50 and called a block a
  // halving; there is no 50 in `BlockChance$Effect` in 6.4.13.
  const result = character({ health: 1000, block_chance: 40 }, { gear: [SHIELD] });
  const fire = result.byElement.find((e) => e.element === "Fire")!;

  closeTo(fire.taken, 0.6);
  closeTo(fire.effectiveHealth, 1000 / 0.6);
});

test("Glancing Strikes buys block frequency with block effectiveness", () => {
  // `mmorpg_perk/glancing_strikes.json` is `MORE block_chance +100`, `FLAT max_block_chance +15`,
  // `FLAT block_damage_reduction -65`. The stat is the whole reason `block_damage_reduction`
  // exists, and 35%-effective blocks are what the old hardcoded 50 was mistaking for the default.
  // The perk's own number, not the result: the stat starts at its base of 100 and the perk takes
  // 65 off it, so a FLAT -65 is what a Glancing sheet actually carries. A FLAT +35 would clamp
  // straight back to 100 against the stat's `max`, which is the game's behaviour too.
  const glancing = character(
    { health: 1000, block_chance: 40, block_damage_reduction: -65 },
    { gear: [SHIELD] },
  );
  closeTo(glancing.byElement.find((e) => e.element === "Fire")!.taken, 1 - 0.4 * 0.35);
});

test("block chance is capped at 75 until `max_block_chance` raises it", () => {
  // `getUsableValue` is `clamp((int) value, min, BASE_BLOCK_CAP + getAdditionalMax(unit)) / 100F`.
  // The sheet clamps to the stat's own `max` of 90 first, but 90 on the sheet is still only 75
  // where nothing raised the ceiling — which is the number the old `clamp(value, 0, 100)` missed.
  const bare = character({ health: 1000, block_chance: 100 }, { gear: [SHIELD] });
  closeTo(bare.byElement.find((e) => e.element === "Fire")!.taken, 0.25);

  // Unlike a resist there is no outer clamp to 90 on the *ceiling*; `max_block_chance` adds to it
  // directly, and its own `max` of 15 is what stops block at 90 rather than any rule here.
  const raised = character(
    { health: 1000, block_chance: 100, max_block_chance: 15 },
    { gear: [SHIELD] },
  );
  closeTo(raised.byElement.find((e) => e.element === "Fire")!.taken, 0.1);
});

test("block does nothing without a shield in the offhand, and says so", () => {
  // `canActivate`: `effect.target.getOffhandItem().getItem() instanceof ShieldItem`. Block chance
  // rolls on gear and on the tree, so a build can carry a large one and block nothing at all —
  // the figure has to refuse it rather than quietly counting it.
  const bare = character({ health: 1000, block_chance: 40 });
  closeTo(bare.byElement.find((e) => e.element === "Fire")!.taken, 1);
  assert.ok(bare.diagnostics.some((d) => d.code === "block-needs-shield"));

  // A tome fills the same slot and is not a `ShieldItem` — `Tome0Item` extends plain `Item`.
  const tome = character(
    { health: 1000, block_chance: 40 },
    { gear: [{ base: "test_tome", rarity: "common", itemLevel: 1 }] },
  );
  closeTo(tome.byElement.find((e) => e.element === "Fire")!.taken, 1);

  // Better Combat returns `ItemStack.EMPTY` for the offhand while a two-handed weapon is held, so
  // `GearData` reads no shield even though the document lists one.
  const twoHanded = character(
    { health: 1000, block_chance: 40 },
    { gear: [SHIELD, { base: "test_greatsword", rarity: "common", itemLevel: 1 }] },
  );
  closeTo(twoHanded.byElement.find((e) => e.element === "Fire")!.taken, 1);

  // And with the shield alone it works, so the three above are the gate and not a broken fixture.
  const armed = character({ health: 1000, block_chance: 40 }, { gear: [SHIELD] });
  closeTo(armed.byElement.find((e) => e.element === "Fire")!.taken, 0.6);
  assert.ok(!armed.diagnostics.some((d) => d.code === "block-needs-shield"));
});

test("the maximum hit assumes every avoidance roll failed", () => {
  // The two figures answer different questions and a build can be comfortable on one and dead on
  // the other. 100 dodge is a 50% chance, so the *average* physical hit is halved and the
  // *largest survivable* one is not reduced at all — you cannot spend a dodge chance on the hit
  // that kills you.
  const dodged = character({ health: 1000, dodge: 100 });
  const physical = dodged.byElement.find((e) => e.element === "Physical")!;

  closeTo(physical.effectiveHealth, 2000);
  closeTo(physical.takenUnavoided, 1);
  closeTo(physical.maximumHit, 1000, "dodge buys nothing against a single hit");

  // Block is the same rule: a roll you cannot spend on the hit that kills you. At the default
  // `block_damage_reduction` of 100 it is avoidance outright, so it buys exactly nothing against
  // a single hit — the same shape as dodge, not the halving the old port reported.
  const blocking = character({ health: 1000, block_chance: 40 }, { gear: [SHIELD] });
  const fire = blocking.byElement.find((e) => e.element === "Fire")!;
  closeTo(fire.effectiveHealth, 1000 / 0.6);
  closeTo(fire.maximumHit, 1000);

  // Mitigation is not a roll, so it is in both. 50 fire resist halves the hit either way.
  const resisted = character({ health: 1000, fire_resist: 50 });
  const resistedFire = resisted.byElement.find((e) => e.element === "Fire")!;
  closeTo(resistedFire.effectiveHealth, 2000);
  closeTo(resistedFire.maximumHit, 2000, "a resist applies to every hit, including the big one");

  // With neither avoidance stat the two figures are the same number, which is what makes the gap
  // between them readable as "this much of my defence is luck".
  assert.equal(resistedFire.maximumHit, resistedFire.effectiveHealth);
});

test("the most fragile element is picked on the maximum hit, not on effective HP", () => {
  // Dodge is physical-only, so a character carrying their physical defence on it has their
  // *average* softest spot somewhere else and their *one-shot* softest spot on physical. Fire
  // resist is set high enough that fire wins on neither.
  const result = character({ health: 1000, dodge: 300, fire_resist: 60 });

  assert.equal(result.weakest.element, "Cold", "averaged, dodge carries physical past cold");
  assert.equal(result.mostFragile.element, "Physical", "unavoided, dodge carries nothing");
  assert.equal(
    result.mostFragile.maximumHit,
    Math.min(...result.byElement.map((e) => e.maximumHit)),
  );
});

test("a flat reduction is worth less against a bigger hit, so the hit size is stated", () => {
  // `damage_shield` writes to `flat_damage_reduction`, an ADD layer. There is no single answer to
  // "how much of a hit do I take" when part of the mitigation is flat, so the size is an input and
  // it is reported back.
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("health", "FLAT", 1000),
        exact("damage_shield", "FLAT", 100),
      ]),
    },
  });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;

  const small = defence(build, snapshot, { hitSize: 200, newbieResists: false });
  const large = defence(build, snapshot, { hitSize: 2000, newbieResists: false });

  closeTo(small.byElement[0]!.taken, 0.5);
  closeTo(large.byElement[0]!.taken, 0.95);
  assert.equal(small.hitSize, 200);
  assert.equal(large.hitSize, 2000);
});

test("mana absorption is reported beside the figure, never folded into it", () => {
  // It is a buffer of half your mana that drains at a fixed percent, and how full it is when a hit
  // lands depends on regeneration between hits — which no build document states.
  // `mana_shield`, which is `DamageAbsorbedByMana.GUID` — the id the game uses, and the only
  // one a resolved sheet ever holds. This read `damage_absorbed_by_mana`, a name that exists
  // nowhere in the mod, and passed only because the sheet below is synthetic enough to invent it.
  const result = character({ health: 1000, mana: 600, mana_shield: 20 });

  assert.equal(result.pools.manaAbsorb.percent, 20);
  assert.equal(result.pools.manaAbsorb.buffer, 300);
  closeTo(result.byElement[0]!.effectiveHealth, 1000, "the headline figure is pools only");
  assert.ok(result.diagnostics.some((d) => d.code === "mana-absorb-not-in-ehp"));
});

test("the attacker's accuracy is taken off your dodge, and its penetration off your resists", () => {
  // `MobStatUtils.getMobBaseStats` gives a mob `scaleTo(1, FLAT, accuracy, lvl)` and nothing else
  // offensive, so `buildTargetEnemy` fills accuracy and leaves penetration at zero. A mob that
  // pierces is carrying a map affix, which is a number to state rather than one to invent — these
  // pin what happens once you state it.
  const withAttacker = (offence: Record<string, unknown>) => {
    const snapshot = engineSnapshot({
      // `accuracy` is a datapack stat whose Source-side block writes `EVENT.ACCURACY`; the
      // penetrations are in-code and need no entry.
      mmorpg_stat: {
        accuracy: statEntry("accuracy", {
          effect: [
            {
              effects: ["set_data_num_accuracy"],
              events: ["on_damage"],
              ifs: [],
              order: "before_hit_prevention",
              side: "Source",
            },
          ],
        }),
      },
      mmorpg_stat_effect: {
        set_data_num_accuracy: {
          id: "set_data_num_accuracy",
          ser: "set_data_number",
          num_id: "accuracy",
        },
      },
      mmorpg_base_stats: {
        original_mode_player: baseStats("original_mode_player", [
          exact("health", "FLAT", 1000),
          exact("dodge", "FLAT", 100),
          exact("fire_resist", "FLAT", 50),
        ]),
      },
    });
    const build = {
      schemaVersion: 1,
      character: { level: 1 },
      config: { enemy: { level: 1, offence } },
    } as BuildDoc;
    return defence(build, snapshot, { hitSize: 1000, newbieResists: false });
  };

  const bare = withAttacker({});
  const physical = (r: ReturnType<typeof withAttacker>) =>
    r.byElement.find((e) => e.element === "Physical")!;
  const fire = (r: ReturnType<typeof withAttacker>) => r.byElement.find((e) => e.element === "Fire")!;

  // 100 dodge at level 1 is `100 / (100 + 100)` = half the hits.
  closeTo(physical(bare).taken, 0.5);
  // `clamp(dodge - ACCURACY, 0, MAX)`: 50 accuracy leaves 50 dodge, which is `50 / 150`.
  closeTo(physical(withAttacker({ accuracy: 50 })).taken, 1 - 50 / 150);
  // Enough accuracy and dodge stops working entirely.
  closeTo(physical(withAttacker({ accuracy: 100 })).taken, 1);

  // Penetration comes off the raw resist before its clamp, so 50 resist against 25 penetration
  // mitigates as 25 would.
  closeTo(fire(bare).taken, 0.5);
  closeTo(fire(withAttacker({ penetration: { fire: 25 } })).taken, 0.75);
});

test("the second hit is not answered until a document states one", () => {
  // The property the whole incoming model rests on. Unset is the state every existing document,
  // capture and fixture is in, so nothing about them can move — and the reason is reported
  // rather than left as a blank card, naming both fields because filling in one alone still
  // produces nothing.
  const none = character({ health: 1000 });
  assert.equal(none.overTime, undefined);
  assert.ok(none.diagnostics.some((d) => d.code === "incoming-hit-unstated"));

  const halfStated = character(
    { health: 1000 },
    { config: { enemy: { level: 1, offence: { vanillaAttackDamage: 3 } } } } as Partial<BuildDoc>,
  );
  assert.equal(halfStated.overTime, undefined, "a hit with no clock is still no answer");

  const rateOnly = character(
    { health: 1000 },
    { config: { enemy: { level: 1, offence: { attacksPerSecond: 1 } } } } as Partial<BuildDoc>,
  );
  assert.equal(rateOnly.overTime, undefined, "a clock with no hit is no answer either");
});

test("a stated attacker gives the drain, the sustain and the hits survived", () => {
  // A zombie's 3.0 at level 1 is `(3 * 0.33 / 100) + 6 = 6.0099`, and the level curve is the
  // identity at level 1. The event's level exponent is not: `2.2 * 1.01114^1`. Common rarity is
  // x1. With no armour and no resists the whole of it arrives.
  const hit = 6.0099 * 2.2 * 1.01114;
  const result = character(
    { health: 1000 },
    {
      config: {
        enemy: { level: 1, offence: { vanillaAttackDamage: 3, attacksPerSecond: 1 } },
      },
    } as Partial<BuildDoc>,
  );

  const over = result.overTime;
  assert.ok(over !== undefined, "both halves stated, so there is an answer");
  closeTo(over.ratePerSecond, 1);
  closeTo(over.rawPerHit, hit);

  const physical = over.byElement.find((e) => e.element === "Physical")!;
  closeTo(physical.perHit, hit, "nothing mitigates it on a bare sheet");
  closeTo(physical.perSecond, hit, "one swing a second");

  // No regeneration on this sheet, so the net loss is the whole drain and the pool is the 1000
  // health. `selfSustain` does this walk; this pins that the two are wired together rather than
  // that it works, which `self-sustain.test.ts` already covers.
  closeTo(physical.sustain.netLossPerSecond, hit);
  closeTo(physical.sustain.secondsToDeath, 1000 / hit);
  closeTo(physical.hitsSurvived, 1000 / hit, "at one swing a second the two are the same number");
});

test("the rate multiplies the drain but not the hit, and mitigation applies to both", () => {
  const of = (attacksPerSecond: number, armor = 0) =>
    character(
      { health: 1000, armor },
      {
        config: {
          enemy: { level: 1, offence: { vanillaAttackDamage: 3, attacksPerSecond } },
        },
      } as Partial<BuildDoc>,
    ).overTime!.byElement.find((e) => e.element === "Physical")!;

  const once = of(1);
  const twice = of(2);
  closeTo(twice.perHit, once.perHit, "a faster mob does not hit harder");
  closeTo(twice.perSecond, once.perSecond * 2);
  closeTo(twice.hitsSurvived, once.hitsSurvived, "twice as fast, half as long, same hit count");

  // 100 armour at level 1 is exactly half mitigation — the same figure the eHP tests use — so
  // the drain halves and the hits survived double.
  const armoured = of(1, 100);
  closeTo(armoured.perHit, once.perHit / 2);
  closeTo(armoured.hitsSurvived, once.hitsSurvived * 2);
});

/** A sheet carrying a `Target`-side `proc_spell` — "when you are hit, cast this". */
function defensiveProcSnapshot(ifs: string[] = ["random_roll"]) {
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: {
      quake: spellEntry("quake", "Physical", "hit100", {
        config: {
          tags: { tags: [] },
          use_support_gems_from: "",
          cooldown_ticks: 0,
          cast_time_ticks: 20,
          proc_cooldown_ticks: 20,
        },
      }),
    },
    mmorpg_stat: {
      proc_quake_when_hit: statEntry("proc_quake_when_hit", {
        effect: [
          {
            effects: ["proc_spell_quake"],
            events: ["on_damage"],
            ifs,
            order: "final_damage",
            side: "Target",
          },
        ],
      }),
    },
    mmorpg_stat_effect: {
      proc_spell_quake: { id: "proc_spell_quake", ser: "proc_spell", spellId: "quake", pos: "CASTER" },
    },
    mmorpg_stat_condition: { random_roll: condition("random_roll", "random_roll") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("health", "FLAT", 1000),
        exact("proc_quake_when_hit", "FLAT", 50),
      ]),
    },
  });
}

test("a defensive proc gets a real rate once the document says how often you are hit", () => {
  // `proc_quake_when_hit` is a `Target`-side block: the enemy's hit on *you* is what triggers it,
  // so its chance has always fallen out of the sweep and only its rate was missing. That is the
  // whole of what `when-hit` meant.
  const snapshot = defensiveProcSnapshot();
  const doc = (offence: Record<string, number>) =>
    ({
      schemaVersion: 1,
      character: { level: 1 },
      config: { enemy: { level: 1, offence } },
    }) as BuildDoc;

  const unstated = defence(doc({}), snapshot, { hitSize: 1000, newbieResists: false });
  assert.equal(unstated.overTime, undefined, "no attacker, no rate, no answer");

  const stated = defence(
    doc({ vanillaAttackDamage: 3, attacksPerSecond: 2 }),
    snapshot,
    { hitSize: 1000, newbieResists: false },
  );
  const proc = stated.overTime!.procs.find((p) => p.spellId === "quake");
  assert.ok(proc !== undefined, "the sweep reached the block and the rate resolved it");
  assert.equal(proc.limit, undefined, "no longer limited — it has a clock now");
  closeTo(proc.triggersPerSecond, 2, "the enemy's swings, not yours");
  closeTo(proc.chance, 0.5);
  closeTo(proc.perSecond, 1, "two hits a second at a 50% roll");
});

test("a proc gated on the block or the dodge stays unrated, and says why", () => {
  // The avoidance branch is a third clock. Block, dodge and spell dodge are folded into one
  // avoidance outcome by the sweep, and separating them would mean re-deriving the `DodgeRating`
  // and `SpellDodgeEffect` curves inside the defence pass — against the premise that nothing
  // here re-derives what the sweep already answered. So it keeps its reason rather than taking
  // a rate that would silently be the wrong one.
  const snapshot = defensiveProcSnapshot(["random_roll", "is_is_blocked_true"]);
  const stated = defence(
    {
      schemaVersion: 1,
      character: { level: 1 },
      config: { enemy: { level: 1, offence: { vanillaAttackDamage: 3, attacksPerSecond: 2 } } },
    } as BuildDoc,
    snapshot,
    { hitSize: 1000, newbieResists: false },
  );

  const proc = stated.overTime!.procs.find((p) => p.spellId === "quake");
  assert.ok(proc !== undefined, "still listed — a proc you cannot rate is not a proc you hide");
  assert.equal(proc.limit, "when-hit");
  closeTo(proc.perSecond, 0);
});

test("a receive chance on your own sheet means the enemy's hit bleeds you", () => {
  // The defensive half of `AilmentReceiveChance`, and the reason `corporeal_respite` is a
  // trade rather than a free 50% physical damage reduction: it grants the *player* 100% bleed
  // receive chance. A bare mob rolls no `bleed_chance` of its own, so before this every figure
  // said that effect cost nothing at all.
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("health", "FLAT", 1000),
        exact("bleed_receive_chance", "FLAT", 100),
      ]),
    },
  });
  const doc = {
    schemaVersion: 1,
    character: { level: 1 },
    config: { enemy: { level: 1, offence: { vanillaAttackDamage: 3, attacksPerSecond: 1 } } },
  } as BuildDoc;

  const bled = defence(doc, snapshot, { hitSize: 1000, newbieResists: false }).overTime!.ailments;
  const bleed = bled.find((a) => a.ailment === "bleed");
  assert.ok(bleed !== undefined, "the hit is physical and you take bleed at 100%");
  closeTo(bleed.chance, 1);
  assert.ok(bleed.damagePerSecond > 0, "a bleed that ticks for nothing would not be a cost");

  // Without the stat there is nothing: the attacker has no ailment chance of its own.
  const clean = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("health", "FLAT", 1000)]),
    },
  });
  assert.deepEqual(
    defence(doc, clean, { hitSize: 1000, newbieResists: false }).overTime!.ailments,
    [],
  );
});
