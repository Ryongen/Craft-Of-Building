/**
 * `mmorpg_mob_affix` on the target.
 *
 * The target is the one unverified half of every damage figure this project produces, and until
 * this existed the only way to describe a real mob was to type an armour number into
 * `config.enemy`. An affix is the game's own answer, and the Training Dummy mod's — its presets
 * "pin no numbers at all", they set the rarity and let Mine and Slash build the block, with
 * affixes as toggles on top.
 *
 * `MobAffix.getStatAndContext` is four lines and every one of them is pinned below: fixed at
 * 100%, scaled to the *mob's* level, folded into the same accumulator as your debuffs, and with
 * the aggregate resists expanded to the elements they cover.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { balance } from "../balance.js";
import { statIndex } from "../stat-def.js";
import {
  baseStats,
  closeTo,
  engineSnapshot,
  exact,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { defence } from "./defence.js";
import { mobAffixMods } from "./mob-affixes.js";
import { simulateHit } from "./simulate.js";

function scenario(granted: Record<string, unknown>[] = [exact("armor", "FLAT", 0)]) {
  return engineSnapshot({
    mmorpg_value_calc: { hit1000: valueCalcEntry("hit1000", { min: 1000, max: 1000 }) },
    mmorpg_spells: {
      strike: spellEntry("strike", "Physical", "hit1000"),
      flame: spellEntry("flame", "Fire", "hit1000"),
    },
    mmorpg_stat: {
      armor: statEntry("armor", { scaling: "NORMAL" }),
      accuracy: statEntry("accuracy", { scaling: "NORMAL" }),
      fire_resist: statEntry("fire_resist"),
      water_resist: statEntry("water_resist"),
      lightning_resist: statEntry("lightning_resist"),
    },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", granted) },
    mmorpg_mob_affix: {
      armored: {
        type: "prefix",
        format: "GREEN",
        id: "armored",
        stats: [
          { type: "FLAT", max: 10, min: 10, stat: "armor" },
          { type: "MORE", max: 20, min: 20, stat: "armor" },
        ],
      },
      accurate: {
        type: "prefix",
        format: "GREEN",
        id: "accurate",
        stats: [{ type: "FLAT", max: 8, min: 8, stat: "accuracy" }],
      },
      of_elemental_resistance: {
        type: "suffix",
        format: "GREEN",
        id: "of_elemental_resistance",
        stats: [{ type: "FLAT", max: 40, min: 40, stat: "elemental_resist" }],
      },
      // The pack's own `penetrating`, which is what found the bug the last test here pins: an
      // aggregate, a per-element id and a defence rating, in one affix.
      penetrating: {
        type: "prefix",
        format: "GREEN",
        id: "penetrating",
        stats: [
          { type: "FLAT", max: 6, min: 6, stat: "armor_penetration" },
          { type: "FLAT", max: 25, min: 25, stat: "elemental_penetration" },
          { type: "FLAT", max: 25, min: 25, stat: "chaos_penetration" },
        ],
      },
    },
  });
}

/** The same registries, over a character who actually has resists to penetrate. */
function resistedScenario() {
  return scenario([
    exact("armor", "FLAT", 0),
    exact("health", "FLAT", 1000),
    exact("fire_resist", "FLAT", 50),
    exact("water_resist", "FLAT", 50),
    exact("lightning_resist", "FLAT", 50),
    exact("chaos_resist", "FLAT", 50),
  ]);
}

function build(config: Record<string, unknown> = {}, spellId = "strike"): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 100 },
    skills: [{ spellId, main: true }],
    config,
  } as BuildDoc;
}

const index = () => statIndex(scenario());
const bal = () => balance(scenario());
const silent = (): void => {};

test("an affix is fixed at 100% and scales to the mob's level, not the character's", () => {
  // `x.ToExactStat(100, Load.Unit(en).getLevel())`. `armor` scales; the MORE does not, because
  // `Stat.scale` is a no-op for anything but FLAT.
  const at100 = mobAffixMods(scenario(), index(), bal(), 100, ["armored"], silent);
  const at1 = mobAffixMods(scenario(), index(), bal(), 1, ["armored"], silent);

  assert.equal(at100.find((m) => m.type === "MORE")?.value, 20);
  assert.equal(at1.find((m) => m.type === "MORE")?.value, 20);

  const flat100 = at100.find((m) => m.type === "FLAT")?.value ?? 0;
  const flat1 = at1.find((m) => m.type === "FLAT")?.value ?? 0;
  assert.equal(flat1, 10);
  assert.ok(flat100 > flat1, `a level 100 mob's armour should out-scale a level 1 one's`);
});

