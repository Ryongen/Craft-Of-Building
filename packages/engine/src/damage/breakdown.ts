/**
 * A trace of how one hit got to its number.
 *
 * The shape is the mod's own damage log, `DamageEvent.getInfoHoverMessage`
 * (DamageEvent.java:567-646), which players turn on with the `damage_messages` config and read
 * as a hover on the combat message:
 *
 *     Spell: Fireball
 *     Fire:
 *     Base Damage: 1240
 *     Damage Info:
 *       [Source]: Flat Damage: +182
 *       [Source]: Additive Damage: x2.35
 *       [Target]: Elemental Mitigation: x0.25
 *     Multipliers:
 *       Stat: More Fire Damage: x1.20
 *     Final Damage: 1092
 *     - Bonus Damage Types:
 *       ... the same block again, per element ...
 *     Total Combined Damage: 1310
 *
 * Two deliberate departures from it.
 *
 * **It records who wrote into each layer.** The game's `StatLayerData` is a bare accumulator —
 * every stat that increases damage adds into one `additive_damage` float and the log prints
 * only the total, so "x2.35" never says which +35% came from where. `MoreMultiData` is the one
 * exception, and it is the exception precisely because a MORE has to be applied separately.
 * Recording the writes costs one array push per stat per event and turns the whole log into
 * something you can drill into, which is the entire point of a planner.
 *
 * **It records the before and after of the number itself**, so a row can show what a layer did
 * rather than only what it was set to.
 *
 * A trace is only built when one is asked for. `simulateHit` runs the pipeline twice, once per
 * crit branch, and a bonus element is a whole nested event — so the recorder is opt-in and the
 * default path allocates nothing.
 */

import type { ElementName } from "@cte2/schema";

import type { EffectSide } from "./event.js";

/** How a stat wrote into a layer's accumulator. */
export type WriteKind = "add" | "reduce" | "multiply" | "conversion";

/**
 * How a defensive layer got from the target's sheet to the number it reduced by.
 *
 * Recorded by the five layers where the accumulator write is not the stat: the two resist
 * mitigations and armour, which spend `penetration`, and dodge and spell dodge, which spend the
 * attacker's `accuracy`. A mob declaring 30 fire resistance against 33.61 penetration reduces
 * the layer by −3.61, and without this the panel could only print that −3.61 beside the sheet's
 * 30 and leave the reader to find the penetration in a badge at the top of the card. Dodge was
 * worse: a mob with 416 dodge against 225 accuracy produced a bare 8.37%, with neither figure
 * nor the curve between them anywhere on screen.
 */
export type MitigationDetail = {
  /** What the target's sheet said, before penetration. */
  sheet: number;
  /** Penetration spent against it. Zero for physical resistance, which never spends any. */
  penetration: number;
  /**
   * The attacker's `accuracy`, subtracted from the target's evasion before the curve.
   *
   * Dodge and spell dodge only. `DodgeRating`: `clamp(dodge - ACCURACY, 0, MAX)` — the same
   * shape as penetration against a resist, and a different stat with a different name, so it is
   * a different field rather than a second meaning for one.
   */
  accuracy?: number;
  /**
   * The integer rating that actually entered the curve, where the layer has one.
   *
   * Armour, dodge and spell dodge all run `value / (value + base)` over a rounded or truncated
   * rating and hand the layer a *percentage*, so the row above and the row below are in
   * different units and nothing between them said where the change happened. The two resist
   * layers have no curve and leave this unset.
   */
  points?: number;
  /**
   * `sheet - penetration`, before the truncation, the clamp or the curve.
   *
   * Deliberately the raw subtraction. The resist effect truncates towards zero before it clamps,
   * so on AMFK the column read −16.80 − 33.61 and landed on −50.00, and the missing .41 was one
   * more number the panel could not account for. Handing over the subtraction itself lets the
   * panel print the step that ate it.
   */
  afterPenetration: number;
  /** The floor the clamp used. Absent where the layer does not clamp — armour's curve. */
  min?: number;
  /** The ceiling the clamp used. Absent where the layer does not clamp — armour's curve. */
  cap?: number;
};

