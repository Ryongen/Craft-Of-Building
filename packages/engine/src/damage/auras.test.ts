/**
 * An aura's damage, which is not reachable from the button that puts it up.
 *
 * Holy Fire is the case that made this exist. Its spell declares no `damage` act at all — the
 * `on_cast` tree is a two-branch toggle that throws a marker projectile, and the marker grants
 * the `holy_fire` exile effect, whose own component group is what pulses. So the model walked
 * the cast, found nothing, and reported 0 DPS for a skill the tooltip describes as damaging
 * "nearby enemies every 0.5s".
 *
 * The toggle is the part that makes entering from the cast impossible rather than merely
 * awkward: the granting branch is gated on `caster_has_mns_effect { holy_fire, is_false: true }`,
 * so on a character who *has* the aura up — the only character the question is about — that
 * branch is correctly blocked and the branch that *removes* it is the live one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  engineSnapshot,
  exact,
  valueCalcEntry,
} from "../test-support.js";
import { simulateDps } from "./dps.js";

/** The aura's own component group: a pulse at the enemy and a pulse at yourself, every 10 ticks. */
function auraEffect(id: string, selfToo: boolean): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [
    {
      acts: [{ type: "damage", map: { element: "Fire", value_calculation: `${id}_hit` } }],
      ifs: [{ type: "x_ticks_condition", map: { tick_rate: 10 } }],
      en_preds: [],
      targets: [{ type: "aoe", map: { radius: 2.5, selection_type: "RADIUS", en_predicate: "enemies" } }],
    },
  ];
  if (selfToo) {
    parts.push({
      acts: [
        {
          type: "damage",
          map: { element: "Fire", allow_self_damage: true, value_calculation: `${id}_self` },
        },
      ],
      ifs: [{ type: "x_ticks_condition", map: { tick_rate: 10 } }],
      en_preds: [],
      targets: [{ type: "self", map: {} }],
    });
  }
  return {
    id,
    type: "beneficial",
    max_stacks: 1,
    one_of_a_kind_id: "aura",
    stacks_affect_stats: true,
    mc_stats: [],
    stats: [],
    tags: { tags: ["aura"] },
    spell_tags: { tags: [id, "self_damage"] },
    spell: { on_cast: [], entity_components: { default_entity_name: parts } },
  };
}

/**
 * The toggle, written exactly as `holy_fire`'s is: a marker projectile per branch, each gated on
 * whether you already hold the effect, granting it for `potion_dur: -1` when its branch is live.
 */
function toggleSpell(id: string, effectId: string): Record<string, unknown> {
  const marker = (entityName: string, negated: boolean): Record<string, unknown> => ({
    acts: [
      {
        type: "projectile",
        map: {
          entity_name: entityName,
          proj_count: 1,
          proj_speed: 0,
          life_ticks: 1,
          proj_en: "mmorpg:spell_projectile",
        },
      },
    ],
    ifs: [
      { type: "on_spell_cast", map: {} },
      {
        type: "caster_has_mns_effect",
        map: negated ? { exile_potion_id: effectId, is_false: true } : { exile_potion_id: effectId },
      },
    ],
    en_preds: [],
    targets: [{ type: "self", map: {} }],
  });

  const grant = (action: string, dur: number): Record<string, unknown> => ({
    acts: [
      {
        type: "exile_effect",
        map: { count: 1, exile_potion_id: effectId, potion_action: action, potion_dur: dur },
      },
    ],
    ifs: [{ type: "on_entity_expire", map: {} }],
    en_preds: [],
    targets: [{ type: "self", map: {} }],
  });

  return {
    identifier: id,
    min_lvl: 1,
    max_lvl: 16,
    default_lvl: 1,
    lvl_based_on_spell: "",
    statsForSkillGem: [],
    config: {
      tags: { tags: ["magic", "aura", "damage", "self_damage"] },
      use_support_gems_from: "",
      cast_speed_ticks: 10,
      cast_time_ticks: 10,
      cooldown_ticks: 40,
    },
    attached: {
      on_cast: [
        marker("stack_adder", true),
        marker("stack_remover", false),
      ],
      entity_components: {
        stack_adder: [grant("GIVE_STACKS", -1)],
        stack_remover: [grant("REMOVE_STACKS", 20)],
      },
    },
  };
}

