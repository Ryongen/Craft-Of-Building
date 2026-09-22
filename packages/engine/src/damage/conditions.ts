/**
 * `mmorpg_stat_condition` — the `ifs` gates on every datapack stat effect.
 *
 * 308 entries across 26 serializers. They are ANDed, and negation is not a flag on the *use*
 * but a separately registered condition whose id ends `_is_false`:
 *
 *     public StatCondition flipCondition() {
 *         this.is = false;
 *         this.id += "_is_false";
 *         return this;
 *     }
 *
 * — StatCondition.java:55-59, with the gate reading `cond.can(...) == cond.getConditionBoolean()`
 * (DataPackStatEffect.java:83-90). So a flipped condition passes when its test *fails*.
 *
 * ## Why an outcome is not a boolean
 *
 * `random_roll` is the most-referenced condition in the pack (144 uses) and it reads its
 * chance from the stat's own value:
 *
 *     public boolean can(EffectEvent event, ...) {
 *         return RandomUtils.roll(data.getValue());
 *     }
 *
 * — RandomRollCondition.java:14-17. A build planner cannot roll dice and report a number, so a
 * condition resolves to true, false, or *a probability*, and the caller decides what to do
 * with it. That is what makes "15% chance to burn" expressible at all.
 *
 * `RandomUtils.roll` used to be the one unverified line here — it lives in `library_of_exile`,
 * whose submodule was empty in the old 6.4.8 checkout, so its body was inferred from the fact
 * that every call site passes a percentage. The submodule is populated in the 6.4.13 source and
 * the inference was exactly right:
 *
 *     public static boolean roll(double chance) {
 *         double ranNum = ran.nextDouble() * 100;
 *         if (chance > ranNum) { return true; }
 *         return false;
 *     }
 *
 * — RandomUtils.java:119-128. `nextDouble()` is `[0, 1)`, so the chance is `value / 100`, and
 * the strict `>` means a stat at 0 never fires and one at 100 always does. Clamping to `[0, 1]`
 * is what the two open ends of that comparison amount to.
 */

import { CATEGORY, ELEMENTS, elementByName, elementsMatch, entry } from "@cte2/schema";

import { EVENT, type EffectSide } from "./event.js";
import { atMaxStacks, type EffectHolder } from "./effect-state.js";
import { levelOf, sheetOf, sheetValue, type DamageCtx } from "./ctx.js";

/**
 * What a condition resolved to.
 *
 * `unknown` is not an error — it is a question a static document cannot answer (is the spell
 * off cooldown? is it daytime?). It behaves as `false`, which is what the game would do with
 * no charges built up, but it is reported so the answer is never quietly assumed.
 */
export type Outcome =
  | { kind: "true" }
  | { kind: "false" }
  | { kind: "chance"; probability: number }
  | { kind: "unknown"; reason: string };

export const TRUE: Outcome = { kind: "true" };
export const FALSE: Outcome = { kind: "false" };

/** The `stat` half of the gate: which stat carries the effect, and what it resolved to. */
export type StatSubject = { statId: string; value: number; element: string | undefined };

/**
 * Evaluates one stat effect's whole `ifs` list.
 *
 * Returns the probability the block fires: 1 for definitely, 0 for never, something between
 * when a chance is involved. Independent chances multiply, which is what the game's sequential
 * rolls amount to.
 */
export function evaluateIfs(
  ctx: DamageCtx,
  ifs: readonly string[],
  subject: StatSubject,
  side: EffectSide,
): number {
  let probability = 1;
  for (const id of ifs) {
    const outcome = evaluateCondition(ctx, id, subject, side);
    if (outcome.kind === "false") return 0;
    if (outcome.kind === "unknown") {
      reportUnknown(ctx, id, outcome.reason);
      return 0;
    }
    if (outcome.kind === "chance") probability *= outcome.probability;
    if (probability === 0) return 0;
  }
  return probability;
}

/**
 * One condition, with the `is` flip applied.
 *
 * The flip inverts a probability rather than discarding it: `crit_is_false` on a 25% crit
 * chance is a 75% gate, not a closed one.
 */
export function evaluateCondition(
  ctx: DamageCtx,
  conditionId: string,
  subject: StatSubject,
  side: EffectSide,
): Outcome {
  const data = entry(ctx.snapshot, CATEGORY.statCondition, conditionId)?.data;
  if (!data) {
    // `if (cond == null) return false;` — an unresolvable condition closes the gate.
    return { kind: "unknown", reason: `no ${CATEGORY.statCondition} entry` };
  }

  // A build document may force any condition outright. This wins over everything, including
  // conditions the engine could have derived, because the author is describing a scenario.
  const forced = ctx.config.conditions?.[conditionId];
  if (forced !== undefined) return forced ? TRUE : FALSE;

  const raw = evaluateSerializer(ctx, data, subject, side);
  const expected = data["is"] === false ? false : true;
  return expected ? raw : flip(raw);
}

