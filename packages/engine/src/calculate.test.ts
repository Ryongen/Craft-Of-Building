import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "./calculate.js";
import { clamp } from "./container.js";
import { statIndex } from "./stat-def.js";
import {
  baseStats,
  closeTo,
  coreStat,
  damageStat,
  engineSnapshot,
  exact,
  moreXPerY,
  oneToOther,
  statEntry,
} from "./test-support.js";

function build(overrides: Partial<BuildDoc> = {}): BuildDoc {
  return { schemaVersion: 1, character: { level: 1 }, ...overrides };
}

/** A snapshot whose base stats grant exactly what a test wants to see arithmetic on. */
function withBaseStats(stats: Record<string, unknown>[], statDefs: Record<string, Record<string, unknown>>) {
  return engineSnapshot({
    mmorpg_stat: statDefs,
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", stats) },
  });
}

test("base stats scale to the character's level when they say to", () => {
  const snapshot = withBaseStats(
    [exact("health", "FLAT", 80, true), exact("critical_hit", "FLAT", 4, false)],
    { health: statEntry("health", { scaling: "NORMAL" }), critical_hit: statEntry("critical_hit") },
  );

  closeTo(calculate(build({ character: { level: 1 } }), snapshot).stats.get("health")?.value, 80);
  // 80 * (1 + 0.2 * 19)
  closeTo(calculate(build({ character: { level: 20 } }), snapshot).stats.get("health")?.value, 384);
  closeTo(
    calculate(build({ character: { level: 20 } }), snapshot).stats.get("critical_hit")?.value,
    4,
  );
});

test("a core stat grants its bundle in a second pass, so a percent on the granted stat applies", () => {
  // The order in `StatCalculation.calc` is: calculate, then `ICoreStat.affectStats` back into
  // the same container, then calculate again (StatCalculation.java:92-106). Were it the other
  // way round, the +100% below would miss what dexterity gave.
  const snapshot = withBaseStats(
    [exact("dexterity", "FLAT", 10), exact("attack_speed", "PERCENT", 100)],
    {
      dexterity: coreStat("dexterity", [exact("attack_speed", "FLAT", 0.25)]),
      attack_speed: statEntry("attack_speed"),
    },
  );

  // 10 dexterity * 0.25 = 2.5 attack speed, then doubled by the +100%.
  assert.equal(calculate(build(), snapshot).stats.get("attack_speed")?.value, 5);
});

test("a core stat's amount is truncated to a whole number", () => {
  // `getMods((int) data.getValue())` — CoreStat.affectStats, CoreStat.java:118-123.
  const snapshot = withBaseStats([exact("dexterity", "FLAT", 10.9)], {
    dexterity: coreStat("dexterity", [exact("attack_speed", "FLAT", 1)]),
    attack_speed: statEntry("attack_speed"),
  });

  assert.equal(calculate(build(), snapshot).stats.get("attack_speed")?.value, 10);
});

test("one_to_other adds a percentage of another stat after everything else resolves", () => {
  const snapshot = withBaseStats(
    [exact("mana", "FLAT", 200), exact("spell_damage_per_perc_of_mana", "FLAT", 10)],
    {
      mana: statEntry("mana"),
      spell_damage: statEntry("spell_damage"),
      spell_damage_per_perc_of_mana: oneToOther("spell_damage_per_perc_of_mana", "mana", "spell_damage", 75),
    },
  );

  // 10% of 200 mana.
  assert.equal(calculate(build(), snapshot).stats.get("spell_damage")?.value, 20);
});

test("one_to_other reads its adder without the MORE multiplier, dropping it silently", () => {
  // `AddPerPercentOfOther.affectStats` calls `adder.getValue()`, and `StatData.getValue()`
  // returns v1 without `m` (StatData.java:52-56). For a MULTIPLICATIVE_DAMAGE adder the MORE
  // lives only in `m`, so it never reaches the target. 14 stats in this pack hit this.
  const snapshot = withBaseStats(
    [
      exact("spell_damage", "FLAT", 100),
      exact("spell_damage", "MORE", 50),
      exact("weapon_damage_per_perc_of_spell_damage", "FLAT", 100),
    ],
    {
      // MULTIPLICATIVE_DAMAGE: the MORE is carried in dmgMulti, not the value.
      spell_damage: damageStat("spell_damage"),
      weapon_damage: statEntry("weapon_damage"),
      weapon_damage_per_perc_of_spell_damage: oneToOther(
        "weapon_damage_per_perc_of_spell_damage",
        "spell_damage",
        "weapon_damage",
        75,
      ),
    },
  );

  const stats = calculate(build(), snapshot).stats;
  assert.equal(stats.get("spell_damage")?.dmgMulti, 1.5);
  // 100% of 100, not of 150.
  assert.equal(stats.get("weapon_damage")?.value, 100);
});

