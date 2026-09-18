import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { AURA_CAPACITY_BASE, auraCapacity } from "./effects.js";
import { baseStats, closeTo, damageStat, engineSnapshot, exact, statEntry } from "../test-support.js";

/**
 * `fury`-shaped: a 4-rank spell whose buff grants a flat 15..30 attack speed.
 *
 * `incOffensive` grants the character `inc_effect_of_offensive_buff_given`, which is how the
 * game produces a `str_multi` above 1 — the real `fury` is tagged `positive, offensive`, and
 * the stat is gated on `effect_has_tag_offensive`.
 */
function snapshot({ incOffensive = 0 }: { incOffensive?: number } = {}) {
  return engineSnapshot({
    mmorpg_stat: {
      attack_speed: statEntry("attack_speed"),
      projectile_count: statEntry("projectile_count"),
      inc_effect_of_offensive_buff_given: statEntry("inc_effect_of_offensive_buff_given"),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        incOffensive === 0
          ? []
          : [exact("inc_effect_of_offensive_buff_given", "FLAT", incOffensive)],
      ),
    },
    mmorpg_spells: {
      fury: { id: "fury", min_lvl: 1, max_lvl: 4, default_lvl: 0 },
      hunters_focus: { id: "hunters_focus", min_lvl: 25, max_lvl: 12, default_lvl: 0 },
    },
    mmorpg_exile_effect: {
      fury: {
        id: "fury",
        max_stacks: 1,
        stacks_affect_stats: true,
        tags: { tags: ["positive", "offensive"] },
        stats: [{ type: "FLAT", stat: "attack_speed", min: 15, max: 30 }],
      },
      hunters_focus: {
        id: "hunters_focus",
        max_stacks: 1,
        stacks_affect_stats: true,
        stats: [{ type: "FLAT", stat: "projectile_count", min: 1, max: 3 }],
      },
    },
  });
}

function build(overrides: Partial<BuildDoc> = {}): BuildDoc {
  return { schemaVersion: 1, character: { level: 100 }, ...overrides };
}

test("an effect with no applying spell rolls its minimum, and says so", () => {
  // `LeveledValue.getValue` returns 0 when the provider is null. That is the game's answer,
  // not a fallback — but it is worth a diagnostic, because a capture that omitted the spell
  // looks identical to a buff that genuinely has none.
  const result = calculate(
    build({ exileEffects: [{ id: "fury" }] }),
    snapshot(),
  );
  assert.equal(result.stats.get("attack_speed")?.value, 15);
  assert.ok(result.diagnostics.some((d) => d.code === "exile-effect-roll-unknown"));
});

test("the roll percent is interpolated over the applying spell's rank", () => {
  // max_lvl 4 + MAX_BONUS_SPELL_LEVELS 8 = 12, so rank 8 is 100/12*8 = 66.67, truncated to 66
  // by the `(int)` cast: 15 + 15 * 0.66 = 24.9.
  const result = calculate(
    build({
      skills: [{ spellId: "fury", level: 8 }],
      exileEffects: [{ id: "fury", spellId: "fury" }],
    }),
    snapshot(),
  );
  assert.ok(Math.abs((result.stats.get("attack_speed")?.value ?? 0) - 24.9) < 1e-9);
  assert.ok(!result.diagnostics.some((d) => d.code === "exile-effect-roll-unknown"));
});

test("the truncation is the (int) cast, not a rounding", () => {
  // hunters_focus: max_lvl 12 + 8 = 20, rank 15 -> exactly 75, no truncation to hide behind.
  const exact = calculate(
    build({
      skills: [{ spellId: "hunters_focus", level: 15 }],
      exileEffects: [{ id: "hunters_focus", spellId: "hunters_focus" }],
    }),
    snapshot(),
  );
  assert.equal(exact.stats.get("projectile_count")?.value, 2.5);

  // rank 7 of 20 is 35 exactly; rank 8 is 40. A rank that lands mid-percent truncates down.
  const trunc = calculate(
    build({
      skills: [{ spellId: "fury", level: 5 }],
      exileEffects: [{ id: "fury", spellId: "fury" }],
    }),
    snapshot(),
  );
  // 100/12*5 = 41.67 -> 41, so 15 + 15*0.41 = 21.15, not 21.25.
  assert.ok(Math.abs((trunc.stats.get("attack_speed")?.value ?? 0) - 21.15) < 1e-9);
});

