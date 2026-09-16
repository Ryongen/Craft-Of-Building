/**
 * `mmorpg_stat_effect` — what a datapack stat actually *does* once its `ifs` pass.
 *
 * 228 entries across 17 serializers, but only a handful are damage arithmetic. The largest two
 * — `proc_spell` (78) and `give_exile_effect` (67) — cause things to happen in the world, and
 * a per-hit damage number is the wrong place to model them. They are reported rather than
 * dropped, because "your hit also casts a fireball" is a real part of a build's output and
 * silently ignoring it would make the engine confidently low.
 *
 * The workhorse is `modify_stat_layer` (11 entries, 7 of the 14 layers). Its tail is where
 * phase 1's `dmgMulti` finally gets spent:
 *
 *     this.modification.apply(layerData, num);
 *     if (stat.getMultiUseType() == Stat.MultiUseType.MULTIPLICATIVE_DAMAGE) {
 *         event.addMoreMulti(stat, number_to_modify, data.getMoreStatTypeMulti());
 *     }
 *
 * — ModifyStatLayerEffect.java:78-94. `getMoreStatTypeMulti()` is `StatData.m`, the number the
 * stat sheet prints as "x1.25" and the fixture format records as `dmgMulti`. A
 * `MULTIPLICATIVE_DAMAGE` stat keeps its MORE modifiers out of its value all the way through
 * the stat calculation precisely so they can be handed over here, once, as a separate
 * multiplier applied after every layer.
 */

import { CATEGORY, entry } from "@cte2/schema";

import { EVENT, type EffectSide } from "./event.js";
import { sheetValue, type DamageCtx } from "./ctx.js";

/** The stat carrying the effect: its id, resolved value, and its `StatData.m`. */
export type EffectSubject = {
  statId: string;
  value: number;
  dmgMulti: number;
  multiUseType: "MULTIPLY_STAT" | "MULTIPLICATIVE_DAMAGE";
};

/**
 * Applies one `mmorpg_stat_effect`.
 *
 * `weight` is the probability its `ifs` let it through — 1 for a certainty. Numeric
 * contributions are scaled by it, which is expected value and is exact wherever the layer is
 * linear in its accumulated number. Where it is *not* exact, {@link reportInexactAveraging}
 * says so rather than letting the approximation pass unremarked.
 */
