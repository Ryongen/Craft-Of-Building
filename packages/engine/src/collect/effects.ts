/**
 * Auras and exile effects.
 *
 * Both hold `{ type, stat, min, max }` ranges rolled by something other than the stat itself, and
 * the two differ in whether the document can answer it:
 *
 *   - an aura's percent is its gem's own roll, `SkillGemData.getStatPercent()`
 *     (AuraGem.java:98-104). Nothing else in the document implies it, so an aura without a
 *     recorded `rollPercent` computes at 0% and says so.
 *   - an exile effect's comes from the rank of the *applying spell*,
 *     `new LeveledValue(0, 100).getValue(caster, spell)` (ExileEffect.java:150-162) — and that
 *     spell is usually on the skill bar, so it is derived rather than floored. `resolveEffectState`
 *     works both it and the `str_multi` out; this file only spends them.
 *
 * The stack behaviour is exact, and worth having:
 *
 *     if (stacks > 1 && this.stacks_affect_stats) {
 *         var inc = (stacks - 1) * 100F;
 *         result.percentIncrease = inc;
 *         result.increaseByAddedPercent();
 *     }
 *
 * `increaseByAddedPercent` is `v1 *= 1 + percentIncrease / 100`, so N stacks multiply the
 * value by N.
 */

import type { AuraSetup, BuildDoc, FoodBuffSetup } from "@cte2/schema";
import { CATEGORY, entry, isAuraEnabled, isFoodBuffEnabled } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { gemRoll } from "./gem-roll.js";
import { activeOn, type EffectOption, type EffectState } from "../damage/effect-state.js";
import { multiplyExact, parseRolledMods, rollToExact, type ExactMod } from "../modifier.js";

/**
 * `AuraCapacity.base` — what the capacity falls back to when the sheet has not resolved one.
 *
 *     int num = (int) getCalculatedStat(AuraCapacity.getInstance()).getValue();
 *     if (num < 1) { num = (int) AuraCapacity.getInstance().base; }
 *
 * — `GemInventoryHelper.getTotalSpirit`, read off the 6.4.13 jar. `spirit_cost` is a code-only
 * stat (`database/data/stats/types/spirit/AuraCapacity.java`), which is why the number is here
 * and not in the snapshot: no `mmorpg_stat` entry declares it, and `code-only-stats.generated.ts`
 * carries the same 100 as its base.
 */
export const AURA_CAPACITY_BASE = 100;

/** The stat that *is* Augment Capacity. `AuraCapacity.GUID()` is `spirit_cost`, confusingly. */
export const AURA_CAPACITY_STAT = "spirit_cost";

/** One Augment's share of the capacity, and what made it that. */
export type AuraReservation = {
  auraId: string;
  /** `reservation * 100`, before the per-Augment cost stat. */
  base: number;
  /**
   * `1 + <auraId>_aura_cost / 100`, or 1 where the pack declares no such stat for this Augment.
   *
   * Four of the pack's 28 Augments have none — `back_to_basics`, `critical_damage`,
   * `critical_hit` and `guardian` — which is `SPECIFIC_AURA_COST.has(info)` returning false.
   */
  multiplier: number;
  /** What this one actually reserves: `base * multiplier`. */
  cost: number;
};

export type AuraCapacity = {
  /** `getTotalSpirit` — the ceiling. */
  capacity: number;
  /** `getSpiritReserved` — the sum, truncated the way the Java's `int +=` truncates it. */
  reserved: number;
  /** `getRemainingSpirit`. Negative means the game would strip every Augment off. */
  remaining: number;
  /** Per Augment, in document order. Disabled Augments are left out, as unequipped ones are. */
  entries: AuraReservation[];
};

/**
 * How much Augment Capacity a set of Augments reserves, and how much there is.
 *
 * Ported from `GemInventoryHelper` in `Mine_and_Slash-1.20.1-6.4.13.jar` — the jar rather than
 * the checkout, because the checkout is a fork and its copy of `getSpiritReserved` carries a
 * `// this one is equals based on instance, so its never true lol` comment about the per-Augment
 * cost lookup. That comment is wrong in 6.4.13: `AuraGems$AuraInfo.hashCode()` is
 * `Objects.hash(id)` and `AutoHashClass.equals` compares hash codes, so the `HashMap.containsKey`
 * behind `SPECIFIC_AURA_COST.has(info)` matches by id and the multiplier does apply.
 *
 *     int res = 0;
 *     for (SkillGemData aura : getAurasGems()) {
 *         float cost = aura.getAura().reservation * 100F;
 *         var info = new AuraGems.AuraInfo(aura.getAura());
 *         if (SPECIFIC_AURA_COST.has(info)) {
 *             var stat = SPECIFIC_AURA_COST.get(info);
 *             if (data.getCalculatedStat(stat).isNotZero()) cost *= data.getCalculatedStat(stat).getMultiplier();
 *         }
 *         res += cost;
 *     }
 *
 * `res` is an `int` and `cost` a `float`, so `res += cost` is `res = (int) (res + cost)` — the
 * running sum truncates after **every** Augment rather than once at the end. Two Augments at
 * 39.6 each reserve 79, not 79.2 and not 80. That is reproduced rather than rounded, because it
 * is the difference between fitting a third Augment and not.
 *
 * `getCalculatedStat` is read off the **player's** unit, not the gem's, so the cost reduction
 * is a character stat like any other.
 */
