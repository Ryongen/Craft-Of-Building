/**
 * `potion_dur` after the `on_exile_effect` sweep.
 *
 * The arithmetic is `increase_number`'s — additive off the *original* number, never compounding
 * — and the gate is `effect_has_tag_<tag>` against the effect being applied. Both are quoted in
 * `effect-duration.ts`; these pin what falls out of them, including the two cases the sweep has
 * to refuse: a toggle's `-1`, and a tag the effect does not carry.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { balance } from "../balance.js";
import { ORIGINAL_MODE } from "../compat.js";
import { statIndex } from "../stat-def.js";
import { engineSnapshot, statEntry } from "../test-support.js";
import type { Sheet } from "./ctx.js";
import { effectDurationTicks } from "./effect-duration.js";
import type { EffectState } from "./effect-state.js";
import { layerIndex } from "./layers.js";

/** `increase_effect_duration_ticks_num` and a stat that fires it, optionally behind a tag gate. */
function durationStat(id: string, tag?: string): Record<string, unknown> {
  return statEntry(id, {
    is_perc: true,
    effect: [
      {
        effects: ["increase_effect_duration_ticks_num"],
        events: ["on_exile_effect"],
        ifs: tag === undefined ? [] : [`effect_has_tag_${tag}`],
        order: "data_modification",
        side: "Source",
      },
    ],
  });
}

const REGISTRIES = {
  mmorpg_stat_effect: {
    increase_effect_duration_ticks_num: {
      id: "increase_effect_duration_ticks_num",
      num_id: "effect_duration_ticks",
      ser: "increase_number",
    },
  },
  mmorpg_stat_condition: {
    effect_has_tag_positive: { id: "effect_has_tag_positive", ser: "effect_has_tag", tag: "positive" },
    effect_has_tag_curse: { id: "effect_has_tag_curse", ser: "effect_has_tag", tag: "curse" },
  },
  mmorpg_stat: {
    eff_dur_u_cast: durationStat("eff_dur_u_cast"),
    positive_eff_dur_u_cast: durationStat("positive_eff_dur_u_cast", "positive"),
    curse_eff_dur_u_cast: durationStat("curse_eff_dur_u_cast", "curse"),
  },
  mmorpg_exile_effect: {
    protection: {
      id: "protection",
      type: "beneficial",
      max_stacks: 1,
      mc_stats: [],
      one_of_a_kind_id: "",
      spell_tags: { tags: [] },
      stacks_affect_stats: true,
      stats: [],
      tags: { tags: ["positive", "defensive"] },
    },
  },
};

const SNAPSHOT = engineSnapshot(REGISTRIES);

function ticks(stats: Record<string, number>, baseTicks = 12000): number {
  const sheet: Sheet = new Map(
    Object.entries(stats).map(([id, value]) => [id, { id, value, dmgMulti: 1 } as never]),
  );
  return effectDurationTicks({
    snapshot: SNAPSHOT,
    index: statIndex(SNAPSHOT),
    layers: layerIndex(SNAPSHOT),
    balance: balance(SNAPSHOT),
    compat: ORIGINAL_MODE,
    sheet,
    effectId: "protection",
    baseTicks,
    spellId: "protection",
    spellTags: new Set(["buff"]),
    characterLevel: 100,
    config: {},
    effects: { options: [], active: new Map() } as unknown as EffectState,
    diagnostics: [],
  });
}

test("a build with no duration stats gets exactly what the pack declared", () => {
  assert.equal(ticks({}), 12000);
});

test("the untagged stat applies to every effect", () => {
  // 12000 * (1 + 30/100). The Effect Duration support gem at the top of its band is +30.
  assert.equal(ticks({ eff_dur_u_cast: 30 }), 15600);
});

test("a typed stat applies only to an effect carrying its tag", () => {
  assert.equal(ticks({ positive_eff_dur_u_cast: 50 }), 18000);
  // `protection` is tagged positive and defensive, so the curse twin's gate is closed.
  assert.equal(ticks({ curse_eff_dur_u_cast: 50 }), 12000);
});

test("two sources add off the original rather than compounding", () => {
  // 12000 * (1 + (30 + 50)/100) = 21600, not 12000 * 1.3 * 1.5 = 23400. This is the whole point
  // of `IncreaseNumberByPercentEffect` reading `getOriginalNumber`.
  assert.equal(ticks({ eff_dur_u_cast: 30, positive_eff_dur_u_cast: 50 }), 21600);
});

test("a toggle's -1 is a sentinel, not a duration to lengthen", () => {
  assert.equal(ticks({ eff_dur_u_cast: 30 }, -1), -1);
});

test("the duration lands in an int field, so the fraction is dropped", () => {
  // 101 * 1.15 = 116.15.
  assert.equal(ticks({ eff_dur_u_cast: 15 }, 101), 116);
});

test("a build deep into reduced duration still gets at least one tick", () => {
  assert.equal(ticks({ eff_dur_u_cast: -200 }, 200), 1);
});