function scenario(selfToo = true) {
  return engineSnapshot({
    mmorpg_value_calc: {
      pulse_hit: valueCalcEntry("pulse_hit", { min: 100, max: 100 }),
      pulse_self: valueCalcEntry("pulse_self", { min: 40, max: 40 }),
    },
    mmorpg_spells: { pulse_aura: toggleSpell("pulse_aura", "pulse") },
    mmorpg_exile_effect: { pulse: auraEffect("pulse", selfToo) },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", [exact("health", "FLAT", 1000)]) },
  });
}

function build(): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "pulse_aura", level: 1, main: true }],
  } as BuildDoc;
}

test("an aura's pulse is counted even though its granting branch is blocked", () => {
  const result = simulateDps(build(), scenario());
  assert.ok(result);

  // The cast walk on its own finds nothing: the grant is gated on not already holding the aura,
  // and the aura is up. That is the game, and it is why this cannot be reached from `on_cast`.
  const fromCast = result.sources.filter((s) => !s.source.id.startsWith("effect:"));
  assert.equal(fromCast.length, 0, "the toggle's own branches declare no damage act");

  const pulse = result.sources.find((s) => s.source.id === "effect:pulse:default_entity_name#0");
  assert.ok(pulse, "the aura's enemy pulse must be a source");
  assert.equal(pulse.source.carrier.kind, "effect");
});

test("a permanent aura's damage per second does not depend on the cycle it is priced over", () => {
  // The whole justification for giving a permanent effect a life of exactly one cast cycle. If
  // the answer moved when the cooldown moved, the choice of cycle would be doing the work.
  const slow = scenario();
  const fast = scenario();
  const config = (snap: ReturnType<typeof scenario>, ticks: number): void => {
    const spell = snap.registries["mmorpg_spells"]!["pulse_aura"]!.data as Record<string, unknown>;
    (spell["config"] as Record<string, unknown>)["cooldown_ticks"] = ticks;
  };
  config(slow, 400);
  config(fast, 40);

  const a = simulateDps(build(), slow);
  const b = simulateDps(build(), fast);
  assert.ok(a && b);
  assert.ok(a.dps > 0, "an aura that pulses must deal damage");
  closeTo(a.dps, b.dps, "damage per second must be the same however the cycle is read");
});

test("the self-targeted pulse is self-damage, not damage to the enemy", () => {
  const result = simulateDps(build(), scenario(true));
  assert.ok(result);
  assert.ok(result.selfDamage, "an aura that damages its holder must report self-damage");
  assert.ok(result.selfDamage.perSecond > 0);

  // And it is not netted off the figure the enemy feels, in either direction.
  const self = result.sources.find((s) => s.source.target?.kind === "self");
  assert.ok(self);
  assert.equal(self.coverage.hitsPerCast, 0, "a `self` selector reaches no enemy");
  assert.equal(self.damagePerCast, 0);
});

test("an aura with no self-targeted act reports no self-damage", () => {
  const result = simulateDps(build(), scenario(false));
  assert.ok(result);
  assert.equal(result.selfDamage, undefined);
});

test("an aura the build is not running contributes nothing", () => {
  const snapshot = scenario();
  const doc = { ...build(), config: { effects: { pulse: false } } } as BuildDoc;
  const result = simulateDps(doc, snapshot);
  assert.ok(result);
  assert.equal(
    result.sources.filter((s) => s.source.id.startsWith("effect:")).length,
    0,
    "an effect that is switched off is not a source",
  );
});