export function applyStatEffect(
  ctx: DamageCtx,
  effectId: string,
  subject: EffectSubject,
  side: EffectSide,
  weight: number,
): void {
  const data = entry(ctx.snapshot, CATEGORY.statEffect, effectId)?.data;
  if (!data) {
    // `if (e == null) return;` — the game drops it. Report, because a missing effect means the
    // ported table and the pack disagree, which is exactly the drift this project watches for.
    reportOnce(ctx, `stat-effect-missing:${effectId}`, "error", "unknown-stat-effect", effectId,
      `No ${CATEGORY.statEffect} entry \`${effectId}\`, so the stat that references it does nothing.`);
    return;
  }

  const ser = stringAt(data, "ser") ?? "";
  // Recorded rather than applied. A proc does not change *this* hit — it casts another spell,
  // on its own cooldown, at whatever rate the thing that triggers it fires. `procs.ts` turns
  // the chance this block resolved to into a rate and a DPS contribution; here the job is only
  // to notice it, because the sweep has already done the hard part of deciding whether the
  // current skill can trigger it at all.
  if (ser === "proc_spell" && ctx.procs !== undefined) {
    const spellId = stringAt(data, "spellId");
    if (spellId !== undefined) {
      ctx.procs.push({
        statId: subject.statId,
        spellId,
        position: stringAt(data, "pos") ?? "CASTER",
        chance: weight,
        side,
      });
    }
    return;
  }

  switch (ser) {
    case "modify_stat_layer":
      modifyStatLayer(ctx, data, subject, side, weight);
      return;

    case "add_to_number": {
      const numberId = stringAt(data, "number_id") ?? EVENT.NUMBER;
      ctx.event.data.addNumber(numberId, numberValue(ctx, data["num_provider"], subject, side) * weight);
      return;
    }

    case "increase_number":
    case "decrease_num": {
      /*
       * These are **additive off the original number**, not compounding off the current one:
       *
       *     // DecreaseNumberByPercentEffect.java:22-25
       *     event.data.getNumber(num_id).number -= event.data.getOriginalNumber(num_id).number * data.getValue() / 100F;
       *
       *     // IncreaseNumberByPercentEffect.java:22-26
       *     event.increaseByPercent(num_id, data.getValue());
       *     event.data.getNumber(num_id).number = event.data.getNumber(num_id, 0).number * data.getMoreStatTypeMulti();
       *
       * The consequence is load-bearing for cast speed and cooldown reduction: two 50%
       * reductions reach zero, they do not leave 25%. Reading the current total instead would
       * quietly disagree with the game on any build stacking two sources of one stat.
       *
       * `increaseByPercent` is `number += originalNumber * perc / 100` (EffectEvent.java:176-178),
       * and the increase path then applies the stat's MORE multiplier to the whole running
       * number — which is why `dmgMulti` is read here and not on the decrease path.
       */
      const numberId = stringAt(data, "num_id") ?? stringAt(data, "number_id") ?? EVENT.NUMBER;
      const percent = subject.value * weight;
      const original = ctx.event.data.getOriginalNumber(numberId);
      const sign = ser === "decrease_num" ? -1 : 1;
      const next = ctx.event.data.getNumber(numberId) + (sign * original * percent) / 100;
      ctx.event.data.setNumber(numberId, ser === "increase_number" ? next * subject.dmgMulti : next);
      return;
    }

    case "multiply_num": {
      // `MultiplyNumberEffect` is the one that genuinely compounds off the current total.
      const numberId = stringAt(data, "num_id") ?? stringAt(data, "number_id") ?? EVENT.NUMBER;
      const current = ctx.event.data.getNumber(numberId);
      ctx.event.data.setNumber(numberId, current * (1 + (subject.value * weight) / 100));
      return;
    }

    case "set_data_number": {
      const numberId = stringAt(data, "num_id") ?? EVENT.NUMBER;
      ctx.event.data.setNumber(numberId, subject.value);
      return;
    }

    case "set_bool": {
      const boolId = stringAt(data, "bool_id") ?? "";
      const value = data["bool"] !== false;
      // A branch has already decided some booleans (crit, block, dodge). Re-rolling them here
      // would undo the branch, so a pinned boolean is left alone.
      if (ctx.pinnedBooleans.has(boolId)) return;
      if (weight >= 1) {
        ctx.event.data.setBoolean(boolId, value);
      } else if (weight > 0) {
        reportOnce(ctx, `bool-chance:${boolId}`, "warning", "chance-boolean-not-branched", boolId,
          `\`${subject.statId}\` sets \`${boolId}\` with probability ${(weight * 100).toFixed(1)}%. Only crit is branched; this one was treated as not set. Force it with \`config.conditions\` to see the other case.`);
      }
      return;
    }

    case "cancel_event":
      if (weight >= 1) ctx.event.data.setBoolean(EVENT.CANCELED, true);
      return;

    case "disable_attacker_stats":
      // `DisableSourceStatsEffect` — the target turns off the attacker's stat sweep entirely.
      if (weight >= 1) ctx.disableSourceStats = true;
      return;

    case "missing_resource_scaling":
      reportOnce(ctx, `missing-resource:${effectId}`, "warning", "resource-state-not-modelled", effectId,
        `\`${subject.statId}\` scales with missing ${stringAt(data, "resourceType") ?? "resource"}, which depends on the character's live pool rather than anything in the build document. It contributed nothing.`);
      return;

    case "increase_number_per_curse_on_target":
      reportOnce(ctx, `curse-count:${effectId}`, "warning", "curse-count-not-modelled", effectId,
        `\`${subject.statId}\` scales with curses on the target, which the build document does not describe. It contributed nothing.`);
      return;

    // --- world effects: real output, but not this number ------------------------------

    case "proc_spell":
      reportOnce(ctx, `proc:${effectId}`, "warning", "proc-spell-not-modelled", effectId,
        `\`${subject.statId}\` procs \`${stringAt(data, "spellId") ?? "?"}\`${weight < 1 ? ` (${(weight * 100).toFixed(1)}% of hits)` : ""}. Procs are real damage this figure does not include.`);
      return;

    case "give_exile_effect":
    case "give_exile_effect_in_radius":
    case "remove_exile_effect": {
      // The effect's *stats* are modelled: `effect-state.ts` reads this same block to work out
      // what the build can put up, and the sheet underneath this hit already carries whatever it
      // decided was on. What is not modelled is the *timing* — a buff granted on hit is up for
      // the hit after this one, not this one, and `stat_effect` blocks carry no duration the
      // engine could weigh that with. So the note is about the ramp, not about the stats, and it
      // is only worth making for an effect that is actually off.
      const effect = stringAt(data, "effect");
      const held = effect !== undefined && (ctx.effects.active.get(effect) ?? 0) > 0;
      if (!held) {
        reportOnce(ctx, `exile-effect:${effectId}`, "info", "exile-effect-not-up", effectId,
          `\`${subject.statId}\` applies \`${effect ?? "?"}\`, which is switched off, so its stats are not in this figure. Turn it on in \`config.effects\` to see the hit that follows one.`);
      }
      return;
    }

    case "apply_cd_as_cast_time": {
      /*
       * `ApplyCooldownAsCastTimeEffect.java:18-21` — cast speed spent on cooldown instead:
       *
       *     event.data.getNumber(COOLDOWN_TICKS).number -= event.data.getOriginalNumber(COOLDOWN_TICKS).number * data.getValue() / 100F;
       *     event.data.getNumber(CHARGE_COOLDOWN_TICKS).number -= event.data.getOriginalNumber(CHARGE_COOLDOWN_TICKS).number * data.getValue() / 100F;
       *
       * It does nothing during a damage event — neither number exists there — but it is the
       * whole story for a spell tagged `cast_speed_to_cooldown`, which `fireball` is. Cast
       * speed makes that spell come off cooldown sooner rather than cast faster.
       */
      const percent = subject.value * weight;
      for (const numberId of [EVENT.COOLDOWN_TICKS, EVENT.CHARGE_COOLDOWN_TICKS]) {
        const original = ctx.event.data.getOriginalNumber(numberId);
        ctx.event.data.setNumber(numberId, ctx.event.data.getNumber(numberId) - (original * percent) / 100);
      }
      return;
    }

    case "restore_resource":
      restoreResource(ctx, effectId, data, subject, side, weight);
      return;

    case "set_cooldown":
      // `set_cooldown` puts a *different* spell on cooldown, which is not this hit's arithmetic.
      return;

    default:
      reportOnce(ctx, `unknown-effect-ser:${ser}`, "error", "unknown-stat-effect-serializer", effectId,
        `\`${effectId}\` uses serializer \`${ser}\`, which the engine does not implement. \`${subject.statId}\` contributed nothing.`);
      return;
  }
}