test("an affix's armour mitigates the hit, stacking with the declared armour", () => {
  // `(base + Flat) × (1 + Percent/100) × Multi` over the sum, so the affix's FLAT lands on top of
  // the number the document already stated rather than replacing it.
  const bare = simulateHit(build({ enemy: { level: 100, armor: 0 } }), scenario());
  const affixed = simulateHit(build({ enemy: { level: 100, armor: 0, affixes: ["armored"] } }), scenario());
  const both = simulateHit(build({ enemy: { level: 100, armor: 400, affixes: ["armored"] } }), scenario());
  assert.ok(bare && affixed && both);

  // An unarmoured mob spends no mitigation layer at all.
  assert.equal(bare.hit.trace, undefined);
  assert.ok(affixed.hit.total < bare.hit.total, "an armoured mob must take less");
  assert.ok(both.hit.total < affixed.hit.total, "declared armour and the affix must compound");
});

test("an aggregate resist is expanded to the elements it covers", () => {
  // `of_elemental_resistance` writes `elemental_resist`, and `code-only-effects.ts` registers one
  // mitigation effect per *single* element. Without `targetStats` on the way onto the enemy's
  // sheet the affix moved nothing at all — it is declared as the aggregate, so the affix itself
  // still reports the aggregate.
  assert.deepEqual(
    mobAffixMods(scenario(), index(), bal(), 100, ["of_elemental_resistance"], silent).map((m) => m.statId),
    ["elemental_resist"],
  );

  const enemy = { level: 100, armor: 0 };
  const affixed = { ...enemy, affixes: ["of_elemental_resistance"] };

  // 40% elemental resist takes 40% off a fire hit...
  const fireBare = simulateHit(build({ enemy }, "flame"), scenario());
  const fireResisted = simulateHit(build({ enemy: affixed }, "flame"), scenario());
  assert.ok(fireBare && fireResisted);
  closeTo(fireResisted.hit.total, fireBare.hit.total * 0.6);

  // ...and nothing off a physical one, which is what makes it the *elemental* aggregate.
  const physBare = simulateHit(build({ enemy }), scenario());
  const physResisted = simulateHit(build({ enemy: affixed }), scenario());
  assert.ok(physBare && physResisted);
  closeTo(physResisted.hit.total, physBare.hit.total);
});

test("a duplicate id counts once, and an unknown one is reported rather than ignored", () => {
  const twice = mobAffixMods(scenario(), index(), bal(), 100, ["armored", "armored"], silent);
  const once = mobAffixMods(scenario(), index(), bal(), 100, ["armored"], silent);
  assert.deepEqual(twice, once);

  const reported: string[] = [];
  const mods = mobAffixMods(scenario(), index(), bal(), 100, ["nope"], (_s, code) => {
    reported.push(code);
  });
  assert.deepEqual(mods, []);
  assert.deepEqual(reported, ["unknown-mob-affix"]);
});

test("more than one prefix is allowed but reported", () => {
  // `MobAffixesData` rolls at most one of each. A planner may still want to ask what two cost.
  const result = simulateHit(
    build({ enemy: { level: 100, armor: 0, affixes: ["armored", "accurate"] } }),
    scenario(),
  );
  assert.ok(result);
  assert.ok(result.diagnostics.some((d) => d.code === "mob-affix-count"));

  const one = simulateHit(build({ enemy: { level: 100, armor: 0, affixes: ["armored"] } }), scenario());
  assert.ok(one);
  assert.ok(!one.diagnostics.some((d) => d.code === "mob-affix-count"));
});

// ---------------------------------------------------------------------------
// Why the layer read what it read
// ---------------------------------------------------------------------------