function flip(outcome: Outcome): Outcome {
  switch (outcome.kind) {
    case "true":
      return FALSE;
    case "false":
      return TRUE;
    case "chance":
      return { kind: "chance", probability: 1 - outcome.probability };
    case "unknown":
      return outcome;
  }
}

function evaluateSerializer(
  ctx: DamageCtx,
  data: Record<string, unknown>,
  subject: StatSubject,
  side: EffectSide,
): Outcome {
  const ser = stringAt(data, "ser") ?? "";

  switch (ser) {
    // --- derivable from the hit itself -----------------------------------------------

    case "random_roll":
      return { kind: "chance", probability: clamp01(subject.value / 100) };

    case "is_bool_true":
      return bool(ctx.event.data.getBoolean(stringAt(data, "bool_id") ?? ""));

    case "string_matches": {
      // `event.data.getString(string_key).equals(string_id)`.
      const key = stringAt(data, "string_key") ?? "";
      const want = stringAt(data, "string_id") ?? "";
      return bool(ctx.event.data.getString(key) === want);
    }

    case "ele_match_stat":
      // `event.data.getElement().elementsMatch(stat.getElement())`.
      return bool(elementsMatch(ELEMENTS[ctx.event.data.getElement()], elementByName(subject.element)));

    case "is_elemental_damage":
      // `event.data.getElement().tags.contains(ElementTags.ELEMENTAL)`.
      return bool(ELEMENTS[ctx.event.data.getElement()].isElemental);

    case "is_spell":
      return bool(ctx.spell !== undefined);

    case "spell_has_tag": {
      // `tag` is an object here — `{ "tag": { "id": "projectile" } }` — where `effect_has_tag`
      // uses a bare string. The two are not interchangeable and the pack ships both.
      const tag = asObject(data["tag"]);
      const id = tag ? stringAt(tag, "id") : undefined;
      return id === undefined ? FALSE : bool(ctx.spellTags.has(id));
    }

    case "spell_has_resource_type_cost":
      return spellResourceCost(ctx, stringAt(data, "type") ?? stringAt(data, "resource_type") ?? "");

    case "wep_type_match":
      return bool(ctx.event.data.getString(EVENT.WEAPON_TYPE) === (stringAt(data, "type") ?? ""));

    case "is_ailment":
      return bool(ctx.event.data.getString(EVENT.AILMENT) === (stringAt(data, "ailment") ?? ""));

    case "either_is_true": {
      // `ifs.stream().anyMatch(x -> ExileDB.StatConditions().get(x).can(...))` — note it calls
      // `can` directly and does **not** compare against the sub-condition's own `is`. A flipped
      // condition nested inside `either_is_true` therefore has its flip ignored by the game.
      const nested = stringsAt(data, "ifs");
      let best: Outcome = FALSE;
      for (const id of nested) {
        const sub = entry(ctx.snapshot, CATEGORY.statCondition, id)?.data;
        if (!sub) continue;
        const outcome = evaluateSerializer(ctx, sub, subject, side);
        if (outcome.kind === "true") return TRUE;
        if (outcome.kind === "chance") {
          // Independent alternatives: P(any) = 1 - prod(1 - p).
          const prior = best.kind === "chance" ? best.probability : 0;
          best = { kind: "chance", probability: 1 - (1 - prior) * (1 - outcome.probability) };
        }
      }
      return best;
    }

    case "is_dual_wielding":
      // `DualWieldUtils.isDualWielding(event.getSide(statSource))` — a one-handed weapon in
      // each hand, answered from the gear of whichever side the stat sits on.
      return (side === "Source" ? ctx.sourceDualWielding : ctx.targetDualWielding) === true
        ? TRUE
        : FALSE;

    case "source_is_target":
      // A self-damage check, and the only place in the model where it is true: a damage act
      // aimed at a `self` selector, resolved through `simulateHit`'s `selfHit`. Every ordinary
      // figure is a hit on something else, so the default stays false.
      return ctx.sourceIsTarget ? TRUE : FALSE;

    // --- properties of the declared target -------------------------------------------

    case "is_hp_under":
      return hpCondition(ctx, data, side, "under");

    case "is_hp_above":
      return hpCondition(ctx, data, side, "above");

    case "is_ms_under":
      return {
        kind: "unknown",
        reason: "magic shield is a live resource pool, not a build-document field",
      };

    case "is_target_low":
      // `IsTargetLow` with `check_combined_hp_and_ms` — which is the default and what both of
      // this pack's entries carry:
      //
      //     float current = ms + hp;
      //     float max = msmax + maxhp;
      //     return perc > current / max * 100;
      //
      // The combined pool collapses to health here, because the target block states no magic
      // shield: `EnemySetup` has armour, resists, dodge and block and no `magic_shield`, so
      // `msmax` is 0 and `(0 + hp) / (0 + maxhp)` is the health fraction. That is a statement
      // about the model rather than an approximation of the game, and it goes the same way as
      // `is_hp_under` — the same strict `>`.
      return hpCondition(ctx, data, side, "under");

    // --- world and timeline: not answerable from a static document -------------------

    /**
     * `IsNotOnCdCondition` — true when the named cooldown is not running.
     *
     * This reads as unanswerable and is not, because of *where* it is used: 89 of the 90 stat
     * effect blocks that carry one are `proc_spell` blocks, and the cooldown it names is the
     * procced spell's own `proc_cooldown_ticks`. That is not a gate a rate has to guess at — it
     * *is* the rate ceiling, and `procs.ts` already applies it as `20 / proc_cooldown_ticks`
     * casts per second on top of `hits per second × chance`.
     *
     * Answering `unknown` here therefore did not express caution, it double-counted it: the gate
     * closed, the proc was listed as `cannot-trigger`, and the cap that models the same cooldown
     * properly never got to run. `proc_soul_wound` is the clearest case — 100% chance, a 5-tick
     * cooldown, and it was reporting zero.
     *
     * So this resolves **true** and lets the cooldown be spent where it belongs. A build that
     * wants the pessimistic reading can still close it through `config.conditions`.
     */
    case "is_not_on_cd":
      return TRUE;
    // --- exile effects: answered from the resolved state, not guessed -----------------

    case "is_under_exile_effect": {
      // `IsUnderExileEffectCondition` reads the effect off whichever side the condition names,
      // and both sides are modelled: a buff you are assumed to have sits on the caster, a debuff
      // your skills apply sits on the target. `effect-state.ts` decides which is which.
      const id = stringAt(data, "effect");
      if (id === undefined) return { kind: "unknown", reason: "the condition names no effect" };
      const wants = (stringAt(data, "side") ?? "Source") === "Source" ? "caster" : "target";
      return effectHeldBy(ctx, id, wants) ? TRUE : FALSE;
    }
    case "is_mns_effect_max_charges": {
      // `getMaxCharges` is `max_stacks` plus the `max_<id>_charges` stat, and an active effect
      // is assumed to sit at that cap — so this is true whenever the effect is up at all, and
      // false when the document pinned it below the cap.
      const id = stringAt(data, "effect");
      if (id === undefined) return { kind: "unknown", reason: "the condition names no effect" };
      return atMaxStacks(ctx.effects, id) ? TRUE : FALSE;
    }
    // Both read `EventData.EXILE_EFFECT`, which only the `on_exile_effect` event carries:
    //
    //     if (event.data.hasExileEffect()) return event.data.getExileEffect().hasTag(tag);
    //     return false;                     // EffectHasTagCondition.java:24-29
    //
    // So on a damage sweep this is genuinely unanswerable, and on an effect sweep it is simply
    // read off the effect being applied — see `effect-duration.ts`.
    case "is_effect": {
      if (ctx.exileEffect === undefined) {
        return { kind: "unknown", reason: "depends on which exile effect triggered the event" };
      }
      return stringAt(data, "effect") === ctx.exileEffect.id ? TRUE : FALSE;
    }
    case "effect_has_tag": {
      if (ctx.exileEffect === undefined) {
        return { kind: "unknown", reason: "depends on which exile effect triggered the event" };
      }
      const tag = stringAt(data, "tag");
      return tag !== undefined && ctx.exileEffect.tags.has(tag) ? TRUE : FALSE;
    }
    case "is_target_cursed":
      return hasCurse(ctx) ? TRUE : FALSE;
    case "is_in_combat":
      // Set only when the caller is pinning a scenario — the regeneration tick, which is computed
      // for both states. Read here rather than through `config.conditions` so that the flipped
      // twin `is_in_combat_is_false` follows from it: the flip is applied by the caller of this
      // switch, and a forced entry would have to name each id separately.
      if (ctx.inCombat !== undefined) return ctx.inCombat ? TRUE : FALSE;
      return { kind: "unknown", reason: "depends on combat state" };
    case "is_day":
      return { kind: "unknown", reason: "depends on the time of day" };
    case "light_level":
      return { kind: "unknown", reason: "depends on the light level where the hit lands" };
    case "is_undead":
      return { kind: "unknown", reason: "depends on the target's mob type" };
    case "is_ranged_weapon":
    case "req_charged_atk":
      return { kind: "unknown", reason: "depends on how the attack was made" };

    default:
      return { kind: "unknown", reason: `unrecognised serializer \`${ser}\`` };
  }
}