/**
 * `ModifyStatLayerEffect.activate` (ModifyStatLayerEffect.java:78-94).
 *
 *     var layerData = event.getLayer(ExileDB.StatLayers().get(layer), number_to_modify, statSource);
 *     float num = this.number_provider.getValue(event, event.getSide(statSource), data);
 *     for (NumberModifier mod : this.number_modifiers) { num = mod.type.modify(event, num); }
 *     this.modification.apply(layerData, num);
 */
function modifyStatLayer(
  ctx: DamageCtx,
  data: Record<string, unknown>,
  subject: EffectSubject,
  side: EffectSide,
  weight: number,
): void {
  const layerId = stringAt(data, "layer") ?? "";
  const numberId = stringAt(data, "number_to_modify") ?? EVENT.NUMBER;
  const layer = ctx.event.getLayer(layerId, numberId, side);
  if (!layer) {
    reportOnce(ctx, `layer-missing:${layerId}`, "error", "unknown-stat-layer", layerId,
      `No ${CATEGORY.statLayer} entry \`${layerId}\`, so \`${subject.statId}\` had nowhere to write.`);
    return;
  }

  let num = numberValue(ctx, data["number_provider"], subject, side);
  for (const modifier of modifiersOf(data["number_modifiers"])) {
    if (modifier === "SPELL_DAMAGE_EFFECTIVENESS_MULTI") {
      num = ctx.event.data.getNumber(EVENT.DMG_EFFECTIVENESS, 1) * num;
    }
  }

  if (weight < 1) {
    reportInexactAveraging(ctx, layer.layer.id, subject.statId, weight);
    num *= weight;
  }

  if ((stringAt(data, "modification") ?? "ADD").toUpperCase() === "REDUCE") layer.reduce(num);
  else layer.add(num);

  if (subject.multiUseType === "MULTIPLICATIVE_DAMAGE") {
    ctx.event.addMoreMulti(subject.statId, numberId, subject.dmgMulti);
  }
}