test("str_multi scales every stat the effect grants, applied last", () => {
  // `result.percentIncrease = (100 * multi) - 100; result.increaseByAddedPercent();` is
  // `v1 *= multi`. 24.9 * 2 = 49.8.
  //
  // The multiplier comes from the sheet rather than from the document, because that is where it
  // comes from in the game: `ExilePotionEvent` starts it at 1 and the `inc_effect_of_*_buff_*`
  // stats add to it.
  const result = calculate(
    build({
      skills: [{ spellId: "fury", level: 8 }],
      exileEffects: [{ id: "fury", spellId: "fury" }],
    }),
    snapshot({ incOffensive: 100 }),
  );
  assert.ok(Math.abs((result.stats.get("attack_speed")?.value ?? 0) - 49.8) < 1e-9);
});

test("a stat that raises buff strength reaches an effect the capture already measured", () => {
  // The Guardian bug. A capture records `str_multi` as it was, and the document keeps it — but
  // it is a pure function of the sheet, so an edit that adds `inc_effect_of_offensive_buff_given`
  // has to move it. Reading the captured number instead meant a whole ascendancy changed nothing:
  // its two +25% defensive-effect nodes left `protection` and `blasphemous_ritual` exactly where
  // the photograph had left them.
  const captured = { id: "fury", spellId: "fury", strMulti: 1 };
  const before = calculate(
    build({ skills: [{ spellId: "fury", level: 8 }], exileEffects: [captured] }),
    snapshot(),
  );
  const after = calculate(
    build({ skills: [{ spellId: "fury", level: 8 }], exileEffects: [captured] }),
    snapshot({ incOffensive: 100 }),
  );

  assert.ok(Math.abs((before.stats.get("attack_speed")?.value ?? 0) - 24.9) < 1e-9);
  assert.ok(Math.abs((after.stats.get("attack_speed")?.value ?? 0) - 49.8) < 1e-9);
});

test("a stat whose tag the effect does not carry leaves it alone", () => {
  // The gate is `effect_has_tag_<tag>`, so the sweep has to match on the effect's own tags and
  // not simply sum every `inc_effect_of_*` stat on the sheet.
  const result = calculate(
    build({
      skills: [{ spellId: "hunters_focus", level: 15 }],
      exileEffects: [{ id: "hunters_focus", spellId: "hunters_focus" }],
    }),
    snapshot({ incOffensive: 100 }),
  );
  // `hunters_focus` here carries no tags at all, so nothing matches and the roll stands alone.
  assert.equal(result.stats.get("projectile_count")?.value, 2.5);
});

test("an aura rolls its stats at the gem's percent, scaled to the player's level", () => {
  // The pack's real `dodge` aura, and the numbers a level 100 character's own stat breakdown
  // printed: `AURA: 34.559998 PERCENT` and `AURA: 134.78401 FLAT`. Both fall out of one gem
  // roll of 83 — the percent interpolates 8..40, the flat interpolates 1.5..7.5 and is then
  // scaled to the character's level (x20.8 at 100), which is what makes it worth having.
  const snap = engineSnapshot({
    mmorpg_stat: { dodge: statEntry("dodge", { scaling: "NORMAL" }) },
    mmorpg_aura: {
      dodge: {
        id: "dodge",
        stats: [
          { type: "PERCENT", stat: "dodge", min: 8, max: 40 },
          { type: "FLAT", stat: "dodge", min: 1.5, max: 7.5, scale_to_lvl: true },
        ],
      },
    },
  });

  const result = calculate(
    { schemaVersion: 1, character: { level: 100 }, auras: [{ id: "dodge", rollPercent: 83 }] },
    snap,
  );
  const mods = result.contexts.filter((c) => c.type === "AURA").flatMap((c) => c.stats);
  const percent = mods.find((m) => m.type === "PERCENT");
  const flat = mods.find((m) => m.type === "FLAT");
  assert.ok(percent && Math.abs(percent.value - 34.56) < 1e-6, `percent ${percent?.value}`);
  assert.ok(flat && Math.abs(flat.value - 134.784) < 1e-3, `flat ${flat?.value}`);
  assert.ok(!result.diagnostics.some((d) => d.code === "aura-roll-unknown"));
});

