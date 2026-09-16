/**
 * `StatLayer` and `StatLayerData` — the damage layers and the running numbers stats write into.
 *
 * All 14 layers come from `mmorpg_stat_layer`, and all 14 are jar entries with no pack
 * override, so the table below is CTE2's as much as it is Mine and Slash's. They are read from
 * the snapshot rather than hardcoded — a pack that adds a layer should not need an engine
 * change to have it noticed.
 *
 * A layer is not a number, it is an *accumulator with an action*. Stats spend the whole first
 * half of the event calling `add`/`reduce` on layers; nothing is applied to the damage until
 * the flush at stat-priority 30, and then they apply in `priority` order.
 */

import type { Snapshot } from "@cte2/extractor";
import { CATEGORY } from "@cte2/schema";

import type { Recorder, WriteKind } from "./breakdown.js";

/**
 * `StatLayer.LayerAction`. Five of them, and only two do arithmetic on the number directly —
 * the other three move damage between elements.
 */
export const LAYER_ACTIONS = [
  "ADD",
  "MULTIPLY",
  "CONVERT_PERCENT",
  "DAMAGE_TAKEN_AS",
  "X_AS_BONUS_Y_ELEMENT_DAMAGE",
] as const;
export type LayerAction = (typeof LAYER_ACTIONS)[number];

export function isLayerAction(value: string): value is LayerAction {
  return (LAYER_ACTIONS as readonly string[]).includes(value);
}

export type StatLayer = {
  id: string;
  name: string;
  priority: number;
  minMulti: number;
  maxMulti: number;
  action: LayerAction;
};

/** The layer ids the pipeline names directly (`StatLayers.java:11-37`). */
export const LAYER = {
  FLAT_DAMAGE: "flat_damage",
  DAMAGE_CONVERSION: "damage_conversion",
  ELE_AS_EXTRA_FLAT: "ele_as_extra_flat",
  ADDITIVE_DAMAGE: "additive_damage",
  DOT_DMG_MULTI: "dot_dmg_multi",
  CRIT_DAMAGE: "crit_damage",
  DOUBLE_DAMAGE: "double_damage",
  DAMAGE_TAKEN_AS: "damage_taken_as",
  ARMOR_MITIGATION: "armor_mitigation",
  PHYSICAL_MITIGATION: "physical_mitigation",
  ELEMENTAL_MITIGATION: "elemental_mitigation",
  DAMAGE_REDUCTION: "damage_reduction",
  DAMAGE_SUPPRESSION: "damage_suppression",
  DAMAGE_BLOCK: "damage_block",
  FLAT_DAMAGE_REDUCTION: "flat_damage_reduction",
} as const;

export type LayerIndex = {
  get(id: string): StatLayer | undefined;
  /** Every layer, already sorted by `priority` — the order the flush applies them in. */
  sorted(): StatLayer[];
};

/**
 * Cached per snapshot. Everything a `LayerIndex` hands out is immutable — `StatLayer` is a
 * plain record and `sorted()` copies — so unlike `statIndex` the whole object can be shared.
 * The mutable half of the layer system is `LayerData`, which the damage event owns.
 */
const LAYER_CACHE = new WeakMap<Snapshot, LayerIndex>();

export function layerIndex(snapshot: Snapshot): LayerIndex {
  const cached = LAYER_CACHE.get(snapshot);
  if (cached) return cached;

  const built = buildLayerIndex(snapshot);
  LAYER_CACHE.set(snapshot, built);
  return built;
}

function buildLayerIndex(snapshot: Snapshot): LayerIndex {
  const layers = new Map<string, StatLayer>();

  for (const [id, entry] of Object.entries(snapshot.registries[CATEGORY.statLayer] ?? {})) {
    const data = entry.data;
    const action = data["action"];
    layers.set(id, {
      id,
      name: typeof data["name"] === "string" ? data["name"] : id,
      priority: numberAt(data, "priority") ?? 0,
      minMulti: numberAt(data, "min_multi") ?? -1,
      maxMulti: numberAt(data, "max_multi") ?? 1000,
      action: typeof action === "string" && isLayerAction(action) ? action : "MULTIPLY",
    });
  }

  const sorted = [...layers.values()].sort((a, b) =>
    a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority - b.priority,
  );

  return { get: (id) => layers.get(id), sorted: () => [...sorted] };
}