test("the target's own stats carry their provenance, so a mitigation figure is explicable", () => {
  /*
   * The question this exists to answer, asked of a real build: a mythic mob declares 30 cold
   * resistance and the character has 33.61 cold penetration, so `30 - 33.61` should read about
   * x1.13 — and the panel says x1.20. Both are right. Banner of the Piercing Gale takes 16.8
   * off the mob before any of that, so the layer read 13.2, and `trunc(13.2 - 33.61)` is -20.
   *
   * None of those three numbers was reachable from the app: `DamageResult` handed back the
   * character's sheet and the spell's, and the enemy's existed only inside the sweep. So the
   * one row a reader wanted to open was the one that could not be opened, and the honest-looking
   * answer — resolving it against the character, which is what the panel used to do — filed the
   * mob's resistance under the player's own gear.
   */
  const affixed = simulateHit(
    build({ enemy: { level: 100, armor: 0, resists: { fire: 30 } }, affixes: [] }),
    scenario(),
    { element: "Fire", valueCalcId: "hit1000" },
  );
  assert.ok(affixed);

  // A stat nothing aimed at has no origin to report: it is simply what the document declared,
  // and inventing a one-entry history for it would be noise.
  assert.equal(affixed.target.origins.get("fire_resist"), undefined);
  assert.equal(affixed.target.sheet.get("fire_resist")?.value, 30);

  // One that an affix did touch carries the whole chain.
  const withAffix = simulateHit(
    build({
      enemy: { level: 100, armor: 0, resists: { fire: 30 }, affixes: ["of_elemental_resistance"] },
    }),
    scenario(),
    { element: "Fire", valueCalcId: "hit1000" },
  );
  assert.ok(withAffix);

  const origin = withAffix.target.origins.get("fire_resist");
  assert.ok(origin, "an affix touched fire_resist, so it must be explicable");
  assert.equal(origin.declared, 30, "what the document said before anything was aimed at it");
  assert.deepEqual(
    origin.mods.map((m) => ({ source: m.source, type: m.type, value: m.value })),
    [{ source: "of_elemental_resistance", type: "FLAT", value: 40 }],
  );
  assert.equal(origin.final, 70, "30 declared plus the affix's 40");
  // And `final` is not a second opinion — it is what the sweep actually read.
  assert.equal(origin.final, withAffix.target.sheet.get("fire_resist")?.value);
});

test("the target sheet is the enemy's, never the character's", () => {
  // The mistake this guards against is subtle because both sheets have an `armor`. Resolving a
  // `[Target]` row against the character produced a plausible-looking list of the player's own
  // gear under a number none of it is in.
  const hit = simulateHit(build({ enemy: { level: 100, armor: 400 } }), scenario());
  assert.ok(hit);
  assert.equal(hit.target.sheet.get("armor")?.value, 400);
  assert.notEqual(
    hit.target.sheet.get("armor")?.value,
    hit.sheets.character.stats.get("armor")?.value,
  );
});
test("an aggregate on the attacker reaches the elements it covers, not an id nothing reads", () => {
  // The bug: `penetrating` grants `elemental_penetration`, and every mitigation layer is
  // registered per *single* element. In a real calculation the aggregate never survives to be
  // read — `ITransferToOtherStats` empties it into fire, cold and lightning before the first
  // pass — but `defence()` assembles the attacker's sheet by hand from the affix list and never
  // runs that pass. So the stat sat on the sheet as a dead id.
  //
  // What made it hard to see is that the same affix's other two stats *are* real ids:
  // `armor_penetration` is read by the armour layer and `chaos_penetration` by the chaos resist,
  // so a Penetrating mob moved your physical and chaos figures and left fire, cold and lightning
  // exactly where they were. A mob that penetrates every element except the elemental ones is
  // the shape of a missing expansion, not of a rule.
  const snapshot = resistedScenario();
  const bare = defence(build({ enemy: { level: 100 } }), snapshot, { newbieResists: false });
  const pierced = defence(
    build({ enemy: { level: 100, affixes: ["penetrating"] } }),
    snapshot,
    { newbieResists: false },
  );

  const taken = (result: ReturnType<typeof defence>, element: string) =>
    result.byElement.find((e) => e.element === element)!.taken;

  for (const element of ["Fire", "Cold", "Nature", "Shadow"]) {
    assert.ok(
      taken(pierced, element) > taken(bare, element) + 1e-9,
      `${element} has to take more from a penetrating mob: ` +
        `${taken(bare, element)} -> ${taken(pierced, element)}`,
    );
  }

  // And all four move by the same amount, which is the real assertion: `chaos_penetration` is
  // the control, because it was the one per-element id in the affix and therefore the one that
  // worked all along. The three elementals landing on its number is what says the aggregate was
  // spread rather than merely applied to something.
  const chaos = taken(pierced, "Shadow") - taken(bare, "Shadow");
  for (const element of ["Fire", "Cold", "Nature"]) {
    closeTo(taken(pierced, element) - taken(bare, element), chaos, `${element} matches chaos`);
  }
});