test("an aura with no recorded roll computes at its minimum, and says so", () => {
  // The failure this replaced was silent: `PlayerData.aurasOn` is empty on the client, so an
  // exporter reading it recorded no auras at all and a third of the character's dodge simply
  // vanished with nothing to point at.
  const snap = engineSnapshot({
    mmorpg_stat: { dodge: statEntry("dodge") },
    mmorpg_aura: {
      dodge: { id: "dodge", stats: [{ type: "PERCENT", stat: "dodge", min: 8, max: 40 }] },
    },
  });
  const result = calculate(
    { schemaVersion: 1, character: { level: 100 }, auras: [{ id: "dodge" }] },
    snap,
  );
  const mods = result.contexts.filter((c) => c.type === "AURA").flatMap((c) => c.stats);
  assert.equal(mods[0]?.value, 8);
  assert.ok(result.diagnostics.some((d) => d.code === "aura-roll-unknown"));
});

// ---------------------------------------------------------------------------
// Food buffs
// ---------------------------------------------------------------------------

/** `life`-shaped: the buff a meal grants, two PERCENT mods over different bands. */
function foodSnapshot() {
  return engineSnapshot({
    mmorpg_stat: { health: statEntry("health"), health_regen: statEntry("health_regen") },
    mmorpg_stat_buff: {
      life: {
        id: "life",
        mods: [
          { type: "PERCENT", stat: "health", min: 5, max: 10 },
          { type: "PERCENT", stat: "health_regen", min: 5, max: 25 },
        ],
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("health", "FLAT", 1000),
        exact("health_regen", "FLAT", 100),
      ]),
    },
  });
}

test("a food buff rolls at its percent plus its level, not at its percent", () => {
  // `StatBuff.getStats` is `mods.map(x -> x.ToExactStat((int) (perc + lvl), lvl))`. A level 100
  // meal rolled at 93 therefore interpolates at 193%, a full band-width past its own maximum:
  // health is 5 + 5 * 1.93 = 14.65% and regen 5 + 20 * 1.93 = 43.6%. Clamping the sum to 100
  // would give 10% and 25%, which is a number the game never produces.
  const result = calculate(
    build({ foodBuffs: [{ id: "life", slot: "meal", level: 100, rollPercent: 93 }] }),
    foodSnapshot(),
  );
  closeTo(result.stats.get("health")?.value, 1000 * 1.1465);
  closeTo(result.stats.get("health_regen")?.value, 100 * 1.436);
});

test("an unticked food buff contributes nothing", () => {
  const result = calculate(
    build({ foodBuffs: [{ id: "life", level: 100, rollPercent: 93, enabled: false }] }),
    foodSnapshot(),
  );
  closeTo(result.stats.get("health")?.value, 1000);
});

test("a food buff with no recorded roll floors at zero and says so", () => {
  const result = calculate(build({ foodBuffs: [{ id: "life", level: 1 }] }), foodSnapshot());
  // perc 0 + lvl 1 = 1%: 5 + 5 * 0.01 = 5.05% health.
  closeTo(result.stats.get("health")?.value, 1000 * 1.0505);
  assert.ok(result.diagnostics.some((d) => d.code === "food-roll-unknown"));
});

// ---------------------------------------------------------------------------
// Context modifiers
// ---------------------------------------------------------------------------

/**
 * An aura granting one FLAT and one MORE, and `aura_effect` on the base stats.
 *
 * The modifier is sourced from BASE_STAT deliberately: it reaches AURA contexts from wherever
 * it is granted, and putting it on the aura itself would make the test about feedback rather
 * than about the modifier.
 */