/**
 * `IsHealthAbove/BellowPercentCondition`, answered from the stated health of whichever side the
 * condition names.
 *
 *     is_hp_above:  return perc < en.getHealth() / en.getMaxHealth() * 100;
 *     is_hp_under:  return perc > en.getHealth() / en.getMaxHealth() * 100;
 *
 * Both comparisons are **strict**, so a side stated at exactly the threshold satisfies neither
 * direction — worth keeping, because 50 is the threshold seven of this pack's nine health
 * conditions use and a round number is exactly what somebody types.
 *
 * A fraction is the right shape for this and a per-condition toggle was not. The pack gates on
 * the target being under 50%, under 25%, above 70% and above 30%; asked one at a time, a document
 * could say the mob was on 20% health *and* near full, and every execute bonus in the game would
 * pay out together. One number cannot be inconsistent with itself.
 *
 * Unstated stays `unknown` rather than defaulting to full health, which is the project's standing
 * rule about silent defaults: assuming a full-health target would turn every low-life bonus in
 * the pack off without a word. `config.conditions` still forces an individual id either way —
 * `evaluateCondition` reads it before this is reached.
 */
function hpCondition(
  ctx: DamageCtx,
  data: Record<string, unknown>,
  side: EffectSide,
  direction: "under" | "above",
): Outcome {
  const at = numberAt(data, "perc") ?? 50;
  const which = stringAt(data, "side") ?? side;
  const stated =
    which === "Source" ? ctx.config.selfHealthPercent : ctx.config.targetHealthPercent;
  if (typeof stated === "number" && Number.isFinite(stated)) {
    return bool(direction === "under" ? at > stated : at < stated);
  }
  const field = which === "Source" ? "selfHealthPercent" : "targetHealthPercent";
  return {
    kind: "unknown",
    reason:
      `depends on the ${which.toLowerCase()}'s current health being ${direction} ${at}%, ` +
      `which \`config.${field}\` would state`,
  };
}

