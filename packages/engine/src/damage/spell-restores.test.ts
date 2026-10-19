/**
 * A skill's own `restore_*` acts, and leech off a totem the summon limit keeps culling.
 *
 * `RestoreManaAction.tryActivate` in the 6.4.13 jar raises one `RestoreType.heal` event per ally
 * its selector picks, seeded with `getCalculatedValue(caster, spell)`. Astral Totem puts that on
 * its block's 20-tick pulse, so the mana arrives once a second for the block's life — the same
 * walk, the same firing count and the same summon limit as a damage totem.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  engineSnapshot,
  exact,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { simulateDps } from "./dps.js";

const EFFECTS = {
  add_max_totems: {
    id: "add_max_totems",
    ser: "add_to_number",
    number_id: "max_totems",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
  leech_mana: {
    id: "leech_mana",
    ser: "restore_resource",
    type: "mana",
    restore_type: "leech",
    num_provider: { type: "NUMBER_PERCENT", calc: "number" },
    side: "Source",
  },
};

const MAX_TOTEMS = statEntry("max_totems", {
  effect: [
    {
      effects: ["add_max_totems"],
      events: ["on_spell_stat_calc"],
      ifs: [],
      order: "data_modification",
      side: "Source",
    },
  ],
});

const MANA_LEECH = statEntry("all_mana_leech", {
  is_perc: true,
  effect: [
    {
      effects: ["leech_mana"],
      events: ["on_damage"],
      ifs: [],
      order: "after_damage_bonuses",
      side: "Source",
    },
  ],
});

/**
 * Astral Totem's shape: a limited block that hits enemies and restores the caster's mana on the
 * same 20-tick pulse, plus a heal for `allies_not_self` that must never reach you.
 */
function totemSnapshot() {
  const spell = spellEntry("astral", "Physical", "hit100", {
    config: { tags: { tags: ["totem"] }, use_support_gems_from: "", cooldown_ticks: 10 },
    attached: {
      on_cast: [
        {
          acts: [
            {
              type: "summon_block",
              map: { entity_name: "totem", life_ticks: 160, find_surface: true, summon_limit_group: "totem" },
            },
          ],
          ifs: [],
          targets: [],
          en_preds: [],
        },
      ],
      entity_components: {
        totem: [
          {
            acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
            ifs: [{ type: "x_ticks_condition", map: { tick_rate: 20 } }],
            targets: [{ type: "aoe", map: { radius: 5, selection_type: "RADIUS", en_predicate: "enemies" } }],
            en_preds: [],
          },
          {
            acts: [{ type: "restore_mana", map: { value_calculation: "mana50" } }],
            ifs: [{ type: "x_ticks_condition", map: { tick_rate: 20 } }],
            targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "allies" } }],
            en_preds: [],
          },
          {
            acts: [{ type: "restore_health", map: { value_calculation: "mana50" } }],
            ifs: [{ type: "x_ticks_condition", map: { tick_rate: 20 } }],
            targets: [
              { type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "allies_not_self" } },
            ],
            en_preds: [],
          },
        ],
      },
    },
  });

  return engineSnapshot({
    mmorpg_value_calc: {
      hit100: valueCalcEntry("hit100", { min: 100, max: 100 }),
      mana50: valueCalcEntry("mana50", { min: 50, max: 50 }),
    },
    mmorpg_spells: { astral: spell },
    mmorpg_stat: { max_totems: MAX_TOTEMS, all_mana_leech: MANA_LEECH },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("max_totems", "FLAT", 3),
        exact("all_mana_leech", "FLAT", 10),
      ]),
    },
  });
}

const BUILD: BuildDoc = {
  schemaVersion: 1,
  character: { level: 1 },
  skills: [{ spellId: "astral", main: true }],
} as BuildDoc;

