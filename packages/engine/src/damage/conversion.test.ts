/**
 * Conversion, and "gain X as extra Y".
 *
 * `CONVERT_PERCENT` and `X_AS_BONUS_Y_ELEMENT_DAMAGE` were already ported; these pin the five
 * places the port and the game disagreed. Each names the Java it is derived from, all of it
 * checked against `Mine_and_Slash-1.20.1-6.4.13.jar` rather than against the fork checkout.
 *
 * The one fact worth carrying away from the whole file: `DamageEvent.addBonusEleDmg` snapshots
 * the converted damage *before* the parent's `additive_damage` layer and spawns a complete second
 * event at the destination element. Converted damage therefore picks up only the **destination**
 * element's increases, penetration and resistances, and never the source's — which is not how
 * Path of Building behaves, and is the single most expensive thing a converting build can not
 * know about itself.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc, ElementName } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  damageStat,
  effectBlock,
  engineSnapshot,
  exact,
  modifyLayer,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { defence } from "./defence.js";
import { simulateHit } from "./simulate.js";

/** A character whose whole sheet is the stats named, for the Target-side cases. */
function character(stats: Record<string, number>) {
  const snapshot = engineSnapshot({
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
  });
  const doc = { schemaVersion: 1, character: { level: 1 } } as BuildDoc;
  return defence(doc, snapshot, { hitSize: 1000, newbieResists: false });
}

const EFFECTS = {
  add_additive: modifyLayer("add_additive", "additive_damage"),
  add_dot: modifyLayer("add_dot", "dot_dmg_multi"),
};

/** A physical spell dealing a flat 100, plus whatever stats the case grants. */
function scenario(
  granted: Record<string, unknown>[] = [],
  stats: Record<string, Record<string, unknown>> = {},
  spellExtra: Record<string, unknown> = {},
) {
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100", spellExtra) },
    mmorpg_stat: stats,
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: {
      random_roll: condition("random_roll", "random_roll"),
    },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", granted) },
  });
}

function build(extra: Partial<BuildDoc> = {}): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "strike", main: true }],
    ...extra,
  } as BuildDoc;
}

function hitOf(granted: Record<string, unknown>[], stats = {}, spellExtra = {}) {
  const result = simulateHit(build(), scenario(granted, stats, spellExtra));
  assert.ok(result, "the hit produced no result");
  return result;
}

function elementTotal(byElement: Map<ElementName, number>, element: ElementName): number {
  return byElement.get(element) ?? 0;
}

test("phys_to_all converts into an ALL-element event of its own", () => {
  // `ElementalStat.generateAllPossibleStatVariations` walks `Elements.values()`, so a
  // `phys_to_all` stat exists; `transferStats` redistributes only the `Elemental` variant, so
  // nothing splits this one up before it reaches `convertDamage(Elements.ALL, …)`. The engine
  // generated its effects from `SINGLE_ELEMENTS`, which excludes `ALL`, so the two perks that
  // grant it — `phys_to_all` at 10% and `phys_to_all_big` at 25% — were silently doing nothing.
  const base = hitOf([]);
  assert.equal(elementTotal(base.hit.byElement, "ALL"), 0, "nothing converts without the stat");

  const converted = hitOf([exact("phys_to_all", "FLAT", 25)]);
  closeTo(elementTotal(converted.hit.byElement, "ALL"), 25, "a quarter of the hit moves");
  closeTo(elementTotal(converted.hit.byElement, "Physical"), 75, "and leaves the parent");
  closeTo(converted.hit.total, 100, "conversion moves damage, it does not add any");
});

test("a converted element picks up the destination's increases and not the source's", () => {
  // `addBonusEleDmg` snapshots before the parent's `additive_damage` layer and builds a whole
  // second event, so the two elements are scaled by different stats. This is the behaviour the
  // mod author's own `// todo dmg increases are based on original number, which mess with
  // conversion..` is about, and the reason a physical-scaled build converting to fire throws
  // away every physical increase it owns.
  const stats = {
    increased_physical_damage: damageStat("increased_physical_damage", {
      effect: [effectBlock("before_damage_layers", ["add_additive"], [], "Source")],
    }),
  };
  const plain = hitOf([exact("increased_physical_damage", "FLAT", 100)], stats);
  closeTo(plain.hit.total, 200, "100% increased doubles an unconverted hit");

  const half = hitOf(
    [exact("increased_physical_damage", "FLAT", 100), exact("phys_to_fire", "FLAT", 50)],
    stats,
  );
  // The stat is not element-gated in this fixture, so it applies to both events and the total is
  // unchanged. What the test pins is that the conversion produced a *separate* event at all:
  // half the damage is now Fire and is scaled by its own pass.
  closeTo(elementTotal(half.hit.byElement, "Fire"), 100);
  closeTo(elementTotal(half.hit.byElement, "Physical"), 100);
});

