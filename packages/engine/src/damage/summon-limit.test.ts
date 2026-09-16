/**
 * `BlockSummonLimitGroup` — how many totems and banners you actually have.
 *
 * Two numbers come out of `on_spell_stat_calc` and were being produced and then dropped:
 *
 *     static int getSummonCount(SpellCtx ctx, BlockSummonLimitGroup group) {
 *         if (group == null || !(ctx.caster instanceof Player)) { return 1; }
 *         int max = getMaxSummons(ctx, group);
 *         int extra = (int) ctx.calculatedSpellData.data.getNumber(group.extraCountEventDataKey, 0).number;
 *         return Math.max(1, Math.min(1 + extra, max));
 *     }
 *
 *     static int getMaxSummons(SpellCtx ctx, BlockSummonLimitGroup group) {
 *         return Math.max(1, (int) ctx.calculatedSpellData.data.getNumber(group.maxEventDataKey, 0).number);
 *     }
 *
 * The count is the smaller half. The one that moves a damage figure is `enforceSummonLimit`,
 * which culls the oldest of the group on every cast — so a totem is not something you can spam,
 * and the button's own cycle is not the rate its damage arrives at.
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

/** `add_max_totems` — the pack's own serializer, an `add_to_number` onto `max_totems`. */
const EFFECTS = {
  add_max_totems: {
    id: "add_max_totems",
    ser: "add_to_number",
    number_id: "max_totems",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
};

/** The `max_totems` stat, shaped as the pack ships it: it writes the number in the sweep. */
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

/**
 * A totem spell: the cast places one block, and the block damages every 20 ticks while it lives.
 *
 * `life_ticks` 160 against a `cooldown_ticks` of 10 is the shape that makes the limit matter —
 * the button comes back sixteen times over one totem's life.
 */
function totemSnapshot(limited: boolean) {
  const spell = spellEntry("totem_spell", "Physical", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: 10 },
    attached: {
      on_cast: [
        {
          acts: [
            {
              type: "summon_block",
              map: {
                entity_name: "totem",
                life_ticks: 160,
                find_surface: true,
                ...(limited ? { summon_limit_group: "totem" } : {}),
              },
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
            targets: [
              { type: "aoe", map: { radius: 5, selection_type: "RADIUS", en_predicate: "enemies" } },
            ],
            en_preds: [],
          },
        ],
      },
    },
  });

  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { totem_spell: spell },
    mmorpg_stat: { max_totems: MAX_TOTEMS },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("max_totems", "FLAT", 3)]),
    },
  });
}

const BUILD: BuildDoc = {
  schemaVersion: 1,
  character: { level: 1 },
  skills: [{ spellId: "totem_spell", main: true }],
} as BuildDoc;

test("a summon limit paces the source it carries, and an unlimited block is not paced", () => {
  const limited = simulateDps(BUILD, totemSnapshot(true), {})!;
  const free = simulateDps(BUILD, totemSnapshot(false), {})!;

  // One cast puts the same thing in the world either way — the limit is about what survives.
  closeTo(limited.damagePerCast, free.damagePerCast);

  // The totem lives 160 ticks (8s) and three may be alive, so one placement every 8/3 = 2.67s
  // keeps the field full. Anything faster destroys your own.
  const source = limited.sources[0]!;
  assert.equal(source.limit?.group, "totem");
  assert.equal(source.limit?.maxAlive, 3);
  closeTo(source.limit?.periodSeconds, 8 / 3);

  // The button is off cooldown every 0.5s, so only 0.5 / 2.667 of what it claims is real.
  closeTo(limited.dps, free.dps * (limited.rate.cycleSeconds / (8 / 3)));
  assert.ok(limited.dps < free.dps);

  assert.equal(free.sources[0]?.limit, undefined);
  assert.equal(free.sources[0]?.sustained, 1);
});

test("the limit caps how many are alive, not how many one cast places", () => {
  const limited = simulateDps(BUILD, totemSnapshot(true), {})!;
  // `extra_totems` is written by nothing in this pack, so `1 + extra` is 1 and the count stays
  // one however high `max_totems` goes. What the ceiling buys is concurrency, not a bigger cast.
  const carrier = limited.sources[0]!.source.carrier;
  assert.equal(carrier.kind, "summon_block");
  assert.equal(carrier.kind === "summon_block" ? carrier.count : -1, 1);
  assert.equal(limited.sources[0]!.concurrentCasts, 3);
});

test("a button slower than the limit's own pace is not paced further", () => {
  // Three totems alive and a 160-tick life means one every 2.67s. A spell you can only cast
  // every 4s is already slower than that, so nothing is being thrown away and nothing is scaled.
  const snapshot = totemSnapshot(true);
  const spell = snapshot.registries["mmorpg_spells"]!["totem_spell"]!.data as Record<string, unknown>;
  (spell["config"] as Record<string, unknown>)["cooldown_ticks"] = 80;

  const result = simulateDps(BUILD, snapshot, {})!;
  assert.equal(result.sources[0]?.limit, undefined);
  assert.equal(result.sources[0]?.sustained, 1);
});