test("a totem's restore act pulses for the block's life and is paced by the summon limit", () => {
  const result = simulateDps(BUILD, totemSnapshot(), {})!;
  const mana = result.cost.restores.byResource.find((r) => r.resource === "mana")!;
  const source = mana.sources[0]!;

  // 160 ticks at one pulse per 20 is eight pulses a totem, and one cast places one totem.
  assert.equal(source.firingsPerCast, 8);
  assert.ok(source.seed > 0);
  closeTo(mana.perCast, 8 * source.perFiring);

  // Three alive and an 8s life: one placement every 8/3s, however fast the button comes back.
  const castsPerSecond = result.rate.castsPerCycle / result.rate.cycleSeconds;
  const sustained = result.rate.cycleSeconds / (8 / 3);
  closeTo(mana.perSecond, mana.perCast * castsPerSecond * sustained);

  const row = result.cost.budget.find((r) => r.resource === "mana")!;
  closeTo(row.restorePerSecond, mana.perSecond);
});

test("a restore for allies_not_self never reaches the caster", () => {
  const result = simulateDps(BUILD, totemSnapshot(), {})!;
  assert.equal(result.cost.restores.byResource.find((r) => r.resource === "health"), undefined);
  assert.ok(!result.model.unmodelledActs.includes("restore_health"));
});

test("leech off a limited totem is thinned by the limit, as its damage is", () => {
  const result = simulateDps(BUILD, totemSnapshot(), {})!;
  const leech = result.cost.leech.byResource.find((r) => r.resource === "mana")!;
  const castsPerSecond = result.rate.castsPerCycle / result.rate.cycleSeconds;
  const sustained = result.sources[0]!.sustained;
  assert.ok(sustained < 1);
  assert.ok(leech.generatedPerCast > 0);
  closeTo(leech.generatedPerSecond, leech.generatedPerCast * castsPerSecond * sustained);
});

/** A projectile that heals you each time it hits something, as Spirit Offensive does. */
function boltSnapshot(lifeTicks: number) {
  const spell = spellEntry("bolt", "Physical", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: 20 },
    attached: {
      on_cast: [
        {
          acts: [
            {
              type: "projectile",
              map: { entity_name: "proj", proj_count: 1, proj_speed: 1, life_ticks: lifeTicks, expire_on_en_hit: true },
            },
          ],
          ifs: [],
          targets: [],
          en_preds: [],
        },
      ],
      entity_components: {
        proj: [
          {
            acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
            ifs: [{ type: "on_hit", map: {} }],
            targets: [{ type: "aoe", map: { radius: 1, selection_type: "RADIUS", en_predicate: "enemies" } }],
            en_preds: [],
          },
          {
            acts: [{ type: "restore_health", map: { value_calculation: "mana50" } }],
            ifs: [{ type: "on_hit", map: {} }],
            targets: [{ type: "self", map: {} }],
            en_preds: [],
          },
        ],
      },
    },
  });
  return engineSnapshot({
    mmorpg_value_calc: {
      hit100: valueCalcEntry("hit100", { min: 100, max: 100 }),
      mana50: valueCalcEntry("mana50", { min: 50, max: 50 }),
    },
    mmorpg_spells: { bolt: spell },
  });
}

const BOLT: BuildDoc = {
  schemaVersion: 1,
  character: { level: 1 },
  skills: [{ spellId: "bolt", main: true }],
} as BuildDoc;

test("an on-hit heal fires once per hit its carrier lands, and not for a miss", () => {
  const reaches = simulateDps(BOLT, boltSnapshot(200), {})!;
  const hits = reaches.sources[0]!.coverage.hitsPerCast;
  assert.ok(hits > 0);
  const heal = reaches.cost.restores.byResource.find((r) => r.resource === "health")!;
  closeTo(heal.sources[0]!.firingsPerCast, hits);

  // Gone before it gets there: no hit, so no heal either.
  const short = simulateDps(BOLT, boltSnapshot(1), {})!;
  assert.equal(short.sources[0]!.coverage.hitsPerCast, 0);
  assert.equal(short.cost.restores.byResource.find((r) => r.resource === "health"), undefined);
});
