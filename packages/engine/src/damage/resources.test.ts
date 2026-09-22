/**
 * Per-second regeneration.
 *
 * Three kinds of stat feed one number, and the engine used to read only the first. These pin all
 * three, plus the two things that make blood different from every other pool.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { baseStats, closeTo, engineSnapshot, exact, statEntry } from "../test-support.js";
import type { Sheet } from "./ctx.js";
import { budget, leech, resources, resourceSpent } from "./resources.js";

/** The `on_restore_resource` blocks this pack ships, as `mmorpg_stat` writes them. */
const REGEN_STATS: Record<string, Record<string, unknown>> = {
  resource_regen: statEntry("resource_regen", {
    is_perc: true,
    effect: [
      {
        effects: ["_additive_damage_number_add_stat_data"],
        events: ["on_restore_resource"],
        ifs: ["restore_type_is_regen", "is_resource_restore"],
        order: "damage_layers",
        side: "Source",
      },
    ],
  }),
  out_of_combat_regen: statEntry("out_of_combat_regen", {
    is_perc: true,
    effect: [
      {
        effects: ["_additive_damage_number_add_stat_data"],
        events: ["on_restore_resource"],
        ifs: ["restore_type_is_regen", "is_in_combat_is_false"],
        order: "damage_layers",
        side: "Source",
      },
    ],
  }),
  inc_leech: statEntry("inc_leech", {
    is_perc: true,
    effect: [
      {
        effects: ["_additive_damage_number_add_stat_data"],
        events: ["on_restore_resource"],
        ifs: ["restore_type_is_leech"],
        order: "damage_layers",
        side: "Source",
      },
    ],
  }),
  blood_regen: statEntry("blood_regen", {
    is_perc: true,
    effect: [
      {
        effects: ["_additive_damage_number_add_stat_data"],
        events: ["on_restore_resource"],
        ifs: ["restore_type_is_regen", "resource_type_is_blood"],
        order: "damage_layers",
        side: "Source",
      },
    ],
  }),
};

const CONDITIONS: Record<string, Record<string, unknown>> = {
  is_in_combat: { id: "is_in_combat", ser: "is_in_combat" },
  is_in_combat_is_false: { id: "is_in_combat_is_false", is: false, ser: "is_in_combat" },
  restore_type_is_leech: {
    id: "restore_type_is_leech",
    ser: "string_matches",
    string_id: "leech",
    string_key: "restore_type",
  },
  restore_type_is_regen: {
    id: "restore_type_is_regen",
    ser: "string_matches",
    string_id: "regen",
    string_key: "restore_type",
  },
  resource_type_is_mana: {
    id: "resource_type_is_mana",
    ser: "string_matches",
    string_id: "mana",
    string_key: "resource_type",
  },
  resource_type_is_energy: {
    id: "resource_type_is_energy",
    ser: "string_matches",
    string_id: "energy",
    string_key: "resource_type",
  },
  resource_type_is_blood: {
    id: "resource_type_is_blood",
    ser: "string_matches",
    string_id: "blood",
    string_key: "resource_type",
  },
  is_resource_restore: {
    id: "is_resource_restore",
    ser: "either_is_true",
    ifs: ["resource_type_is_mana", "resource_type_is_blood", "resource_type_is_energy"],
  },
};

const EFFECTS: Record<string, Record<string, unknown>> = {
  _additive_damage_number_add_stat_data: {
    id: "_additive_damage_number_add_stat_data",
    ser: "modify_stat_layer",
    layer: "additive_damage",
    modification: "ADD",
    number_modifiers: [],
    number_provider: { type: "STAT_DATA", calc: "" },
    number_to_modify: "number",
  },
};

function snapshotOf(stats: Record<string, number>) {
  return engineSnapshot({
    mmorpg_stat: REGEN_STATS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_stat_effect: EFFECTS,
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
  });
}

