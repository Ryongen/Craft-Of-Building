/**
 * A hit you inflict on yourself.
 *
 * Ten spells in this pack declare a `damage` act at a `self` selector and charge you for the
 * cast — `asura` takes 50% of your health plus 50% of your magic shield. Until this existed the
 * model resolved those acts against the *enemy*, which produced a number about nothing: it was
 * already excluded from DPS, so nothing on screen was wrong, and nothing on screen was right
 * either.
 *
 * Three rules make it different from every other hit and all three are the game's:
 *
 *  - the mitigation layers read **your** sheet;
 *  - `no_attacker_stats_on_selfdmg` fires `disable_attacker_stats` on `on_damage_init`, so the
 *    attacker half of the sweep never runs — no `attack_damage`, and no crit;
 *  - `DamageEvent.canAvoidHit()` is `source != target`, so dodge and block are skipped while
 *    mitigation is not.
 *
 * Pinned against the game's own damage log for `asura` on the 2026-09-17 capture: base 1531,
 * `[Target] Additive Damage x1.08`, `Armor Mitigation x0.93`, `Physical Mitigation x0.89`,
 * final 1370 — reproduced to the digit, with the dodge layer correctly absent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  damageStat,
  effectBlock,
  engineSnapshot,
  exact,
  modifyLayer,
  spellEntry,
  valueCalcEntry,
} from "../test-support.js";
import { simulateHit } from "./simulate.js";

/** The pack's own stat, wired exactly as `mmorpg_stat/no_attacker_stats_on_selfdmg.json` has it. */
const NO_ATTACKER_STATS = {
  base: 0,
  min: 0,
  max: 1,
  is_perc: false,
  multiUseType: "MULTIPLY_STAT",
  scaling: "NONE",
  effect: [
    effectBlock(
      "data_modification",
      ["disable_attacker_stats"],
      ["spell_has_tag_self_damage", "source_is_target"],
      "Source",
      ["on_damage_init"],
    ),
  ],
};

function scenario(granted: Record<string, unknown>[]) {
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: {
      // The self-damage tag is what the gate asks for; `asura` carries it alongside `finisher`.
      recoil: spellEntry("recoil", "Physical", "hit100", {
        config: { tags: { tags: ["damage", "self_damage"] }, use_support_gems_from: "" },
      }),
    },
    mmorpg_stat: {
      no_attacker_stats_on_selfdmg: { id: "no_attacker_stats_on_selfdmg", ser: "data", ...NO_ATTACKER_STATS },
      attack_damage: damageStat("attack_damage", {
        effect: [effectBlock("damage_layers", ["add_additive"], [], "Source")],
      }),
      dmg_received: damageStat("dmg_received", {
        effect: [effectBlock("damage_layers", ["add_additive"], [], "Target")],
      }),
    },
    mmorpg_stat_effect: {
      add_additive: modifyLayer("add_additive", "additive_damage"),
      disable_attacker_stats: { id: "disable_attacker_stats", ser: "disable_attacker_stats" },
    },
    mmorpg_stat_condition: {
      spell_has_tag_self_damage: condition("spell_has_tag_self_damage", "spell_has_tag", {
        tag: { id: "self_damage" },
      }),
      source_is_target: condition("source_is_target", "source_is_target"),
    },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", granted) },
  });
}

function build(): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "recoil", main: true }],
  } as BuildDoc;
}

const GRANTED = [
  exact("attack_damage", "FLAT", 50),
  exact("dmg_received", "FLAT", 8),
  exact("no_attacker_stats_on_selfdmg", "FLAT", 1),
];

test("an ordinary hit takes the attacker's stats and the enemy's sheet", () => {
  // The control. `dmg_received` sits on the *target*, and the declared enemy has none of it, so
  // only the attacker's 50% lands: 100 * 1.5.
  const result = simulateHit(build(), scenario(GRANTED));
  assert.ok(result);
  assert.equal(result.selfHit, false);
  closeTo(result.hit.total, 150);
});