test("stats in the same priority tier cannot see each other's contributions", () => {
  // `copiedStats` is re-cloned only when the priority increases
  // (StatCalculation.java:132-135), so a tier reads one frozen snapshot.
  const chain = (priority: number) =>
    withBaseStats(
      [
        exact("mana", "FLAT", 100),
        exact("energy_per_perc_of_mana", "FLAT", 100),
        exact("health_per_perc_of_energy", "FLAT", 100),
      ],
      {
        mana: statEntry("mana"),
        energy: statEntry("energy"),
        health: statEntry("health"),
        energy_per_perc_of_mana: oneToOther("energy_per_perc_of_mana", "mana", "energy", 50),
        health_per_perc_of_energy: oneToOther("health_per_perc_of_energy", "energy", "health", priority),
      },
    );

  // Same tier: energy is 0 in the snapshot both entries read, so health gains nothing.
  assert.equal(calculate(build(), chain(50)).stats.get("health")?.value, 0);
  // Later tier: the snapshot is retaken, so health sees the 100 energy just added.
  assert.equal(calculate(build(), chain(75)).stats.get("health")?.value, 100);
});

test("more_x_per_y floors the number of steps", () => {
  // `(int) (adder.getValue() / perEach) * statData.getValue()` — MoreXPerYOf.java:58-66.
  // 29 dexterity is two steps of ten, not 2.9.
  const snapshot = withBaseStats(
    [exact("dexterity", "FLAT", 29), exact("accuracy_per_10_dexterity", "FLAT", 5)],
    {
      dexterity: statEntry("dexterity"),
      accuracy: statEntry("accuracy"),
      accuracy_per_10_dexterity: moreXPerY("accuracy_per_10_dexterity", "dexterity", "accuracy", 10),
    },
  );

  assert.equal(calculate(build(), snapshot).stats.get("accuracy")?.value, 10);
});

test("more_x_per_y runs after every one_to_other tier", () => {
  // It has no priority field, so it sorts as Integer.MAX_VALUE and reads a snapshot taken
  // after the last tier's writes.
  const snapshot = withBaseStats(
    [
      exact("mana", "FLAT", 100),
      exact("dexterity_per_perc_of_mana", "FLAT", 20),
      exact("accuracy_per_10_dexterity", "FLAT", 1),
    ],
    {
      mana: statEntry("mana"),
      dexterity: statEntry("dexterity"),
      accuracy: statEntry("accuracy"),
      dexterity_per_perc_of_mana: oneToOther("dexterity_per_perc_of_mana", "mana", "dexterity", 25),
      accuracy_per_10_dexterity: moreXPerY("accuracy_per_10_dexterity", "dexterity", "accuracy", 10),
    },
  );

  // 20% of 100 mana is 20 dexterity, which is two steps of ten.
  assert.equal(calculate(build(), snapshot).stats.get("accuracy")?.value, 2);
});

test("an elemental stat empties itself into the single elements", () => {
  // `ITransferToOtherStats` runs before the first calculation, and `clear()` leaves the
  // source at zero — which is why the sheet never shows elemental_resist.
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("elemental_resist", "FLAT", 30)]),
    },
  });

  // Off for the same reason as the transfer test below: +50 on each single resist would be
  // real but would say nothing about whether the transfer happened.
  const stats = calculate(build(), snapshot, { newbieResists: false }).stats;
  assert.equal(stats.get("fire_resist")?.value, 30);
  assert.equal(stats.get("water_resist")?.value, 30);
  assert.equal(stats.get("lightning_resist")?.value, 30);
  assert.equal(stats.get("elemental_resist")?.value, 0);
  // Chaos and physical are not "elemental" — `Elements.getAllSingleElemental()` is the three
  // ELEMENTAL-tagged ones only.
  assert.equal(stats.get("chaos_resist")?.value ?? 0, 0);
});

test("the code-only stat table supplies caps the extractor cannot see", () => {
  // `armor` has no JSON anywhere; its min of 0 and NORMAL scaling come from Armor.java.
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("armor", "FLAT", 100, true)]),
    },
  });

  const stats = calculate(build({ character: { level: 11 } }), snapshot).stats;
  assert.equal(stats.get("armor")?.value, 300);
  // `IUsableStat`: 300 / (300 + 100 * 3) = 0.5, shown as a percentage.
  assert.equal(stats.get("armor")?.usableValue, 50);
});