export type LayerContribution = {
  /** The stat whose effect ran. `MoreStep` covers the MORE path separately. */
  statId: string;
  /** The `mmorpg_stat_effect` id, when a datapack block drove the write. */
  effectId: string | undefined;
  layerId: string;
  numberId: string;
  side: EffectSide;
  /** The element a conversion percentage points at. */
  element: string | undefined;
  kind: WriteKind;
  /** The signed amount added to the accumulator, or the percent for a conversion. */
  value: number;
  before: number;
  after: number;
  /** Set by the mitigation layers only. See {@link MitigationDetail}. */
  mitigation?: MitigationDetail;
  /** Set where what the layer got was not the stat's own value. See {@link ScaledWrite}. */
  scaled?: ScaledWrite;
};

/**
 * The stat's own value, and what the event multiplied it by before the layer saw it.
 *
 * `NumberModifier.SPELL_DAMAGE_EFFECTIVENESS_MULTI` is the only modifier of this shape the game
 * has, and it is why flat added damage is the one stat whose sheet reading never matches the row
 * it produces. `BonusFlatElementalDamage` multiplies by the skill's `dmg_effectiveness` before
 * `addBonusEleDmg` — 1.914 on `tailwind_sweep` — so 99.84 on the sheet writes +191.12 into
 * `flat_damage`. Both numbers were already on screen, one under the other, with nothing between
 * them, which reads as the panel inventing damage rather than as the skill carrying it.
 */
export type ScaledWrite = {
  /** What the stat resolved to, before the multiplier. */
  raw: number;
  /** What it was multiplied by. */
  multi: number;
  /** Which multiplier it was, for the row's wording. Only one kind exists so far. */
  reason: "effectiveness";
};

/** One layer's turn during the flush, in layer-priority order. */
export type LayerStep = {
  layerId: string;
  action: string;
  numberId: string;
  side: EffectSide;
  /** The accumulator total — what an `ADD` layer contributes. */
  amount: number;
  /** `getMultiplier()`, for `MULTIPLY` layers. */
  multiplier: number | undefined;
  /** Normalised conversion percentages, for the two conversion actions. */
  conversion: { element: string; percent: number }[];
  /** The target element of an `X_AS_BONUS_Y_ELEMENT_DAMAGE` layer. */
  additionalTo: string | undefined;
  /** `EVENT.NUMBER` on either side of this layer. Equal when the layer touched another number. */
  before: number;
  after: number;
  contributions: LayerContribution[];
};

/** One MORE multiplier, applied after every layer. The game names these too. */
export type MoreStep = {
  statId: string;
  numberId: string;
  multi: number;
  /**
   * The `mmorpg_stat_effect` block behind it — see {@link MoreMulti.effectId}.
   *
   * The reason a breakdown can print "Damage Over Time x1.24" twice and mean two different
   * things: one stat, two blocks, two rows, exactly as the game's own log prints them.
   */
  effectId?: string;
  before: number;
  after: number;
};

export type EventTrace = {
  element: ElementName;
  /** 0 for the hit itself; 1 and 2 for the events conversion and ele-as-extra spawn. */
  depth: number;
  /**
   * A `DAMAGE_TAKEN_AS` child skips the source-side sweep entirely, so its trace legitimately
   * has no offensive layers. Worth saying on screen rather than looking like a gap.
   */
  takenAs: boolean;
  /** The number the event started with, before any layer — the game's `Base Damage` line. */
  baseNumber: number;
  steps: LayerStep[];
  moreMultis: MoreStep[];
  /** What this event contributed, floored at 0 — the game's `Final Damage` line. */
  finalNumber: number;
  /** The shared penetration scalar, which both armour and resist spend. */
  penetration: number;
  children: EventTrace[];
};