export function auraCapacity(
  env: Pick<Env, "snapshot">,
  auras: readonly AuraSetup[],
  sheet: ReadonlyMap<string, { value: number }>,
): AuraCapacity {
  const entries: AuraReservation[] = [];
  let reserved = 0;

  for (const aura of auras) {
    if (!isAuraEnabled(aura)) continue;
    const data = entry(env.snapshot, CATEGORY.aura, aura.id)?.data;
    if (!data) continue;

    const declared = data["reservation"];
    const base = (typeof declared === "number" && Number.isFinite(declared) ? declared : 0) * 100;

    // `SPECIFIC_AURA_COST` is keyed by `AuraInfo`, whose GUID is the Augment's own id, and the
    // pack names the stats `<auraId>_aura_cost`. Asking the registry rather than assuming the
    // stat exists is what reproduces `has(info)` for the four Augments that have none.
    const costStat = `${aura.id}_aura_cost`;
    const value = entry(env.snapshot, CATEGORY.stat, costStat) === undefined
      ? 0
      : (sheet.get(costStat)?.value ?? 0);
    const multiplier = value === 0 ? 1 : 1 + value / 100;

    const cost = base * multiplier;
    entries.push({ auraId: aura.id, base, multiplier, cost });
    reserved = Math.trunc(reserved + cost);
  }

  const resolved = Math.trunc(sheet.get(AURA_CAPACITY_STAT)?.value ?? 0);
  const capacity = resolved < 1 ? AURA_CAPACITY_BASE : resolved;

  return { capacity, reserved, remaining: capacity - reserved, entries };
}

export function collectAuras(env: Env, auras: readonly AuraSetup[]): StatContext[] {
  const out: StatContext[] = [];

  auras.forEach((aura, i) => {
    const path = `auras[${i}]`;
    if (!isAuraEnabled(aura)) return;

    const data = entry(env.snapshot, CATEGORY.aura, aura.id)?.data;
    if (!data) {
      env.report("error", "unknown-aura", path, `No aura \`${aura.id}\`.`);
      return;
    }

    const raw = data["stats"];
    const mods = Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];

    // `AuraGem.GetAllStats` rolls every stat at the gem's own percent, at the *player's* level
    // rather than an item level — an Augment is a gem in the character's own inventory.
    const roll = gemRoll(env, aura.rarity, aura.rollPercent);
    if (mods.length > 0 && !roll.stated) {
      env.report(
        "warning",
        "aura-roll-unknown",
        path,
        `\`${aura.id}\` rolls its stats on the Augment's gem (\`SkillGemData.getStatPercent()\`) ` +
          `and no \`rollPercent\` was recorded, so it is computed at ${roll.floor}% — the floor ` +
          `of ${aura.rarity === undefined ? "the full range" : `a "${aura.rarity}" gem's band`}. ` +
          `Re-capture with an exporter that records the gem's roll.`,
      );
    }

    const stats = mods.map((mod) =>
      rollToExact(mod, roll.percent, env.level, env.index.shapeOf(mod.statId), env.balance),
    );
    out.push(context("AURA", aura.id, path, stats));
  });

  return out;
}

/**
 * Meals, seafood and elixirs — `PlayerBuffData.getStatAndContext`, which hands every buff's
 * stats over as one `FOOD_BUFF` context.
 *
 * The roll is `StatBuff.getStats`, and its one surprise is worth repeating at the call site:
 *
 *     return mods.stream().map(x -> x.ToExactStat((int) (perc + lvl), lvl)).collect(...);
 *
 * The percent handed to `ToExactStat` is the crafted roll **plus the food's level**, while the
 * level flats scale to is the level alone. At level 100 that puts every food a full 100 points
 * past its own band — the `life` buff's 5..10% health pays out 14.65%, not 10% — so reading the
 * two arguments as one, or clamping the sum to 100, gives a number the game never produces.
 */
export function collectFoodBuffs(env: Env, buffs: readonly FoodBuffSetup[]): StatContext[] {
  const out: StatContext[] = [];

  buffs.forEach((buff, i) => {
    const path = `foodBuffs[${i}]`;
    if (!isFoodBuffEnabled(buff)) return;

    const data = entry(env.snapshot, CATEGORY.statBuff, buff.id)?.data;
    if (!data) {
      env.report("error", "unknown-stat-buff", path, `No ${CATEGORY.statBuff} entry \`${buff.id}\`.`);
      return;
    }

    const raw = data["mods"];
    const mods = Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];
    if (mods.length === 0) return;

    // A food above the eater's level cannot be eaten at all, so the character's level is the
    // ceiling rather than a default: an unstated level is the best one this character could
    // have had. The roll itself is not guessable and floors at 0 with a warning.
    const level = buff.level ?? env.level;
    const roll = buff.rollPercent;
    if (roll === undefined) {
      env.report(
        "warning",
        "food-roll-unknown",
        path,
        `\`${buff.id}\` rolls at \`perc + lvl\` and no \`rollPercent\` was recorded, so it is ` +
          `computed at 0% — the weakest food of its level, not the one that was eaten.`,
      );
    }

    const stats = mods.map((mod) =>
      rollToExact(mod, (roll ?? 0) + level, level, env.index.shapeOf(mod.statId), env.balance),
    );
    out.push(context("FOOD_BUFF", buff.id, path, stats));
  });

  return out;
}