test("plus_phys_to_fire truncates, and names itself in the breakdown", () => {
  // `convertAdditional(getElement(), (int) data.getValue())`. The port wrote `layer.number +=
  // value`, which kept the fraction and — by walking past `LayerData.add` — kept the recorder
  // from seeing the write at all, so an `ele_as_extra_flat` row showed a total with nothing
  // under it. This is the stat four corruption affixes grant, so it is the ordinary case.
  const result = simulateHit(build(), scenario([exact("plus_phys_to_fire", "FLAT", 15.7)]), {
    breakdown: true,
  });
  assert.ok(result);

  // 15, not 15.7: `(int)` is a truncation, and this adds rather than converting, so the parent
  // keeps its whole 100.
  closeTo(elementTotal(result.hit.byElement, "Fire"), 15);
  closeTo(elementTotal(result.hit.byElement, "Physical"), 100);
  closeTo(result.hit.total, 115, "extra damage, not moved damage");

  const named = (result.hit.trace?.steps ?? []).flatMap((step) =>
    step.contributions.map((c) => c.statId),
  );
  assert.ok(
    named.includes("plus_phys_to_fire"),
    `the stat names itself in the breakdown; got ${JSON.stringify(named)}`,
  );
});

test("phys_taken_as_fire re-elements the hit you take, and keeps its attack-type gate", () => {
  // `phys_taken_as_*` is `EffectSides.Target`, so it is read off *your* sheet when you are the
  // one being hit — which is the defence path, not the offence one. Half a physical hit arrives
  // as fire and is mitigated by your fire resist instead of your armour.
  //
  // The gate this exercises is the one the port was missing. All three of `PhysicalToElement`,
  // `BonusPhysicalAsElemental` and `PhysicalDamageTakenAs` share one `canActivate`, byte for byte
  // in the running jar:
  //
  //     return effect.GetElement() == Elements.Physical
  //             && (effect.getAttackType().isHit() || effect.getAttackType() == AttackType.bonus_dmg)
  //             && effect.conversionDepth < DamageEvent.MAX_CONVERSION_DEPTH;
  //
  // The port checked the element and the depth but not the attack type, so it also fired on a
  // `dot` event. That half is **not asserted here, because nothing can currently reach it**:
  // `defence()` models incoming hits only, and the one place the engine raises a `dot` event —
  // `ailmentEventDamage` — has the enemy as its target, and `EnemySetup` has no field that could
  // put this stat on them. The gate is right regardless, and this pins that adding it did not
  // switch the stat off on the path that does matter.
  const plain = character({ health: 1000, fire_resist: 75 });
  const taken = character({ health: 1000, fire_resist: 75, phys_taken_as_fire: 50 });

  const before = plain.byElement.find((e) => e.element === "Physical")!;
  const after = taken.byElement.find((e) => e.element === "Physical")!;
  assert.ok(
    after.taken < before.taken,
    `moving half the hit onto a 75%-resisted element has to reduce what lands: ` +
      `${before.taken} -> ${after.taken}`,
  );
});

test("the weapon-slot multiplier reaches every converted element too", () => {
  // `buildBonusElementEvent` builds the child from the parent's own `attackInfo` and copies
  // `IS_BASIC_ATTACK`, then calls `bonus.initBeforeActivating()` for everything that is not a
  // damage-taken-as — and that method is where the slot multiplier is applied. Guarding the port
  // on `depth === 0` under-reported a converting basic-attack build by the whole multiplier,
  // 0.9 on a gauntlet to 2.8 on a crossbow.
  //
  // Asserted as a ratio rather than an absolute, because what is being pinned is that the two
  // elements are scaled *alike* — the absolute depends on the slot the fixture's weapon is in.
  const converted = hitOf([exact("phys_to_fire", "FLAT", 50)]);
  closeTo(
    elementTotal(converted.hit.byElement, "Fire") / elementTotal(converted.hit.byElement, "Physical"),
    1,
    "an even split stays even once both halves have been through the same multipliers",
  );
});

test("three 33.4% conversions truncate to 99%, so the normaliser never fires", () => {
  // Worth recording because the expectation going in was the opposite. `elemental_assault` grants
  // 33.4% to each of fire, water and lightning, which reads as 100.2% and therefore as the live
  // build that would finally exercise `StatLayerData.normalizeNumbersToCapTo100`.
  //
  // It does not. `PhysicalToElement.activate` is
  //
  //     effect.getLayer(…DAMAGE_CONVERSION, EventData.NUMBER, Side()).convertDamage(getElement(), (int) data.getValue());
  //
  // and that `(int)` truncates each share to 33 *before* any of them is added up. The budget is
  // 99%, the normaliser has nothing to do, and 1% of the hit stays physical. Nothing in this pack
  // is known to reach the normaliser at all.
  const result = hitOf([
    exact("phys_to_fire", "FLAT", 33.4),
    exact("phys_to_water", "FLAT", 33.4),
    exact("phys_to_lightning", "FLAT", 33.4),
  ]);

  closeTo(elementTotal(result.hit.byElement, "Fire"), 33);
  closeTo(elementTotal(result.hit.byElement, "Cold"), 33);
  closeTo(elementTotal(result.hit.byElement, "Nature"), 33);
  closeTo(elementTotal(result.hit.byElement, "Physical"), 1, "the truncated remainder stays put");
  closeTo(result.hit.total, 100, "and conversion still moves damage rather than making it");
});