function auraSnapshot(auraEffect: Record<string, unknown>[]) {
  return engineSnapshot({
    mmorpg_stat: {
      armor: statEntry("armor"),
      aura_effect: statEntry("aura_effect"),
      all_water_damage: damageStat("all_water_damage"),
    },
    mmorpg_aura: {
      fire_res: {
        id: "fire_res",
        stats: [
          { type: "FLAT", stat: "armor", min: 50, max: 50 },
          { type: "MORE", stat: "all_water_damage", min: 20, max: 20 },
        ],
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", auraEffect),
    },
  });
}

test("aura_effect adds a share of every AURA stat", () => {
  // `IStatCtxModifier.modify` is `target.getPercentOfStats(value / 100)` — a copy of each stat
  // in the context scaled by the modifier, added on top rather than replacing it. 50 + 30% of
  // 50 = 65.
  const result = calculate(
    build({ auras: [{ id: "fire_res", rollPercent: 100 }] }),
    auraSnapshot([exact("aura_effect", "FLAT", 30)]),
  );
  closeTo(result.stats.get("armor")?.value, 65);
});

test("two aura_effect lines compound on a MORE, rather than summing", () => {
  // The game walks occurrences, not the finished stat: each line produces its own share of the
  // MORE, and MOREs multiply. 1.2 x 1.02 x 1.04 = 1.27296, where summing to 30% first and
  // applying it once would give 1.2 x 1.06 = 1.272.
  const result = calculate(
    build({ auras: [{ id: "fire_res", rollPercent: 100 }] }),
    auraSnapshot([exact("aura_effect", "FLAT", 10), exact("aura_effect", "FLAT", 20)]),
  );
  closeTo(result.stats.get("all_water_damage")?.dmgMulti, 1.2 * 1.02 * 1.04);
});

test("a build with no aura_effect is untouched by the pass", () => {
  const result = calculate(
    build({ auras: [{ id: "fire_res", rollPercent: 100 }] }),
    auraSnapshot([]),
  );
  closeTo(result.stats.get("armor")?.value, 50);
  closeTo(result.stats.get("all_water_damage")?.dmgMulti, 1.2);
});

/**
 * Two Augments and a cost reduction, for the capacity arithmetic.
 *
 * `guardian` deliberately declares no `<id>_aura_cost` stat, which is the `SPECIFIC_AURA_COST
 * .has(info)` false arm — four of the pack's 28 Augments are in it.
 */
function capacitySnapshot(costStat: number) {
  return engineSnapshot({
    mmorpg_stat: {
      armor: statEntry("armor"),
      armor_aura_cost: statEntry("armor_aura_cost"),
    },
    mmorpg_aura: {
      armor: { id: "armor", reservation: 0.4, stats: [{ type: "FLAT", stat: "armor", min: 1, max: 1 }] },
      guardian: { id: "guardian", reservation: 0.4, stats: [] },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        costStat === 0 ? [] : [exact("armor_aura_cost", "FLAT", costStat)],
      ),
    },
  });
}

test("Augment capacity is the spirit_cost stat, falling back to the code-only base of 100", () => {
  const snap = capacitySnapshot(0);
  const run = calculate(build({ auras: [{ id: "armor", rollPercent: 100 }] }), snap);
  // Nothing on this character grants `spirit_cost`, so `getTotalSpirit`'s `if (num < 1)` arm
  // returns `AuraCapacity.base`.
  const result = auraCapacity({ snapshot: snap }, [{ id: "armor" }], run.stats);
  assert.equal(result.capacity, AURA_CAPACITY_BASE);
  assert.equal(result.reserved, 40);
  assert.equal(result.remaining, 60);
});

test("an Augment cost stat scales that Augment's reservation and nothing else's", () => {
  // -25% Armor Augment Cost: 40 x 0.75 = 30 for `armor`, and `guardian` declares no cost stat
  // at all, so it stays at its full 40.
  const snap = capacitySnapshot(-25);
  const run = calculate(build({ auras: [{ id: "armor", rollPercent: 100 }] }), snap);
  const result = auraCapacity({ snapshot: snap }, [{ id: "armor" }, { id: "guardian" }], run.stats);
  assert.deepEqual(
    result.entries.map((e) => [e.auraId, e.multiplier, e.cost]),
    [
      ["armor", 0.75, 30],
      ["guardian", 1, 40],
    ],
  );
  assert.equal(result.reserved, 70);
});

test("the reserved total truncates after every Augment, as the Java's int += does", () => {
  // 40 x 0.99 = 39.6 each. `res += cost` on an `int` is `res = (int) (res + cost)`, so the
  // first lands at 39 and the second at 78 — not 79, and not the 79.2 a float sum would give.
  const snap = capacitySnapshot(-1);
  const run = calculate(build(), snap);
  const result = auraCapacity({ snapshot: snap }, [{ id: "armor" }, { id: "armor" }], run.stats);
  assert.equal(result.reserved, 78);
});

test("a disabled Augment reserves nothing, exactly as an unequipped one does", () => {
  const snap = capacitySnapshot(0);
  const run = calculate(build(), snap);
  const result = auraCapacity(
    { snapshot: snap },
    [{ id: "armor" }, { id: "guardian", enabled: false }],
    run.stats,
  );
  assert.equal(result.reserved, 40);
  assert.equal(result.entries.length, 1);
});