/**
 * `RestoreResourceAction.activate` (RestoreResourceAction.java:33-49).
 *
 *     float val = num_provider.getValue(event, event.getSide(statSource), data);
 *     val *= event.data.getNumber(EventData.ATTACK_COOLDOWN).number;
 *     EventBuilder.ofRestore(event.source, event.getSide(side), type, restore_type, val)...
 *
 * It changes no damage, so this records rather than applies: the hit is unaffected and the
 * caller that asked for `ctx.restores` gets the numbers to turn into a rate.
 *
 * The `ATTACK_COOLDOWN` factor defaults to **1** rather than 0 — `DamageEvent.calcAttackCooldown`
 * sets it up on every event and only a melee *basic attack* swung before its vanilla cooldown
 * expired ever gets less, so a spell and a fully-timed swing both leech in full. (Below 0.3 the
 * game cancels the hit outright, so there is no band where a fraction survives into a rate.)
 *
 * 6.4.13 moved the pooling: in 6.4.8 this method had an `if (restore_type == leech)` branch that
 * called `addLeech` and returned, so `inc_leech` — which lives on the restore event — could never
 * see it. Now the event is always raised and `RestoreResourceEvent.activate` does the pooling, so
 * a leech runs its own layers first. That is why the amount recorded here is a *seed* for the
 * restore event rather than the finished number.
 */
function restoreResource(
  ctx: DamageCtx,
  effectId: string,
  data: Record<string, unknown>,
  subject: EffectSubject,
  side: EffectSide,
  weight: number,
): void {
  const sink = ctx.restores;
  if (sink === undefined) return;

  const amount =
    numberValue(ctx, data["num_provider"], subject, side) *
    ctx.event.data.getNumber(EVENT.ATTACK_COOLDOWN, 1) *
    weight;
  if (amount === 0) return;

  sink.push({
    statId: subject.statId,
    effectId,
    resource: stringAt(data, "type") ?? "health",
    restoreType: stringAt(data, "restore_type") ?? "heal",
    amount,
  });
}

/**
 * `NumberProvider.getValue` (NumberProvider.java:41-76). Four types.
 *
 * `STAT_PERCENT` reads the **base** unit of whichever side the effect is on — a target-side
 * effect reading `mana` reads the target's mana.
 */
function numberValue(
  ctx: DamageCtx,
  raw: unknown,
  subject: EffectSubject,
  side: EffectSide,
): number {
  const node = asObject(raw);
  if (!node) return subject.value;

  const type = stringAt(node, "type") ?? "STAT_DATA";
  const calc = stringAt(node, "calc") ?? "";

  switch (type) {
    case "SPECIFIC_NUMBER": {
      // `Integer.valueOf(calc)` — throws in game on a non-integer, so anything else is a pack bug.
      const parsed = Number.parseInt(calc, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    case "STAT_PERCENT": {
      const sheet = side === "Source" ? ctx.source : ctx.target;
      return (sheetValue(sheet, calc) * subject.value) / 100;
    }
    case "NUMBER_PERCENT":
      return (ctx.event.data.getNumber(calc) * subject.value) / 100;
    case "STAT_DATA":
    default:
      return subject.value;
  }
}

/**
 * Says when probability-weighting a layer contribution is an approximation rather than the
 * answer.
 *
 * Scaling the number a stat adds is exact whenever the layer is linear in its total, which
 * covers `flat_damage` and every plain MULTIPLY layer. It is *not* exact when the layer's
 * clamp is degenerate: `double_damage` declares `min_multi == max_multi == 2`, so any non-zero
 * contribution produces exactly ×2 and the true expectation is
 * `(1 - p) * base + p * 2 * base`, which no single scaled number reproduces.
 */
function reportInexactAveraging(ctx: DamageCtx, layerId: string, statId: string, weight: number): void {
  const layer = ctx.event.index.get(layerId);
  const degenerate = layer !== undefined && layer.minMulti === layer.maxMulti;
  reportOnce(
    ctx,
    `chance-layer:${layerId}:${statId}`,
    degenerate ? "warning" : "info",
    degenerate ? "chance-averaging-inexact" : "chance-averaged",
    statId,
    degenerate
      ? `\`${statId}\` writes to \`${layerId}\`, whose multiplier is pinned to ${layer.minMulti}x, at ${(weight * 100).toFixed(1)}% chance. Averaging a pinned layer is not exact — the real outcomes are "fires" and "does not", and this figure is neither.`
      : `\`${statId}\` fires on ${(weight * 100).toFixed(1)}% of hits and contributed at that fraction.`,
  );
}

function reportOnce(
  ctx: DamageCtx,
  key: string,
  severity: "error" | "warning" | "info",
  code: string,
  path: string,
  message: string,
): void {
  if (ctx.reportedEffects.has(key)) return;
  ctx.reportedEffects.add(key);
  // `info` is not a `Severity`; the schema has two levels and adding a third would ripple into
  // `isLegal`. Anything merely explanatory is recorded as a warning.
  ctx.report(severity === "error" ? "error" : "warning", code, path, message);
}

function modifiersOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((node) => (asObject(node) ? stringAt(asObject(node)!, "type") : undefined))
    .filter((t): t is string => t !== undefined);
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
