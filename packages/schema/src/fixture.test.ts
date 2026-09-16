/**
 * How close the engine has to be, and why that depends on where the number came from.
 *
 * A transcription from the stat GUI cannot be more precise than the two decimals the screen
 * prints. A dump from the companion mod is the float the game held, so the only slack it needs
 * is float-versus-double drift. Comparing the second at the first's precision was letting real
 * errors through, and at large values it was asking for agreement finer than a 32-bit float can
 * represent at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Snapshot } from "@cte2/extractor";

import type { BuildDoc } from "./build-doc.js";
import {
  FIELD_TOLERANCE,
  MOD_DUMP,
  compareFixture,
  toleranceFor,
  type ComputedDamage,
  type ComputedStat,
  type DamageCalculator,
  type Fixture,
  type ObservationSource,
  type ObservedDamage,
  type StatCalculator,
  type StatComparison,
} from "./fixture.js";
import { makeSnapshot } from "./test-support.js";

function fixture(source: ObservationSource, statId: string, currentValue: number): Fixture {
  const build: BuildDoc = { schemaVersion: 1, character: { level: 1 } };
  return {
    name: `${source}-${statId}`,
    build,
    observed: {
      source,
      capturedAt: "2026-09-12",
      mineAndSlashVersion: "1.20.1-6.4.5",
      packVersion: "2.0.2",
      stats: [{ statId, currentValue }],
    },
  };
}

/** An engine that reports one stat, so the comparison has something to disagree with. */
function engineReporting(statId: string, stat: Partial<ComputedStat>): StatCalculator {
  return () => new Map([[statId, { value: 0, dmgMulti: 1, ...stat }]]);
}

function statusOf(
  source: ObservationSource,
  observedValue: number,
  computedValue: number,
  snapshot: Snapshot = makeSnapshot({}),
): string {
  const result = compareFixture(
    fixture(source, "armor", observedValue),
    snapshot,
    engineReporting("armor", { value: computedValue }),
  );
  const comparison = result.comparisons.find((c) => c.field === "currentValue");
  assert.ok(comparison, "expected a currentValue comparison");
  return comparison.status;
}

test("a stat GUI capture still gets the screen's two decimals", () => {
  assert.deepEqual(toleranceFor("currentValue", "stat_gui"), FIELD_TOLERANCE.currentValue);
  // Half of the last printed digit: inside passes, outside does not.
  assert.equal(statusOf("stat_gui", 40, 40.004), "match");
  assert.equal(statusOf("stat_gui", 40, 40.006), "mismatch");
});

test("a mod dump is held to float drift instead", () => {
  assert.deepEqual(toleranceFor("currentValue", "mod_dump"), MOD_DUMP);
  // The same 0.004 that a transcription forgives is now a mismatch: at 40 the bound is
  // 0.00005 + 40 * 1e-5 = 0.00045.
  assert.equal(statusOf("mod_dump", 40, 40.004), "mismatch");
  assert.equal(statusOf("mod_dump", 40, 40.0004), "match");
});

test("the bound scales with the value, because float32 error does", () => {
  // One float32 step at 50,000 is about 0.0039, so the old flat 0.005 was asking for agreement
  // finer than the game can represent. A relative term makes a correct engine pass here.
  assert.equal(statusOf("mod_dump", 50_000, 50_000.05), "match");
  // And still catches an error that matters: 0.1% of the value.
  assert.equal(statusOf("mod_dump", 50_000, 50_050), "mismatch");
});

test("small values are bounded by the exporter's rounding, not by the relative term", () => {
  // At 0.5 the relative term is 5e-6, so the 4-decimal rounding floor is what does the work.
  assert.equal(statusOf("mod_dump", 0.5, 0.50004), "match");
  assert.equal(statusOf("mod_dump", 0.5, 0.5006), "mismatch");
});

test("caps stay exact for every source", () => {
  // They are integers read off the stat registry rather than computed, so loosening them would
  // only hide a wrong cap in the ported table.
  for (const source of ["stat_gui", "mod_dump", "damage_log"] as const) {
    assert.deepEqual(toleranceFor("hardcap", source), FIELD_TOLERANCE.hardcap);
    assert.deepEqual(toleranceFor("softcap", source), FIELD_TOLERANCE.softcap);
  }
});

test("damage fields are not tightened by a dump, because nothing writes them from one", () => {
  for (const field of ["baseValue", "hit", "crit", "ailmentPerSecond"] as const) {
    assert.deepEqual(toleranceFor(field, "mod_dump"), FIELD_TOLERANCE[field]);
  }
});

