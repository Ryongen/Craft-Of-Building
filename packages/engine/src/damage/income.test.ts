/**
 * `skillIncome` — leech from every source banks into one pool, so the cap applies once; a
 * skill's restore acts are heals and are not capped.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeTo } from "../test-support.js";
import type { BasicAttack } from "./basic-attack.js";
import type { DpsResult, FullDpsResult } from "./dps.js";
import { skillIncome } from "./income.js";

type LeechRow = { resource: string; generatedPerCast: number; generatedPerSecond: number; capPerSecond: number };
type RestoreRow = { resource: string; perFiring: number; firingsPerCast: number; perSecond: number; limitGroup?: string };

function result(cycleSeconds: number, leech: LeechRow[], restores: RestoreRow[] = [], procs: unknown[] = []): DpsResult {
  return {
    spellId: "skill",
    rate: { castsPerCycle: 1, cycleSeconds },
    procs,
    cost: {
      leech: {
        byResource: leech.map((row) => ({
          ...row,
          sources: [{ statId: "manasteal", effectId: "leech_mana", perSecond: 1 }],
        })),
      },
      restores: {
        byResource: restores.map((row) => ({
          resource: row.resource,
          perCast: row.perFiring * row.firingsPerCast,
          perSecond: row.perSecond,
          sources: [{ ...row, sourceId: "block#3" }],
        })),
      },
    },
  } as unknown as DpsResult;
}

function rotation(
  seconds: number,
  entries: { result: DpsResult; presses: number; limitShare?: unknown }[],
): FullDpsResult {
  return {
    rotationSeconds: seconds,
    procs: [],
    skills: entries.map((e) => ({
      skill: { spellId: "skill" },
      result: e.result,
      role: "rotation",
      pressesPerRotation: e.presses,
      ...(e.limitShare === undefined ? {} : { limitShare: e.limitShare }),
    })),
  } as unknown as FullDpsResult;
}

function swing(generatedPerSecond: number, capPerSecond: number): BasicAttack {
  return {
    untimed: false,
    procs: [],
    leech: {
      byResource: [
        {
          resource: "mana",
          generatedPerSecond,
          capPerSecond,
          sources: [{ statId: "mana_on_basic_hit", effectId: "x", perSecond: 1 }],
        },
      ],
    },
  } as unknown as BasicAttack;
}

const LEECH = { resource: "mana", generatedPerCast: 100, generatedPerSecond: 100, capPerSecond: 150 };

test("a rotation's leech is summed over the pass and capped once for the pool", () => {
  const two = (seconds: number) =>
    skillIncome({ fullDps: rotation(seconds, [{ result: result(1, [LEECH]), presses: 1 }, { result: result(1, [LEECH]), presses: 1 }]) });
  const slow = two(2).byResource[0]!;
  closeTo(slow.leechGenerated, 100);
  closeTo(slow.leech, 100);

  // 200/s generated against a 150/s cap.
  const fast = two(1).byResource[0]!;
  closeTo(fast.leechGenerated, 200);
  closeTo(fast.leech, 150);
});

test("a restore is a heal: listed apart from leech and never capped", () => {
  const totem = result(2, [LEECH], [{ resource: "mana", perFiring: 100, firingsPerCast: 8, perSecond: 400 }]);
  const mana = skillIncome({ fullDps: rotation(1, [{ result: totem, presses: 1 }]) }).byResource[0]!;
  closeTo(mana.restored, 800);
  closeTo(mana.leech, 100);
  closeTo(mana.total, 900);
  assert.deepEqual(mana.sources.map((s) => s.kind).sort(), ["leech", "restore"]);
});

test("the rotation's shared summon limit thins a limited restore and the totem's leech", () => {
  const totem = result(2, [LEECH], [
    { resource: "mana", perFiring: 100, firingsPerCast: 8, perSecond: 400, limitGroup: "totem" },
  ]);
  const limitShare = { group: "totem", maxAlive: 3, aliveShare: 0.25, damageShare: 0.5 };
  const mana = skillIncome({ fullDps: rotation(1, [{ result: totem, presses: 1, limitShare }]) }).byResource[0]!;
  closeTo(mana.restored, 800 * 0.25);
  closeTo(mana.leechGenerated, 100 * 0.5);
});

test("swings share the bank with the casts, and the main skill stands in when nothing is ticked", () => {
  const main = result(1, [{ resource: "mana", generatedPerCast: 50, generatedPerSecond: 50, capPerSecond: 80 }]);
  const income = skillIncome({ fullDps: rotation(0, []), dps: main, basic: swing(60, 80) });
  const mana = income.byResource[0]!;
  assert.equal(income.basis, "main");
  assert.equal(income.swings, true);
  closeTo(mana.leechGenerated, 110);
  closeTo(mana.fromSwings, 60);
  closeTo(mana.leech, 80);
});

test("a proc's own restore counts at the proc's rate", () => {
  const glacialMend = {
    statId: "proc_hoarfrost_armor_heal_on_basic_hit",
    spellId: "hoarfrost_armor_heal",
    perSecond: 2,
    restoresPerProc: [{ resource: "health", amount: 1000 }],
  };
  const income = skillIncome({ dps: result(1, [], [], [glacialMend]) });
  const health = income.byResource.find((r) => r.resource === "health")!;
  closeTo(health.restored, 2000);
  assert.equal(health.sources[0]?.via, "proc");
});