/**
 * `StatLayerData` — one layer's accumulator for one number on one side of the event.
 *
 * The game keys these on `layer + numberID + side`, so the source's `additive_damage` and the
 * target's are separate running totals that happen to apply to the same number.
 */
export class LayerData {
  number = 0;

  /**
   * Per-element percentages, for `CONVERT_PERCENT` and `DAMAGE_TAKEN_AS`. The game keeps these
   * in two separate `Conversion` fields on the same object; one map serves because no layer
   * uses both actions.
   */
  readonly conversion = new Map<string, number>();

  /**
   * `AdditionalConversion` — the single `{to, percent}` `X_AS_BONUS_Y_ELEMENT_DAMAGE` reads.
   * It is one element rather than a map because the game keys the whole *layer* per element
   * (`getConversionLayer`), so each target element gets its own accumulator.
   */
  additionalTo: string | undefined;

  constructor(
    readonly layer: StatLayer,
    readonly numberId: string,
    readonly side: "Source" | "Target",
    /**
     * Set only when a breakdown was asked for. The accumulator is a bare float in the game,
     * so this is the only place the stat behind a `+35%` can still be named — after the flush
     * there is nothing left but the total.
     */
    private readonly recorder?: Recorder,
  ) {}

  /** `StatLayerData.convertDamage` / `.damageTakenAs` — both accumulate into `conversion`. */
  addConversion(element: string, percent: number): void {
    const before = this.conversion.get(element) ?? 0;
    this.conversion.set(element, before + percent);
    this.record("conversion", percent, before, before + percent, element);
  }

  add(value: number): void {
    const before = this.number;
    this.number += value;
    this.record("add", value, before, this.number);
  }

  reduce(value: number): void {
    const before = this.number;
    this.number -= value;
    this.record("reduce", -value, before, this.number);
  }

  multiply(value: number): void {
    const before = this.number;
    this.number *= value;
    this.record("multiply", this.number - before, before, this.number);
  }

  private record(kind: WriteKind, value: number, before: number, after: number, element?: string): void {
    // `additionalTo` is the fallback because `getConversionLayer` keys a separate accumulator
    // per *target* element: without it, two "x% as extra fire" and "y% as extra cold" writes
    // into the same layer id would be indistinguishable in the trace.
    this.recorder?.write(
      this.layer.id,
      this.numberId,
      this.side,
      kind,
      value,
      before,
      after,
      element ?? this.additionalTo,
    );
  }

  /**
   * `getNumber()` (StatLayerData.java:107-111):
   *
   *     public float getNumber() {
   *         var lay = getLayer();
   *         float num = number; // MathHelper.clamp(number, lay.min_multi, lay.max_multi);
   *         return num;
   *     }
   *
   * The clamp is commented out in the source. That is not a stale comment — it is why the two
   * `ADD` layers ignore their declared bounds entirely, so `flat_damage`'s ±1e8 and
   * `flat_damage_reduction`'s -1000 floor are dead numbers in this version. Reinstating the
   * clamp here would quietly disagree with the game on any build with large flat damage.
   */
  getNumber(): number {
    return this.number;
  }

  /**
   * `getMultiplier()` (StatLayerData.java:113-121) — this one *does* clamp.
   *
   *     float multi = 1 + (num / 100F);
   *     multi = MathHelper.clamp(multi, lay.min_multi, lay.max_multi);
   *
   * `double_damage` declares `min_multi == max_multi == 2`, so the clamp forces exactly ×2 the
   * moment any stat touches it — a 1% chance of double damage and a 500% one produce the same
   * multiplier once they fire.
   */
  getMultiplier(): number {
    const multi = 1 + this.number / 100;
    return clampTo(multi, this.layer.minMulti, this.layer.maxMulti);
  }

  /**
   * `Conversion.normalizeNumbersToCapTo100()` — conversion percentages are scaled down
   * proportionally when they sum past 100, rather than the excess being dropped.
   */
  normalizedConversion(): Map<string, number> {
    const total = [...this.conversion.values()].reduce((sum, v) => sum + v, 0);
    if (total <= 100 || total === 0) return new Map(this.conversion);
    const scale = 100 / total;
    return new Map([...this.conversion].map(([k, v]) => [k, v * scale]));
  }
}

function clampTo(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