test("an explicit tolerance still overrides the source", () => {
  const result = compareFixture(
    fixture("mod_dump", "armor", 40),
    makeSnapshot({}),
    engineReporting("armor", { value: 40.004 }),
    { tolerance: { absolute: 0.01, relative: 0 } },
  );
  assert.equal(result.comparisons.find((c) => c.field === "currentValue")?.status, "match");
});

test("dmgMulti is tightened too, which is where the MORE split shows up", () => {
  const doc = fixture("mod_dump", "all_physical_damage", 0);
  doc.observed.stats = [{ statId: "all_physical_damage", currentValue: 0, dmgMulti: 1.2 }];
  const result = compareFixture(
    doc,
    makeSnapshot({}),
    engineReporting("all_physical_damage", { value: 0, dmgMulti: 1.203 }),
  );
  assert.equal(result.comparisons.find((c) => c.field === "dmgMulti")?.status, "mismatch");
});

/**
 * The Quake hit from the in-game damage log, as the hover printed it.
 *
 * Kept as one shared reading because every test below is about a single *row* of it
 * disagreeing: the whole point of recording the layer stack is that a wrong number has a name,
 * so each case changes exactly one row and checks that the failure points at that row.
 */
const QUAKE_HIT: ObservedDamage = {
  spellId: "quake",
  wasCrit: false,
  totalCombined: 13041,
  log: [
    {
      element: "physical",
      baseDamage: 888,
      layers: [
        { layerId: "flat_damage", side: "Source", amount: 2468.9 },
        { layerId: "additive_damage", side: "Source", multiplier: 2.72 },
        { layerId: "physical_mitigation", side: "Target", multiplier: 0.68 },
      ],
      moreMultis: [
        { statId: "str_dmg", multi: 1.21 },
        { statId: "all_physical_damage", multi: 1.51 },
        { statId: "area_dmg", multi: 1.15 },
      ],
      finalDamage: 13041,
    },
  ],
};

function damageFixture(observed: ObservedDamage): Fixture {
  return {
    name: "damage-log",
    build: { schemaVersion: 1, character: { level: 100 } },
    observed: {
      source: "damage_log",
      capturedAt: "2026-09-15",
      mineAndSlashVersion: "1.20.1-6.4.13",
      packVersion: "2.0.2",
      stats: [],
      damage: [observed],
    },
  };
}

/** An engine that answers with the log itself, optionally with one row bent. */
function engineAgreeing(bend: (d: ComputedDamage) => void = () => {}): DamageCalculator {
  return () => {
    const answer: ComputedDamage = {
      baseValue: 888,
      hit: 13041.4,
      crit: 0,
      ailmentPerSecond: {},
      totalCombined: 13041.4,
      log: JSON.parse(JSON.stringify(QUAKE_HIT.log)) as NonNullable<ComputedDamage["log"]>,
    };
    bend(answer);
    return answer;
  };
}

function damageRows(
  observed: ObservedDamage,
  calculator: DamageCalculator,
  field: string,
): StatComparison[] {
  const result = compareFixture(damageFixture(observed), makeSnapshot({}), null, { damage: calculator });
  return result.comparisons.filter((c) => c.field === field);
}

test("a log that agrees, row by row, matches on every row", () => {
  const result = compareFixture(damageFixture(QUAKE_HIT), makeSnapshot({}), null, {
    damage: engineAgreeing(),
  });
  const rows = result.comparisons.filter((c) => c.status !== "unimplemented");
  // 3 layers + 3 MOREs + baseDamage + finalDamage + totalCombined.
  assert.equal(rows.length, 9);
  assert.ok(
    rows.every((c) => c.status === "match"),
    `expected every row to match, got ${JSON.stringify(rows.filter((c) => c.status !== "match"))}`,
  );
});

test("an int-cast endpoint is a band, not a symmetric tolerance", () => {
  // The log printed 13041 through a cast, so the game held something in [13041, 13042). An
  // engine at 13041.9 agrees; a plus-or-minus-half-a-point rule would have failed it.
  const high = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.finalDamage = 13041.9;
    }),
    "finalDamage",
  );
  assert.equal(high[0]?.status, "match");
  // Under the band is wrong however slightly, because the cast can only ever round down.
  const under = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.finalDamage = 13040.9;
    }),
    "finalDamage",
  );
  assert.equal(under[0]?.status, "mismatch");
  const over = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.finalDamage = 13042.1;
    }),
    "finalDamage",
  );
  assert.equal(over[0]?.status, "mismatch");
  // Reported as the distance outside the band, so the runner's "off by X" line stays readable
  // for a bound that is not symmetric.
  assert.ok(Math.abs((over[0]?.delta ?? 0) - 0.1) < 1e-9);
});