/** `SpellHasResourceCost` — whether the spell being cast costs mana, energy, blood, … */
function spellResourceCost(ctx: DamageCtx, type: string): Outcome {
  const config = asObject(ctx.spell?.["config"]);
  if (!config || type.length === 0) return FALSE;
  const key = `${type.toLowerCase()}_cost`;
  const cost = asObject(config[key]) ?? asObject(config[`${type.toLowerCase()}Cost`]);
  if (!cost) return FALSE;
  return bool((numberAt(cost, "max") ?? 0) > 0 || (numberAt(cost, "min") ?? 0) > 0);
}

function reportUnknown(ctx: DamageCtx, conditionId: string, reason: string): void {
  if (ctx.reportedConditions.has(conditionId)) return;
  ctx.reportedConditions.add(conditionId);
  ctx.report(
    "warning",
    "condition-not-derivable",
    `config.conditions.${conditionId}`,
    `\`${conditionId}\` ${reason}, so it was treated as inactive and every stat gated on it contributed nothing. Set \`config.conditions.${conditionId}\` to state it explicitly.`,
  );
}

function bool(value: boolean): Outcome {
  return value ? TRUE : FALSE;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === "string" ? v : undefined;
}

function stringsAt(node: Record<string, unknown>, key: string): string[] {
  const v = node[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Kept for callers that need the raw sheet access helpers alongside condition evaluation.
export { sheetOf, sheetValue, levelOf };


/**
 * Whether one side is holding an effect.
 *
 * The state keys an effect to one holder — a buff is on you, a debuff your skills apply is on
 * the mob — so a condition asking about the other side is answered `false` rather than by
 * reaching for the effect wherever it happens to be.
 */
function effectHeldBy(ctx: DamageCtx, effectId: string, wants: EffectHolder): boolean {
  const option = ctx.effects.options.find((o) => o.id === effectId);
  return option !== undefined && option.stacks > 0 && option.side === wants;
}

/**
 * `IsTargetCursedCondition` — whether anything the pack calls a curse is on the target.
 *
 * Curses are exile effects tagged `curse`, so this is the same question as `is_under_exile_effect`
 * asked across a tag rather than an id.
 */
function hasCurse(ctx: DamageCtx): boolean {
  for (const option of ctx.effects.options) {
    if (option.stacks <= 0 || option.side !== "target") continue;
    const data = entry(ctx.snapshot, CATEGORY.exileEffect, option.id)?.data;
    const tags = (data?.["tags"] as { tags?: unknown } | undefined)?.tags;
    if (Array.isArray(tags) && tags.includes("curse")) return true;
  }
  return false;
}