/**
 * Exile effects whose stats join the character's sheet.
 *
 * **One list, one answer.** Which effects are up, at how many stacks, at what roll and at what
 * strength is `resolveEffectState`'s job and nobody else's — this walks the state it produced
 * and turns it into modifiers. That matters because the same state drives the spell gates, the
 * debuffs on the mob and the toggles on screen, and when the sheet answered the question
 * separately the two disagreed: unticking a buff in the damage view switched its *branch* off
 * while its stats stayed on the character, because the stats came from `build.exileEffects` and
 * nothing consulted the tick.
 *
 * Only the caster's side lands here. A debuff your skills apply is an effect on the mob, and
 * `simulate.ts` puts it on the mob's sheet off this same state; adding it here as well would
 * hand the player the armour penalty they were inflicting.
 *
 * The two numbers that decide how much a buff is worth both come off the option:
 *
 *   - **`rollPercent`** interpolates the effect's `{min, max}` bands. It comes from the rank of
 *     the spell that applied the effect, captured where a capture recorded it and derived from
 *     the skill on the bar otherwise.
 *   - **`strMulti`** multiplies the result, and is the `inc_effect_of_*_buff_*` stats the
 *     character carries.
 *
 * Both are reported when they were derived rather than measured, because a derived buff strength
 * is a claim about a number the game keeps and this project's captures are the authority on it.
 */
export function collectExileEffects(env: Env, build: BuildDoc, effects: EffectState): StatContext[] {
  const out: StatContext[] = [];

  for (const option of activeOn(effects, "caster")) {
    const data = entry(env.snapshot, CATEGORY.exileEffect, option.id)?.data;
    if (!data) {
      env.report("error", "unknown-exile-effect", pathOf(option), `No exile effect \`${option.id}\`.`);
      continue;
    }

    const raw = data["stats"];
    const mods = Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];
    if (mods.length === 0) continue;

    reportDerived(env, build, option, mods[0]!.statId);

    // `str_multi` is applied last and unconditionally: `v1 *= multi`.
    const stacksAffect = data["stacks_affect_stats"] === true;
    const stats: ExactMod[] = mods
      .map((mod) =>
        rollToExact(mod, option.rollPercent, env.level, env.index.shapeOf(mod.statId), env.balance),
      )
      .map((mod) => (stacksAffect && option.stacks > 1 ? multiplyExact(mod, option.stacks) : mod))
      .map((mod) => (option.strMulti === 1 ? mod : multiplyExact(mod, option.strMulti)));

    out.push(context("POTION_EFFECT", option.id, pathOf(option), stats));
  }

  return out;
}

/** Where in the document the effect came from, for a diagnostic a reader can act on. */
function pathOf(option: EffectOption): string {
  return option.captured ? `exileEffects.${option.id}` : `config.effects.${option.id}`;
}

/**
 * Says so when a buff's strength was worked out rather than measured.
 *
 * The roll percent is the half that bites. `hunters_focus` is `FLAT 1..3 projectile_count`: a
 * spell rank the document does not state is the difference between one extra projectile and
 * three, and neither number announces itself as wrong on screen.
 */
function reportDerived(
  env: Env,
  build: BuildDoc,
  option: EffectOption,
  exampleStat: string,
): void {
  if (option.captured && option.spellId !== undefined) return;

  if (option.spellId === undefined) {
    env.report(
      "warning",
      "exile-effect-roll-unknown",
      pathOf(option),
      `\`${option.id}\`'s stats roll at a percent taken from the rank of whatever applied it, ` +
        `and nothing in the build says what would — no capture recorded it and no equipped skill ` +
        `grants it. It is computed at 0%, so a band like \`${exampleStat}\` reads at its minimum.`,
    );
    return;
  }

  const rank = (build.skills ?? []).find((s) => s.spellId === option.spellId)?.level;
  env.report(
    "info",
    "exile-effect-strength-derived",
    pathOf(option),
    `\`${option.id}\` is assumed up at ${option.stacks} stack(s). Its stats roll at ` +
      `${option.rollPercent}%, from \`${option.spellId}\`${rank === undefined ? "" : ` at rank ${rank}`}, ` +
      `and are multiplied by ${round(option.strMulti)} from your \`inc_effect_of_*_buff_*\` stats. ` +
      `A capture of the live effect would state both rather than derive them.`,
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