test("a resist reports its usable value as a plain clamp, not the armor curve", () => {
  // `ElementalResist` overrides `getUsableValue` (ElementalResist.java:115-119).
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("fire_resist", "FLAT", 75)]),
    },
  });

  assert.equal(calculate(build(), snapshot).stats.get("fire_resist")?.usableValue, 75);
});

// ---------------------------------------------------------------------------
// Provenance and caching
// ---------------------------------------------------------------------------

test("derived records what the core-stat pass granted, so a breakdown can account for it", () => {
  // Dexterity's real bundle, trimmed: 0.2 flat projectile damage and 1% crit per point.
  const snapshot = withBaseStats([exact("dexterity", "FLAT", 40)], {
    dexterity: coreStat("dexterity", [
      exact("projectile_damage", "FLAT", 0.2),
      exact("critical_hit", "PERCENT", 1),
    ]),
    projectile_damage: statEntry("projectile_damage"),
    critical_hit: statEntry("critical_hit"),
  });

  const result = calculate(build(), snapshot);
  const grants = result.derived.filter((d) => d.kind === "core_stat");

  assert.deepEqual(
    grants.map((d) => [d.from, d.statId, d.type, d.value]),
    [
      ["dexterity", "projectile_damage", "FLAT", 8],
      ["dexterity", "critical_hit", "PERCENT", 40],
    ],
  );

  // The recorded numbers are the ones the sheet ended up showing, not an approximation of them.
  closeTo(result.stats.get("projectile_damage")?.value, 8);
  // No context can explain either: both arrived in step 6, after collection was over.
  const collected = result.contexts.flatMap((c) => c.stats).map((m) => m.statId);
  assert.ok(!collected.includes("projectile_damage"));
});

test("derived records the after-calc adders, which write onto the resolved value", () => {
  const snapshot = withBaseStats(
    [exact("mana", "FLAT", 200), exact("spell_damage_per_perc_of_mana", "FLAT", 10)],
    {
      mana: statEntry("mana"),
      spell_damage: statEntry("spell_damage"),
      spell_damage_per_perc_of_mana: oneToOther("spell_damage_per_perc_of_mana", "mana", "spell_damage", 75),
    },
  );

  const result = calculate(build(), snapshot);

  // `ADD_TO_VALUE` rather than a ModType: step 8 writes past the container, so there is no
  // modifier this could be expressed as.
  assert.deepEqual(result.derived.filter((d) => d.kind === "one_to_other"), [
    {
      kind: "one_to_other",
      from: "spell_damage_per_perc_of_mana",
      statId: "spell_damage",
      type: "ADD_TO_VALUE",
      value: 20,
    },
  ]);
  assert.equal(result.stats.get("spell_damage")?.value, 20);
});

test("a contribution that resolves to nothing is not recorded", () => {
  // 0 dexterity grants 0 of everything. Listing those would bury the real lines.
  const snapshot = withBaseStats([exact("dexterity", "FLAT", 0)], {
    dexterity: coreStat("dexterity", [exact("projectile_damage", "FLAT", 0.2)]),
    projectile_damage: statEntry("projectile_damage"),
  });

  assert.deepEqual(calculate(build(), snapshot).derived, []);
});

test("the cached stat index does not leak one build's unknown stats into the next", () => {
  // `statIndex` shares its definition table across calls on the same snapshot, but `unknown`
  // is a per-call accumulator that `reportUnknownStats` drains. Sharing that too would make
  // the second build inherit the first's `unknown-stat` errors.
  const snapshot = engineSnapshot({
    mmorpg_stat: { armor: statEntry("armor") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", []),
      bad: baseStats("bad", [exact("no_such_stat_anywhere", "FLAT", 1)]),
    },
  });

  const unknownIn = (result: ReturnType<typeof calculate>) =>
    result.diagnostics.filter((d) => d.code === "unknown-stat").map((d) => d.message);

  const bad = calculate(build(), snapshot, { baseStatsId: "bad" });
  assert.equal(unknownIn(bad).length, 1);
  assert.match(unknownIn(bad)[0]!, /no_such_stat_anywhere/);

  // A clean build over the same snapshot must come back clean.
  assert.deepEqual(unknownIn(calculate(build(), snapshot)), []);
  // ...and the dirty one must still report it, i.e. the cache did not swallow the finding.
  assert.equal(unknownIn(calculate(build(), snapshot, { baseStatsId: "bad" })).length, 1);
});