function character(stats: Record<string, number>) {
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  return resources(build, snapshotOf(stats), { newbieResists: false });
}

const of = (r: ReturnType<typeof character>, id: string) =>
  r.byResource.find((entry) => entry.resource === id)!;

test("regen is the flat stat plus a share of the pool, per second", () => {
  // `BaseRegenClass` adds `<r>_regen` flat; `RegeneratePercentStat` adds `max * <r>_per_sec / 100`.
  // Reading only the first is what `dps.ts` used to do, and it is the smaller half on any build
  // that scales its pool.
  const result = character({ mana: 1000, mana_regen: 20, mana_per_sec: 5 });
  const mana = of(result, "mana");

  assert.equal(mana.max, 1000);
  assert.equal(mana.flat, 20);
  assert.equal(mana.fromPercentOfMax, 50);
  closeTo(mana.perSecond, 70);
  closeTo(mana.secondsToFull, 1000 / 70);
});

test("the datapack percents multiply what the flat stats seeded", () => {
  // `resource_regen` is an `on_restore_resource` block writing to `additive_damage`, which is a
  // MULTIPLY layer — so it scales the tick rather than adding to it. Summing the stats by hand
  // would leave it on the floor entirely.
  const plain = character({ mana: 1000, mana_regen: 100 });
  const boosted = character({ mana: 1000, mana_regen: 100, resource_regen: 50 });

  closeTo(of(plain, "mana").perSecond, 100);
  closeTo(of(boosted, "mana").perSecond, 150);
  // The seed is untouched; the multiplier is what changed.
  assert.equal(of(boosted, "mana").base, 100);
});

test("a per-resource percent only reaches its own resource", () => {
  // `is_resource_restore` is mana, blood or energy — health and magic shield are deliberately not
  // in it — and `resource_type_is_blood` narrows further still.
  const result = character({
    mana: 1000,
    mana_regen: 100,
    health: 1000,
    health_regen: 100,
    resource_regen: 50,
  });

  closeTo(of(result, "mana").perSecond, 150);
  closeTo(of(result, "health").perSecond, 100, "health is not a `resource` for this stat");
});

test("blood has no tick of its own; hp_resto_to_blood is what fills it", () => {
  // `OnServerTick` raises a regen event for mana, energy, magic shield and health and for nothing
  // else — verified in 6.4.13. `HealthRestorationToBloodEffect` rides the health event at
  // `FINAL_DAMAGE`, takes a percentage of its finished number and raises a blood event with the
  // same restore type, which is how `blood_regen` gets something to multiply.
  const none = character({ blood: 500, health: 1000, health_regen: 200 });
  assert.equal(of(none, "blood").perSecond, 0);
  assert.match(of(none, "blood").note ?? "", /no regeneration tick of its own/);

  const fed = character({ blood: 500, health: 1000, health_regen: 200, hp_resto_to_blood: 25 });
  closeTo(of(fed, "blood").perSecond, 50, "a quarter of 200 health regen");

  // And the blood event's own percent applies on top of the redirected number.
  const boosted = character({
    blood: 500,
    health: 1000,
    health_regen: 200,
    hp_resto_to_blood: 25,
    blood_regen: 100,
  });
  closeTo(of(boosted, "blood").perSecond, 100);
});

test("the Blood Magic game changer is reported, and changes no regeneration", () => {
  // `BloodUserEffect` is on `SpendResourceEvent`: it rewrites which pool a mana cost comes out of
  // and touches nothing else. Mana keeps filling at exactly the same rate; you simply stop
  // spending it.
  const plain = character({ mana: 1000, mana_regen: 100, blood: 500 });
  const blood = character({ mana: 1000, mana_regen: 100, blood: 500, blood_user: 1 });

  assert.equal(plain.bloodMage, false);
  assert.equal(blood.bloodMage, true);
  closeTo(of(blood, "mana").perSecond, of(plain, "mana").perSecond);
  assert.ok(blood.diagnostics.some((d) => d.code === "blood-magic-active"));
});