test("a self-hit reads your sheet as the target and none of your offence as the source", () => {
  // `disable_attacker_stats` removes the Source side entirely, so `attack_damage` contributes
  // nothing; `dmg_received` is now on the target because the target is you: 100 * 1.08.
  const result = simulateHit(build(), scenario(GRANTED), { selfHit: true });
  assert.ok(result);
  assert.equal(result.selfHit, true);
  closeTo(result.hit.total, 108);
});

test("without the stat, a self-hit still takes the attacker's stats", () => {
  // The suppression is `no_attacker_stats_on_selfdmg`'s doing, not the self-hit's. Every
  // character in this pack has it as a base stat, but the two are separate mechanisms and a
  // model that conflated them would be right for the wrong reason.
  const without = GRANTED.filter((mod) => mod["stat"] !== "no_attacker_stats_on_selfdmg");
  const result = simulateHit(build(), scenario(without), { selfHit: true });
  assert.ok(result);
  // Both sides now apply, and both sides are the same sheet: 100 * (1 + (50 + 8)/100).
  closeTo(result.hit.total, 158);
});

test("a self-hit cannot crit, because crit is an attacker stat", () => {
  const self = simulateHit(build(), scenario(GRANTED), { selfHit: true });
  assert.ok(self);
  assert.equal(self.critChance, 0);
  // And the averaged figure is therefore the plain one, not a blend of two identical branches
  // weighted by a chance the game never rolls.
  closeTo(self.average.total, self.hit.total);
});

test("dodge is skipped on a self-hit, and mitigation is not", () => {
  // `DamageEvent.canAvoidHit()` — `return source != target`, checked by `DodgeRating`,
  // `BlockChance` and `SpellDodgeEffect` before they roll. Present in
  // `Mine_and_Slash-1.20.1-6.4.13.jar`, not only in the fork checkout.
  //
  // This is the layer that was wrong before: with dodge applied, the `asura` self-hit came out
  // at 1268 against the game's 1370.
  const withDodge = [...GRANTED, exact("dodge", "FLAT", 400)];

  const spent = (doc: BuildDoc, selfHit: boolean): boolean => {
    const result = simulateHit(doc, scenario(withDodge), { selfHit, breakdown: true });
    assert.ok(result);
    const step = result.hit.trace?.steps.find((s) => s.layerId === "damage_block");
    return step !== undefined && step.before !== step.after;
  };

  // First prove the layer can be spent at all in this harness, or the assertion below would
  // pass for a build whose dodge never reached a sheet. An enemy holding 400 dodge takes a
  // damage_block multiplier on an ordinary hit.
  const dodgyEnemy = { ...build(), config: { enemy: { dodge: 400 } } } as BuildDoc;
  assert.equal(spent(dodgyEnemy, false), true, "the control must spend damage_block");

  // Now the same 400 dodge, on you, against your own recoil: refused.
  assert.equal(spent(build(), true), false, "a self-hit must not spend damage_block");

  // And the mitigation that is not avoidance still applies: 100 * 1.08, dodge or no dodge.
  const self = simulateHit(build(), scenario(withDodge), { selfHit: true });
  assert.ok(self);
  closeTo(self.hit.total, 108);
});

test("the gate is the spell's tag, so a self-hit from an untagged spell keeps its attacker", () => {
  // `spell_has_tag_self_damage` is half of the stat's `ifs`. A spell without the tag that
  // somehow hit its caster would take the full attacker sweep, which is what the data says.
  const snapshot = scenario(GRANTED);
  const spells = snapshot.registries["mmorpg_spells"];
  const untagged = spellEntry("plain", "Physical", "hit100");
  spells!["plain"] = { id: "plain", origin: "test", source: { kind: "pack", packId: "test" }, data: untagged };

  const doc = { ...build(), skills: [{ spellId: "plain", main: true }] } as BuildDoc;
  const result = simulateHit(doc, snapshot, { selfHit: true });
  assert.ok(result);
  closeTo(result.hit.total, 158);
});