test("a wrong MORE names the stat rather than the spell", () => {
  const bad = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.moreMultis[1]!.multi = 2.09;
    }),
    "moreMulti",
  ).filter((c) => c.status === "mismatch");
  assert.equal(bad.length, 1);
  // This is the whole point of recording the layer stack: the failure says which factor was
  // wrong, not merely that the total was. That id is a place to go and look.
  assert.equal(bad[0]?.statId, "quake/physical.all_physical_damage");
  assert.equal(bad[0]?.expected, 1.51);
});

test("a multiplier is pinned to the two decimals the mod prints", () => {
  // DECIMAL_FORMAT is "0.00", so a printed 2.72 means the game held [2.715, 2.725].
  const inside = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.layers[1]!.multiplier = 2.7234;
    }),
    "layerMultiplier",
  );
  assert.ok(inside.every((c) => c.status === "match"));
  const bad = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.layers[1]!.multiplier = 2.6533;
    }),
    "layerMultiplier",
  ).filter((c) => c.status === "mismatch");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.statId, "quake/physical.additive_damage[Source]");
});

test("side is part of a layer identity", () => {
  // additive_damage is written by both halves of the event, and the log prints the prefix
  // precisely because the two rows are different rows. The right number on the wrong side has
  // not agreed with anything.
  const missing = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.layers[2]!.side = "Source";
    }),
    "layerMultiplier",
  ).filter((c) => c.status === "missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.statId, "quake/physical.physical_mitigation[Target]");
});

test("a layer the engine never produced is missing, not silently matched", () => {
  const rows = damageRows(
    QUAKE_HIT,
    engineAgreeing((d) => {
      d.log![0]!.layers.splice(0, 1);
    }),
    "layerAmount",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "missing");
  assert.equal(rows[0]?.statId, "quake/physical.flat_damage[Source]");
});

test("an extra engine row is not a failure, because the log prints only what fired", () => {
  // The hover omits a MORE of exactly 1 and any layer that did nothing, and the far commoner
  // cause of a surplus engine row is a capture that did not transcribe every line. Only rows
  // the capture actually recorded are checked.
  const result = compareFixture(damageFixture(QUAKE_HIT), makeSnapshot({}), null, {
    damage: engineAgreeing((d) => {
      d.log![0]!.moreMultis.push({ statId: "total_damage", multi: 1.4 });
      d.log![0]!.layers.push({ layerId: "crit_damage", side: "Source", multiplier: 1.9 });
    }),
  });
  assert.ok(
    result.comparisons.filter((c) => c.status !== "unimplemented").every((c) => c.status === "match"),
  );
});

test("the capture decides which crit branch a reading is about", () => {
  const observed: ObservedDamage = { spellId: "quake", wasCrit: true, hit: 99, crit: 4242 };
  const result = compareFixture(damageFixture(observed), makeSnapshot({}), null, {
    damage: () => ({ baseValue: 0, hit: 99, crit: 4242, ailmentPerSecond: {} }),
  });
  assert.ok(result.comparisons.every((c) => c.status === "match"));
});

test("a bonus element is its own block, keyed by element rather than by position", () => {
  const observed: ObservedDamage = {
    spellId: "quake",
    log: [
      { element: "fire", baseDamage: 10, layers: [], moreMultis: [], finalDamage: 12 },
      { element: "physical", baseDamage: 888, layers: [], moreMultis: [], finalDamage: 13041 },
    ],
  };
  // The engine emits the hit's own element first and the conversion child after it, which is
  // the opposite order to this capture. Keying by element is what lines the two up anyway.
  const result = compareFixture(damageFixture(observed), makeSnapshot({}), null, {
    damage: () => ({
      baseValue: 0,
      hit: 0,
      crit: 0,
      ailmentPerSecond: {},
      log: [
        { element: "physical", baseDamage: 888.2, layers: [], moreMultis: [], finalDamage: 13041.6 },
        { element: "fire", baseDamage: 10.1, layers: [], moreMultis: [], finalDamage: 12.4 },
      ],
    }),
  });
  const rows = result.comparisons.filter((c) => c.status !== "unimplemented");
  assert.equal(rows.length, 4);
  assert.ok(rows.every((c) => c.status === "match"));
});
