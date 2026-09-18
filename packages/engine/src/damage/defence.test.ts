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

import { baseStats, closeTo, engineSnapshot, exact, statEntry } from "../test-support.js";
import { defence } from "./defence.js";

/** A character whose whole sheet is the stats named. */
function character(stats: Record<string, number>, doc: Partial<BuildDoc> = {}) {
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
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

test("block halves a hit on a chance; it does not avoid one", () => {
  // `BlockChance` reduces the suppression layer by 50, and that layer floors at 0.5 — so a block
  // is exactly half the hit, and 40% block chance averages to 20% less damage taken.
  const result = character({ health: 1000, block_chance: 40 });
  const fire = result.byElement.find((e) => e.element === "Fire")!;

  closeTo(fire.taken, 0.8);
  closeTo(fire.effectiveHealth, 1250);

  // Even at the stat's own ceiling it is a halving, never an avoidance. That ceiling is 90, not
  // the 75 `BASE_BLOCK_CAP` suggests — `code-only-behaviour.ts` carries the override.
  const capped = character({ health: 1000, block_chance: 100 });
  closeTo(capped.byElement.find((e) => e.element === "Fire")!.taken, 0.55);
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

  // Block is the same rule and a different shape: it halves a hit rather than avoiding one, so a
  // blocked hit is a real outcome and the worst case is simply the unblocked one.
  const blocking = character({ health: 1000, block_chance: 40 });
  const fire = blocking.byElement.find((e) => e.element === "Fire")!;
  closeTo(fire.effectiveHealth, 1250);
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
  const result = character({ health: 1000, mana: 600, damage_absorbed_by_mana: 20 });

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