/**
 * The mutable side of a trace while an event is in flight.
 *
 * `statId` is set by the sweep around each queued effect, so a layer write knows who made it
 * without every write site having to pass it down.
 */
export class Recorder {
  statId: string | undefined;
  effectId: string | undefined;
  /**
   * Which half of the event the running stat belongs to, set by the sweep alongside `statId`.
   *
   * Not the layer's side. The game keeps one accumulator per layer for both halves and labels it
   * after whichever wrote first, so the mob's `dmg_received` lands in a `[Source]` additive
   * layer. Stamping the contribution with that label sent the panel looking for the stat on
   * your sheet, where nothing grants it.
   */
  side: EffectSide | undefined;

  readonly contributions: LayerContribution[] = [];
  /** The accumulator label each contribution was written into, parallel to `contributions`. */
  private readonly layerSides: EffectSide[] = [];

  write(
    layerId: string,
    numberId: string,
    side: EffectSide,
    kind: WriteKind,
    value: number,
    before: number,
    after: number,
    element?: string,
  ): void {
    // A write that changes nothing is noise — the game drops no-op MORE multipliers for the
    // same reason (`addMoreMulti` skips `multi == 1`).
    if (value === 0) return;
    this.contributions.push({
      statId: this.statId ?? "(unattributed)",
      effectId: this.effectId,
      layerId,
      numberId,
      side: this.side ?? side,
      element,
      kind,
      value,
      before,
      after,
    });
    this.layerSides.push(side);
  }

  /**
   * Attaches the arithmetic behind the write that just happened.
   *
   * Separate from `write` because the accumulator cannot know it: `reduce` is handed one
   * finished number, and the sheet value, the penetration and the clamp that produced it all
   * live inside the effect.
   *
   * `since` is {@link contributions}' length taken *before* the write, and it is what makes
   * "there may be nothing to annotate" safe. A write of zero is dropped — which is right, a
   * mitigation that changed nothing has nothing to explain — and without the guard the detail
   * then landed on whichever contribution happened to be last. On a physical hit that was
   * literally happening: `resistEffect` reduces by 0 against a mob with no physical resistance,
   * and its `{sheet: 0, cap: 75}` was attaching to the `phys_to_water` conversion row directly
   * above it, so the panel offered a resistance drill-down under a conversion.
   */
  annotateSince(since: number, detail: MitigationDetail): void {
    if (this.contributions.length === since) return;
    const last = this.contributions.at(-1);
    if (last !== undefined) last.mitigation = detail;
  }

  /**
   * Attaches the multiplication the event did to a value on its way into a layer.
   *
   * `since` is {@link contributions}' length taken *before* the write, and the guard it gives is
   * not defensive padding: `addBonusEleDmg` only reaches a layer when the flat damage is the
   * element the hit already deals and spawns a bonus-element event otherwise, so without the
   * check an off-element write would annotate whichever contribution happened to be last — a
   * different stat, on a different layer, with a multiplier that was never applied to it.
   */
  scaledSince(since: number, raw: number, multi: number): void {
    if (multi === 1 || this.contributions.length === since) return;
    const last = this.contributions.at(-1);
    if (last !== undefined) last.scaled = { raw, multi, reason: "effectiveness" };
  }

  /**
   * The writes made into one layer accumulator, in the order they happened. `element`
   * distinguishes the per-target-element accumulators `getConversionLayer` creates.
   */
  forLayer(
    layerId: string,
    numberId: string,
    side: EffectSide,
    element: string | undefined,
  ): LayerContribution[] {
    return this.contributions.filter(
      (c, i) =>
        c.layerId === layerId &&
        c.numberId === numberId &&
        this.layerSides[i] === side &&
        (element === undefined || c.element === element),
    );
  }
}

/** Sums a trace tree's `finalNumber` — the game's `Total Combined Damage`. */
export function traceTotal(trace: EventTrace): number {
  let total = trace.finalNumber;
  for (const child of trace.children) total += traceTotal(child);
  return total;
}
