import assert from "node:assert/strict";
import { test } from "node:test";

import { InCalcContainer, InCalcStat } from "./container.js";
import { statIndex } from "./stat-def.js";
import { damageStat, engineSnapshot, statEntry } from "./test-support.js";

function index(stats: Record<string, Record<string, unknown>>) {
  return statIndex(engineSnapshot({ mmorpg_stat: stats }));
}

test("a stat resolves as (base + Flat) * (1 + Percent/100) * Multi", () => {
  const c = new InCalcContainer(index({ armor: statEntry("armor", { base: 10 }) }));
  c.apply({ statId: "armor", type: "FLAT", value: 90 });
  c.apply({ statId: "armor", type: "PERCENT", value: 50 });
  c.apply({ statId: "armor", type: "MORE", value: 100 });

  // (10 + 90) * 1.5 * 2
  assert.equal(c.calculate().get("armor").value, 300);
});

test("MORE modifiers stack multiplicatively, not additively", () => {
  // `Multi *= 1 + (v1 / 100F)` — InCalcStatData.java:78-80. Two 50% MOREs are 2.25x, not 2x.
  const c = new InCalcContainer(index({ armor: statEntry("armor") }));
  c.apply({ statId: "armor", type: "FLAT", value: 100 });
  c.apply({ statId: "armor", type: "MORE", value: 50 });
  c.apply({ statId: "armor", type: "MORE", value: 50 });

  assert.equal(c.calculate().get("armor").value, 225);
});

test("a MULTIPLICATIVE_DAMAGE stat keeps its MORE out of the value and reports it as dmgMulti", () => {
  // `if (stat.getMultiUseType() == MULTIPLY_STAT) { finalValue *= Multi; }` and
  // `if (... == MULTIPLICATIVE_DAMAGE) { mu = Multi; }` — InCalcStatData.java:44-46, 88-93.
  const c = new InCalcContainer(
    index({ spell_damage: damageStat("spell_damage"), armor: statEntry("armor") }),
  );
  for (const statId of ["spell_damage", "armor"]) {
    c.apply({ statId, type: "FLAT", value: 100 });
    c.apply({ statId, type: "MORE", value: 50 });
  }
  const stats = c.calculate();

  assert.deepEqual(stats.get("spell_damage"), { value: 100, dmgMulti: 1.5 });
  assert.deepEqual(stats.get("armor"), { value: 150, dmgMulti: 1 });
});

test("values are clamped to the stat's own min and max", () => {
  const c = new InCalcContainer(
    index({ fire_resist: statEntry("fire_resist", { min: -300, max: 500 }) }),
  );
  c.apply({ statId: "fire_resist", type: "FLAT", value: 900 });
  assert.equal(c.calculate().get("fire_resist").value, 500);

  const d = new InCalcContainer(
    index({ fire_resist: statEntry("fire_resist", { min: -300, max: 500 }) }),
  );
  d.apply({ statId: "fire_resist", type: "FLAT", value: -900 });
  assert.equal(d.calculate().get("fire_resist").value, -300);
});

test("addFullyTo adds the Multi where every other MORE path multiplies it", () => {
  // `other.Multi += 1F - Multi;` — InCalcStatData.java:61-65. A 1.5x source hands over
  // -0.5, taking a 1.0 target to 0.5, which is not what a player reading "more" expects.
  const source = new InCalcStat("elemental_resist");
  source.flat = 10;
  source.percent = 20;
  source.multi = 1.5;

  const target = new InCalcStat("fire_resist");
  source.addFullyTo(target);

  assert.equal(target.flat, 10);
  assert.equal(target.percent, 20);
  assert.equal(target.multi, 0.5);
});

test("clear leaves Multi at 0, not 1", () => {
  // InCalcStatData.java:29-33. A transferred stat therefore resolves to 0 whatever it held,
  // which is why `elemental_resist` reads 0 on the character sheet.
  const stat = new InCalcStat("elemental_resist");
  stat.flat = 50;
  stat.multi = 2;
  stat.clear();

  assert.equal(stat.flat, 0);
  assert.equal(stat.percent, 0);
  assert.equal(stat.multi, 0);
});

test("a stat nothing touched is absent, and reads as zero", () => {
  // `StatContainer.getCalculatedStat` falls back to `StatData.empty()`, and the stat screen
  // only lists stats the container holds.
  const c = new InCalcContainer(index({ armor: statEntry("armor", { base: 25 }) }));
  const stats = c.calculate();

  assert.deepEqual(stats.ids(), []);
  assert.deepEqual(stats.get("armor"), { value: 0, dmgMulti: 1 });
});
