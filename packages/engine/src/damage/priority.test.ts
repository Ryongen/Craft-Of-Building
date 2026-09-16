/**
 * The priority table, pinned against the jar the game actually loads.
 *
 * This table was written for 6.4.8, where `StatPriority` declared `AFTER_DAMAGE_LAYERS` as
 * `damage("DAMAGE_LAYERS", 21)` — a duplicate id that overwrote `MAP["damage_layers"]`, so a
 * datapack stat asking for `damage_layers` resolved to 21 while an in-code effect holding the
 * object kept 20. 6.4.13 does not have that collision, and the numbers below come from
 * disassembling the shipped jar rather than from reading a checkout:
 *
 *     javap -p -c -constants -classpath <unzipped jar> \
 *       com.robertx22.mine_and_slash.database.data.stats.priority.StatPriority$Damage
 *
 *     ldc "DAMAGE_LAYERS"        bipush 20
 *     ldc "AFTER_DAMAGE_LAYERS"  bipush 21
 *     ldc "AFTER_CALC_LAYER"     bipush 31
 *
 * Reading the checkout would not have settled it either way: it sits on a feature branch with
 * local commits and declares `mod_version=6.4.8` in `gradle.properties`, so it is evidence about
 * no released version at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DATAPACK_PRIORITY,
  PRIORITY,
  UNKNOWN_ORDER_PRIORITY,
  datapackPriority,
} from "./priority.js";

test("damage_layers resolves to 20, the way the jar registers it", () => {
  assert.equal(DATAPACK_PRIORITY["damage_layers"], 20);
  assert.equal(PRIORITY.DAMAGE_LAYERS, 20);

  // The whole point of the 6.4.8 collision was that these two disagreed. They no longer do, and
  // that equality is the thing worth pinning — not the number.
  assert.equal(DATAPACK_PRIORITY["damage_layers"], PRIORITY.DAMAGE_LAYERS);
});

test("after_damage_layers and after_calc_layer are resolvable ids, not fallbacks", () => {
  // Before this table carried them, an `order` naming either resolved to 0 through the
  // unknown-id fallback — the opposite end of the sweep from where it belongs. Craft to Exile 2
  // uses neither today, which is exactly why a silent 0 would never have been noticed.
  assert.equal(datapackPriority("after_damage_layers"), 21);
  assert.equal(datapackPriority("after_calc_layer"), 31);
  assert.equal(PRIORITY.AFTER_DAMAGE_LAYERS, 21);
  assert.equal(PRIORITY.AFTER_CALC_LAYER, 31);
});

test("every id an in-code effect holds is also resolvable by name", () => {
  // The two tables describe one thing from two angles, and they drifted once already. Anything
  // `PRIORITY` names must be reachable through the datapack map at the same number, or a stat
  // moves depending on whether its effect is Java or JSON.
  for (const [name, value] of Object.entries(PRIORITY)) {
    const id = name.toLowerCase();
    assert.equal(
      DATAPACK_PRIORITY[id],
      value,
      `${name} is ${value} in code but ${DATAPACK_PRIORITY[id]} by id`,
    );
  }
});

test("the sweep order is the one EffectEvent applies", () => {
  // `CALC_DAMAGE_LAYERS` is not a step after the stats — it is a pseudo-stat *inside* the sorted
  // list, which is why the layers flush at 30 with stats still to come at 32 and 100. Asserting
  // the shape catches a renumbering that keeps every value legal but moves the flush.
  assert.ok(PRIORITY.BEFORE_DAMAGE_LAYERS < PRIORITY.DAMAGE_LAYERS);
  assert.ok(PRIORITY.DAMAGE_LAYERS < PRIORITY.AFTER_DAMAGE_LAYERS);
  assert.ok(PRIORITY.AFTER_DAMAGE_LAYERS < PRIORITY.CALC_DAMAGE_LAYERS);
  assert.ok(PRIORITY.CALC_DAMAGE_LAYERS < PRIORITY.AFTER_CALC_LAYER);
  assert.ok(PRIORITY.AFTER_CALC_LAYER < PRIORITY.AFTER_DAMAGE_BONUSES);
  assert.ok(PRIORITY.AFTER_DAMAGE_BONUSES < PRIORITY.FINAL_DAMAGE);
});

test("an unknown order is reported, then treated as 0 the way the game treats it", () => {
  // `DataPackStatEffect.GetPriority()` warns and returns `StatPriority.Spell.FIRST`. The engine
  // splits that in two on purpose: `datapackPriority` returns undefined so the caller can say
  // the id was unknown, and `UNKNOWN_ORDER_PRIORITY` is the 0 it then uses. A pack with a
  // typo'd `order` therefore behaves as it does in game *and* shows up in diagnostics.
  assert.equal(datapackPriority("not_a_real_order"), undefined);
  assert.equal(UNKNOWN_ORDER_PRIORITY, 0);
});