test("the in-combat column drops what is gated on being out of combat", () => {
  // `out_of_combat_regen` is a datapack stat gated on `is_in_combat_is_false`, and `in_combat` is
  // a ten-second cooldown re-stamped by every hit either way — so a rotation never sees it. The
  // two columns are the two answers; pinning the condition per column is what keeps a document
  // that states one from silently producing it twice.
  const result = character({ mana: 1000, mana_regen: 100, out_of_combat_regen: 50 });
  const mana = of(result, "mana");

  closeTo(mana.perSecond, 150, "resting");
  closeTo(mana.inCombatPerSecond, 100, "fighting");
});

test("in_combat_regen_multi halves everything but energy, and this pack sets it to 1", () => {
  // `RestoreResourceEvent.activate` applies it outside the layers, so no stat can see it, and it
  // names energy as the exemption. The mod default is 0.5; Craft to Exile 2 ships 1.0 in
  // `defaultconfigs/mine_and_slash-server.toml`, which is why it is an option rather than a
  // constant.
  const stats = { mana: 1000, mana_regen: 100, energy: 1000, energy_regen: 100 };
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const snapshot = snapshotOf(stats);

  const pack = resources(build, snapshot, { newbieResists: false });
  closeTo(of(pack, "mana").inCombatPerSecond, 100);

  const vanilla = resources(build, snapshot, { newbieResists: false, inCombatRegenMulti: 0.5 });
  closeTo(of(vanilla, "mana").inCombatPerSecond, 50);
  closeTo(of(vanilla, "energy").inCombatPerSecond, 100, "energy is exempt by name");
  closeTo(of(vanilla, "mana").perSecond, 100, "and resting is untouched");

  // A player on a server that kept the mod default says so in the document, because no snapshot
  // can: the value lives in a server toml the extractor never reads.
  const stated = { ...build, config: { inCombatRegenMulti: 0.5 } } as BuildDoc;
  const fromDoc = resources(stated, snapshot, { newbieResists: false });
  closeTo(of(fromDoc, "mana").inCombatPerSecond, 50);
  assert.equal(fromDoc.inCombatRegenMulti, 0.5);

  // An explicit option still wins, for a caller that already knows.
  const overridden = resources(stated, snapshot, { newbieResists: false, inCombatRegenMulti: 1 });
  closeTo(of(overridden, "mana").inCombatPerSecond, 100);
});

