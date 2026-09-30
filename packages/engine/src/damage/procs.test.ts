/**
 * The two things a proc that summons gets wrong without being told: what one proc is worth, and
 * how many stats can race for the same cooldown.
 *
 * Arachnid Inoculation is the case. Its buff carries `proc_summon_spider` and
 * `proc_summon_spider_crit`, both casting `summon_spider`, whose pet lives 240 ticks and counts
 * against no cap. `summon_spider` deals nothing itself, so rated on its direct damage every spider
 * was worth 0; and rated per stat, the two rolls each got the whole 10-tick cooldown.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeTo } from "../test-support.js";
import { procCastOf, shareCooldowns, type Proc } from "./procs.js";

function proc(over: Partial<Proc>): Proc {
  return {
    statId: "proc_a",
    spellId: "summon_spider",
    chance: 0.5,
    cooldownTicks: 10,
    triggersPerSecond: 8,
    perSecond: 2,
    boundBy: "cooldown",
    damagePerProc: 1000,
    dps: 2000,
    ...over,
  };
}

test("two stats that proc one spell share its cooldown", () => {
  // `ProcSpellEffect.activate` keys the cooldown on the spell's GUID, so the second roll on a hit
  // finds it already stamped. Each alone would sit at the 2/s cap; together they still do.
  const [a, b] = shareCooldowns([
    proc({ statId: "proc_summon_spider", chance: 0.44 }),
    proc({ statId: "proc_summon_spider_crit", chance: 0.38 }),
  ]);
  closeTo(a!.perSecond + b!.perSecond, 2, "one 10-tick cooldown, not two");
  closeTo(a!.perSecond / b!.perSecond, 0.44 / 0.38, "split by each one's own rate");
  closeTo(a!.dps + b!.dps, 2000);
});

test("below the cap, rolls on the same hit combine as a union, not a sum", () => {
  // One trigger a second at 50% and 50%: a hit summons when either lands, which is 75%.
  const [a, b] = shareCooldowns([
    proc({ statId: "x", chance: 0.5, triggersPerSecond: 1, perSecond: 0.5, boundBy: "trigger" }),
    proc({ statId: "y", chance: 0.5, triggersPerSecond: 1, perSecond: 0.5, boundBy: "trigger" }),
  ]);
  closeTo(a!.perSecond + b!.perSecond, 0.75);
  assert.equal(a!.boundBy, "trigger");
});

test("a proc alone on its spell is left as it was", () => {
  const only = proc({ statId: "solo", spellId: "armageddon" });
  const [out] = shareCooldowns([only, proc({ spellId: "summon_spider", limit: "on-kill", perSecond: 0 })]);
  assert.deepEqual(out, only);
});

test("a proc that summons is worth its pets' whole life, and says how many are out", () => {
  // `summon_spider` casts no damage of its own. One proc brings one spider that bites for 12s.
  const cast = procCastOf({
    damagePerCast: 0,
    critDamagePerCast: 0,
    hit: { critChance: 0.9 },
    sources: [],
    summons: [{ damagePerSummon: 12 * 500, petsPerCast: 1, lifeSeconds: 12 }],
  });
  assert.equal(cast.damage, 6000);
  assert.equal(cast.critChance, 0, "the summoning cast has no crit to speak of");
  assert.deepEqual(cast.pets, { perProc: 1, lifeSeconds: 12 });

  // At two procs a second, 24 spiders are alive at once — nothing caps them.
  const [rated] = shareCooldowns([
    proc({ perSecond: 2, damagePerProc: 6000, dps: 12000, pets: { ...cast.pets!, alive: 0 } }),
  ]);
  closeTo(rated!.pets!.alive, 24);
});
