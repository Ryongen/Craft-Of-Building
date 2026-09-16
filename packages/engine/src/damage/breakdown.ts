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

  readonly contributions: LayerContribution[] = [];

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
      side,
      element,
      kind,
      value,
      before,
      after,
    });
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
      (c) =>
        c.layerId === layerId &&
        c.numberId === numberId &&
        c.side === side &&
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