test("leech is banked and metered out at the pool's cap, not restored", () => {
  // `onSecondUseLeeches` drains `leech_cap% * max` a second and clamps the bank to five seconds
  // of that, so a build leeching far above its cap gains nothing from leeching harder. The base
  // cap is 5 on every pool — `BaseStatsAdder` — which is where the familiar "5% a second" comes
  // from, and it is a stat, so gear can raise it.
  const snapshot = snapshotOf({ health: 1000, health_leech_cap: 5 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const record = (amount: number) => [
    { statId: "lifesteal", effectId: "leech_health", resource: "health", restoreType: "leech", amount },
  ];

  const under = leech({ build, snapshot, perSecond: record(20), options: { newbieResists: false } });
  const health = under.byResource.find((e) => e.resource === "health")!;
  assert.equal(health.capPercent, 5);
  closeTo(health.capPerSecond, 50, "5% of a 1000 pool");
  closeTo(health.perSecond, 20, "below the cap, you keep all of it");
  assert.equal(health.capped, false);
  closeTo(health.bankCeiling, 250, "five seconds of payout");

  const over = leech({ build, snapshot, perSecond: record(5000), options: { newbieResists: false } });
  const capped = over.byResource.find((e) => e.resource === "health")!;
  closeTo(capped.perSecond, 50, "above it, the surplus is thrown away");
  assert.equal(capped.capped, true);
  assert.ok(over.diagnostics.some((d) => d.code === "leech-capped"));
});

test("a zero leech cap makes leech worth nothing at all, and says so", () => {
  // The clamp runs before the drain, so a 0 cap empties the bank rather than banking it.
  const snapshot = snapshotOf({ health: 1000 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const result = leech({
    build,
    snapshot,
    perSecond: [
      { statId: "lifesteal", effectId: "leech_health", resource: "health", restoreType: "leech", amount: 500 },
    ],
    options: { newbieResists: false },
  });

  closeTo(result.byResource.find((e) => e.resource === "health")!.perSecond, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "leech-cap-zero"));
});

test("inc_leech applies on the way into the bank, which is a 6.4.13 change", () => {
  // In 6.4.8 `RestoreResourceAction` pooled the number itself and returned before raising the
  // event, so `inc_leech` — which lives on `on_restore_resource` — could never fire. 6.4.13
  // always raises the event and `RestoreResourceEvent.activate` does the pooling, so the layers
  // run first. Verified against the jar's bytecode; the checkout disagrees and loses.
  const snapshot = snapshotOf({ health: 100000, health_leech_cap: 5, inc_leech: 50 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const result = leech({
    build,
    snapshot,
    perSecond: [
      { statId: "lifesteal", effectId: "leech_health", resource: "health", restoreType: "leech", amount: 100 },
    ],
    options: { newbieResists: false },
  });

  const health = result.byResource.find((e) => e.resource === "health")!;
  closeTo(health.seedPerSecond, 100);
  closeTo(health.generatedPerSecond, 150, "the pool is far above the cap, so nothing clips it");
  closeTo(health.perSecond, 150);
});

test("the budget says which pool runs dry and how long a full one lasts", () => {
  const snapshot = snapshotOf({ mana: 1000, mana_regen: 100, mana_leech_cap: 5 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const regen = resources(build, snapshot, { newbieResists: false });
  const leeched = leech({
    build,
    snapshot,
    perSecond: [
      { statId: "manasteal", effectId: "leech_mana", resource: "mana", restoreType: "leech", amount: 25 },
    ],
    options: { newbieResists: false },
  });

  // 100 regen + 25 leech against 200 spent: 75 a second out of a 1000 pool.
  const rows = budget({
    regen,
    leech: leeched,
    perCast: new Map([["mana", 100]]),
    castsPerSecond: 2,
  });
  const mana = rows.find((r) => r.resource === "mana")!;
  closeTo(mana.regenPerSecond, 100);
  closeTo(mana.leechPerSecond, 25);
  closeTo(mana.costPerSecond, 200);
  closeTo(mana.netPerSecond, -75);
  assert.equal(mana.sustainable, false);
  closeTo(mana.secondsToEmpty, 1000 / 75);
  closeTo(mana.castsBeforeEmpty, (1000 / 75) * 2);

  // Halve the rate and it pays for itself.
  const slower = budget({
    regen,
    leech: leeched,
    perCast: new Map([["mana", 100]]),
    castsPerSecond: 1,
  });
  assert.equal(slower.find((r) => r.resource === "mana")!.sustainable, true);
  assert.equal(slower.find((r) => r.resource === "mana")!.secondsToEmpty, undefined);
});

/** A one-stat sheet, which is all `resourceSpent` reads. */
const sheetOf = (stats: Record<string, number>): Sheet =>
  new Map(
    Object.entries(stats).map(([id, value]) => [
      id,
      { value, dmgMulti: 1, hardcap: Number.MAX_VALUE, softcap: 0 },
    ]),
  );

test("Blood Magic redirects energy as well as mana", () => {
  // `BloodUserEffect.canActivate` in 6.4.13:
  //
  //     if (effect.data.getResourceType() == ResourceType.mana
  //             || effect.data.getResourceType() == ResourceType.energy) { return true; }
  //
  // The 6.4.8 checkout tests mana alone, and a port read off it bills a weapon skill's energy to
  // the energy pool — which Blood Magic has just zeroed. Every other pool is left alone: nothing
  // raises a health or magic-shield spend through this event.
  const blood = sheetOf({ blood_user: 1 });
  const plain = sheetOf({});

  assert.equal(resourceSpent(blood, "mana"), "blood");
  assert.equal(resourceSpent(blood, "energy"), "blood");
  assert.equal(resourceSpent(blood, "health"), "health");
  assert.equal(resourceSpent(blood, "magic_shield"), "magic_shield");

  assert.equal(resourceSpent(plain, "mana"), "mana");
  assert.equal(resourceSpent(plain, "energy"), "energy");
});

test("a pool that cannot hold one cast is not sustainable, however fast it regenerates", () => {
  // Taking Blood Magic zeroes `mana` and `energy` both — the captured level-100 blood mage reads
  // 0 for each — while leaving a large `energy_regen` on the sheet. A pool never fills past its
  // maximum, so comparing rates alone called that build comfortable while it could not have paid
  // for a single cast out of the pool it was being billed against.
  const snapshot = snapshotOf({ energy: 0, energy_regen: 1269 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const regen = resources(build, snapshot, { newbieResists: false });
  const leeched = leech({ build, snapshot, perSecond: [], options: { newbieResists: false } });

  const rows = budget({
    regen,
    leech: leeched,
    perCast: new Map([["energy", 258]]),
    castsPerSecond: 2.857,
  });
  const energy = rows.find((r) => r.resource === "energy")!;

  closeTo(energy.regenPerSecond, 1269, "the regen stat is real; the ceiling is what is missing");
  assert.ok(energy.netPerSecond > 0, "the rate comparison on its own passes");
  assert.equal(energy.holdsACast, false);
  assert.equal(energy.sustainable, false);

  // A pool big enough for one cast is judged on its rate again, as before.
  const holds = budget({
    regen: resources(build, snapshotOf({ energy: 1000, energy_regen: 1269 }), {
      newbieResists: false,
    }),
    leech: leeched,
    perCast: new Map([["energy", 258]]),
    castsPerSecond: 2.857,
  }).find((r) => r.resource === "energy")!;
  assert.equal(holds.holdsACast, true);
  assert.equal(holds.sustainable, true);
});

test("a `heal` restore lands whole, and the leech cap has nothing to say about it", () => {
  // `RestoreResourceEvent.activate` branches on the restore type before it pools anything:
  //
  //     if (data.getRestoreType() == RestoreType.leech) {
  //         this.targetData.leech.addLeech(data.getResourceType(), num);
  //         return;
  //     }
  //     this.targetData.getResources().restore(target, data.getResourceType(), num);
  //
  // so only a leech joins the bank that `<r>_leech_cap` meters out. `dmg_taken_to_mana` builds
  // its restore with `RestoreType.heal` — a `getstatic RestoreType.heal` in the 6.4.13 bytecode,
  // not an inference — and is therefore uncapped and immediate.
  //
  // Pinned because the two records are one field apart and the cap is silent when it is wrong:
  // a heal counted as leech on a build at its cap would simply vanish.
  const snapshot = snapshotOf({ mana: 1000, mana_leech_cap: 5 });
  const build = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  const of = (restoreType: string) => [
    { statId: "dmg_taken_to_mana", effectId: "dmg_taken_to_mana", resource: "mana", restoreType, amount: 500 },
  ];

  const asLeech = leech({ build, snapshot, perSecond: of("leech"), options: { newbieResists: false } });
  closeTo(
    asLeech.byResource.find((e) => e.resource === "mana")!.perSecond,
    50,
    "5% of a 1000 pool is all a leech of 500 pays out",
  );

  const asHeal = leech({ build, snapshot, perSecond: of("heal"), options: { newbieResists: false } });
  assert.equal(
    asHeal.byResource.find((e) => e.resource === "mana"),
    undefined,
    "a heal is not leech, so the leech pass does not claim it and cannot cap it",
  );
});