test("derived records a transfer, so the target can explain where its value came from", () => {
  // `elemental_resist` empties into the three single elements and clears itself. Without this
  // the sheet shows fire_resist at -25 with nothing accounting for it, and elemental_resist at
  // 0 with a contribution that appears to have vanished.
  const snapshot = withBaseStats([exact("elemental_resist", "FLAT", -25)], {
    elemental_resist: statEntry("elemental_resist"),
    fire_resist: statEntry("fire_resist"),
    water_resist: statEntry("water_resist"),
    lightning_resist: statEntry("lightning_resist"),
  });

  // The newbie grant is off here: it adds +50 to each single resist at level 1, which is real
  // but has nothing to do with the transfer this test is about.
  const result = calculate(build(), snapshot, { newbieResists: false });
  const transfers = result.derived.filter((d) => d.kind === "transfer");

  assert.deepEqual(
    transfers.map((d) => [d.from, d.statId, d.type, d.value]),
    [
      ["elemental_resist", "fire_resist", "FLAT", -25],
      ["elemental_resist", "water_resist", "FLAT", -25],
      ["elemental_resist", "lightning_resist", "FLAT", -25],
    ],
  );

  assert.equal(result.stats.get("fire_resist")?.value, -25);
  // The source keeps nothing — `clear()` zeroes it, which is why it always reads 0.
  assert.equal(result.stats.get("elemental_resist")?.value, 0);
});

test("a stat's value can be reconstructed from its contributions alone", () => {
  // The invariant the breakdown panel rests on: contexts + derived account for every number
  // the sheet shows. If a pass ever adds to a stat without recording it, this catches it.
  const snapshot = withBaseStats(
    [
      exact("dexterity", "FLAT", 40),
      exact("elemental_resist", "FLAT", 30),
      exact("mana", "FLAT", 200),
      exact("spell_damage_per_perc_of_mana", "FLAT", 10),
      exact("armor", "FLAT", 100),
      exact("armor", "PERCENT", 50),
      exact("armor", "MORE", 20),
    ],
    {
      dexterity: coreStat("dexterity", [exact("projectile_damage", "FLAT", 0.2)]),
      projectile_damage: statEntry("projectile_damage"),
      elemental_resist: statEntry("elemental_resist"),
      fire_resist: statEntry("fire_resist"),
      water_resist: statEntry("water_resist"),
      lightning_resist: statEntry("lightning_resist"),
      mana: statEntry("mana"),
      spell_damage: statEntry("spell_damage"),
      spell_damage_per_perc_of_mana: oneToOther(
        "spell_damage_per_perc_of_mana",
        "mana",
        "spell_damage",
        75,
      ),
      armor: statEntry("armor"),
    },
  );

  const result = calculate(build({ character: { level: 30 } }), snapshot);
  const index = statIndex(snapshot);

  const sources = new Map<string, { type: string; value: number }[]>();
  const push = (statId: string, type: string, value: number): void => {
    const list = sources.get(statId);
    if (list) list.push({ type, value });
    else sources.set(statId, [{ type, value }]);
  };
  for (const ctx of result.contexts) for (const mod of ctx.stats) push(mod.statId, mod.type, mod.value);
  for (const d of result.derived) push(d.statId, d.type, d.value);

  // Stats that hand themselves away end at 0 regardless of what fed them; that is `clear()`,
  // not an unrecorded contribution, and the breakdown says so separately.
  const transferSources = new Set(
    result.derived.filter((d) => d.kind === "transfer").map((d) => d.from),
  );

  for (const [statId, stat] of result.stats) {
    if (transferSources.has(statId)) continue;
    const shape = index.shapeOf(statId);

    let flat = 0;
    let percent = 0;
    let multi = 1;
    let afterCalc = 0;
    for (const { type, value } of sources.get(statId) ?? []) {
      if (type === "FLAT") flat += value;
      else if (type === "PERCENT") percent += value;
      else if (type === "MORE") multi *= 1 + value / 100;
      else if (type === "MULTI_ADD") multi += value;
      else afterCalc += value;
    }

    // `InCalcContainer.calculate`, then the after-calc write, then the clamp.
    const inValue = stat.dmgMulti === 1 ? multi : 1;
    let predicted = clamp((shape.base + flat) * (1 + percent / 100) * inValue, shape.min, shape.max);
    predicted = clamp(predicted + afterCalc, shape.min, shape.max);

    closeTo(predicted, stat.value, `${statId}: reconstructed ${predicted}, sheet says ${stat.value}`);
  }
});
