/**
 * `EventData` and the mutable state of one `DamageEvent`.
 *
 * `EventData` is a stringly-typed bag — three maps of float, boolean and string, keyed by the
 * constants in EventData.java:16-81. Porting it as a typed struct was tempting and would have
 * been wrong: datapack stats name these keys as *strings* (`number_to_modify: "number"`,
 * `string_key: "attack_type"`), so the bag has to stay open or every unmodelled key becomes an
 * engine change instead of a diagnostic.
 *
 * The one piece of real behaviour in it is the twin:
 *
 *     public void setupNumber(String id, float num) {
 *         if (floats.containsKey(id)) { throw new RuntimeException("Number is already setup: " + id); }
 *         this.getNumber(id).number = num;
 *         this.getOriginalNumber(id).number = num;
 *     }
 *
 * — EventData.java:104-116, with `getOriginalNumber` reading `"original_" + id`. Ailments and
 * every percentage-of-original effect read the twin, so a number that was set rather than *set
 * up* silently has no original to read and behaves as though the hit were for zero.
 */

import { ELEMENTS, type ElementName } from "@cte2/schema";

import type { Recorder } from "./breakdown.js";
import type { LayerData, LayerIndex, StatLayer } from "./layers.js";
import { LAYER, LayerData as Layer } from "./layers.js";

export const EVENT = {
  NUMBER: "number",
  BEFORE_CONVERSION_NUMBER: "before_conversion_number",
  DMG_EFFECTIVENESS: "dmg_effectiveness",
  PENETRATION: "penetration",
  ACCURACY: "accuracy",
  ATTACK_COOLDOWN: "attack_cooldown",
  CRIT: "crit",
  CANCELED: "canceled",
  RESISTED_ALREADY: "resisted_already",
  IS_HIT_AVOIDED: "is_hit_avoided",
  IS_DODGED: "is_dodged",
  IS_BLOCKED: "is_blocked",
  IS_BASIC_ATTACK: "is_basic_atk",
  IS_SUMMON_ATTACK: "is_summon_attack",
  IS_BONUS_ELEMENT_DAMAGE: "is_bonus_element_damage",
  IS_AILMENT_PROC: "is_ailment_proc",
  AILMENT: "ailment",
  ELEMENT: "element",
  ATTACK_TYPE: "attack_type",
  WEAPON_TYPE: "weapon_type",
  SPELL: "spell",
  STYLE: "style",
  /**
   * `EventData.SUMMON_TYPE` — `spell.config.summonType.id`, lower case.
   *
   * The five `max_<type>_summons` stats are each gated on a `string_matches` against it, so with
   * it unset none of them fire and every summon cap reads 0. The snapshot spells it as the enum
   * constant (`"SPIDER"`) and the conditions compare against `SummonType.id` (`"spider"`).
   */
  SUMMON_TYPE: "summon_type",
  RESOURCE_TYPE: "resource_type",
  /** `RestoreType` — `regen`, `leech`, `heal`, `food`, `potion`. The regen tick is `regen`. */
  RESTORE_TYPE: "restore_type",

  // --- the spell-calculation event (`on_spell_stat_calc`) ---------------------------
  //
  // A different event over the same `EventData`, so the ids live in the same table. These are
  // what `SpellStatsCalculationEvent` seeds and what the rate in `spell-calc.ts` reads back.
  CAST_TICKS: "cast_ticks",
  /**
   * `EventData.CAST_SPEED_TICKS` — how long the spell arms the *shared* global cooldown for.
   *
   * New in 6.4.13, and the number that actually governs how often most spells go off. A spell
   * may declare `cooldown_ticks: 0` and still only be castable every `cast_speed_ticks`,
   * because `SpellCastingData.armGlobalCooldown` puts `getCastSpeedTicks(ctx)` on the
   * `GLOBAL_COOLDOWN` key that every spell checks. `cast_speed_ticks <= 0` opts out
   * (`SpellConfiguration.isOffGlobalCooldown`).
   */
  CAST_SPEED_TICKS: "cast_speed_ticks",
  /** `EventData.CAST_SPEED_PERCENT` — where all 40 `*_cast_time` stats and `skill_speed` land. */
  CAST_SPEED_PERCENT: "cast_speed_perc",
  /** `EventData.CHANNEL_SPEED_PERCENT` — added to the above, for `channel`-tagged spells only. */
  CHANNEL_SPEED_PERCENT: "channel_speed_perc",
  COOLDOWN_TICKS: "cd_ticks",
  CHARGE_COOLDOWN_TICKS: "charge_cd_ticks",
  MANA_COST: "mana_cost",
  ENERGY_COST: "energy_cost",
  AREA_MULTI: "area",
  DURATION_MULTI: "duration_multi",
  AGGRO_RADIUS: "aggro_radius",
  AGGRO_RADIUS_MULTI: "aggro_radius_multi",
  PROJECTILE_SPEED_MULTI: "proj_speed",
  PROJECTILE_YAW_SPEED_MULTI: "proj_yaw_speed",
  PROJECTILE_SPREAD_RANDOMNESS: "proj_spread_randomness",
  BONUS_PROJECTILES: "bonus_proj",
  BONUS_CHAINS: "bonus_chains",
  /** `EventData.BONUS_TOTAL_SUMMONS` — `SummonPetAction`'s cap for this spell's summon type. */
  BONUS_TOTAL_SUMMONS: "bonus_total_summons",
  /** How many of a `BlockSummonLimitGroup` may be alive at once. Floored at 1 when unset. */
  MAX_TOTEMS: "max_totems",
  MAX_BANNERS: "max_banners",
  /** How many extra the same cast places at once — `getSummonCount`'s `1 + extra`. */
  EXTRA_TOTEMS: "extra_totems",
  EXTRA_BANNERS: "extra_banners",
  PIERCE: "pierce",
  BARRAGE: "barrage",
  NOVA: "nova",
} as const;

export type EffectSide = "Source" | "Target";

/** `AttackType` — what `string_matches` on `attack_type` compares against. */
export const ATTACK_TYPES = ["hit", "dot", "bonus_dmg"] as const;
export type AttackType = (typeof ATTACK_TYPES)[number];

export class EventData {
  private readonly floats = new Map<string, number>();
  private readonly bools = new Map<string, boolean>();
  private readonly strings = new Map<string, string>();

  /**
   * `setupNumber` — seeds a number *and* its `original_` twin.
   *
   * The game throws on a second setup of the same id. Reproducing the throw would turn a pack
   * quirk into a crash in a build planner, so this returns a flag and lets the caller report.
   */
  setupNumber(id: string, value: number): boolean {
    if (this.floats.has(id)) return false;
    this.floats.set(id, value);
    this.floats.set(`original_${id}`, value);
    return true;
  }

  getNumber(id: string, fallback = 0): number {
    const v = this.floats.get(id);
    if (v === undefined) {
      this.floats.set(id, fallback);
      return fallback;
    }
    return v;
  }

  setNumber(id: string, value: number): void {
    this.floats.set(id, value);
  }

  addNumber(id: string, delta: number): void {
    this.floats.set(id, this.getNumber(id) + delta);
  }

  /** `getOriginalNumber` — `"original_" + id`, seeded only by `setupNumber`. */
  getOriginalNumber(id: string): number {
    return this.getNumber(`original_${id}`);
  }

  isNumberSetup(id: string): boolean {
    return this.floats.has(id);
  }

  getBoolean(id: string): boolean {
    return this.bools.get(id) ?? false;
  }

  setBoolean(id: string, value: boolean): void {
    this.bools.set(id, value);
  }

  getString(id: string, fallback = ""): string {
    return this.strings.get(id) ?? fallback;
  }

  setString(id: string, value: string): void {
    this.strings.set(id, value);
  }

  /** `EventData.getElement()` — `Elements.valueOf(...)`, so this reads the enum **name**. */
  getElement(): ElementName {
    const raw = this.getString(EVENT.ELEMENT, "Physical");
    return raw in ELEMENTS ? (raw as ElementName) : "Physical";
  }

  isCanceled(): boolean {
    return this.getBoolean(EVENT.CANCELED);
  }

  isHitAvoided(): boolean {
    return this.getBoolean(EVENT.IS_HIT_AVOIDED);
  }

  /**
   * `setHitAvoided` (EventData.java:97-102) — flags the avoidance *and zeroes the number*.
   * Dodge and block both route through it, which is why an avoided hit cannot be partially
   * mitigated afterwards: there is nothing left to mitigate.
   */
  setHitAvoided(kind: string): void {
    this.setBoolean(EVENT.IS_HIT_AVOIDED, true);
    this.setBoolean(kind, true);
    this.setNumber(EVENT.NUMBER, 0);
  }

  clone(): EventData {
    const copy = new EventData();
    for (const [k, v] of this.floats) copy.floats.set(k, v);
    for (const [k, v] of this.bools) copy.bools.set(k, v);
    for (const [k, v] of this.strings) copy.strings.set(k, v);
    return copy;
  }
}

/** `MoreMultiData` — a MORE multiplier held out of the layers and applied after all of them. */
export type MoreMulti = {
  statId: string;
  numberId: string;
  multi: number;
  /**
   * The `mmorpg_stat_effect` block that recorded it, when a breakdown was being taken.
   *
   * One stat can carry several `MULTIPLICATIVE_DAMAGE` blocks behind different gates, and the
   * game records — and prints — one `Multipliers:` row per block rather than one per stat. So a
   * breakdown legitimately shows the same name twice with two different numbers, and without
   * this there is nothing on the screen that says which row is which.
   */
  effectId?: string;
};

/** A bonus-element damage event queued by conversion, ele-as-extra, or taken-as. */
export type BonusElement = {
  element: ElementName;
  amount: number;
  /**
   * `DAMAGE_TAKEN_AS` builds its child event with `calcSourceEffects = false` — the damage is
   * already fully multiplied and must not sweep the attacker's stats a second time.
   */
  takenAs: boolean;
};

/**
 * One damage event in flight.
 *
 * `layers` is keyed on `layer|numberId|side` because the game keys it the same way — the
 * source's `additive_damage` and the target's are independent accumulators.
 */
export class DamageEventState {
  readonly data: EventData;
  readonly moreMultis: MoreMulti[] = [];
  readonly bonusElements: BonusElement[] = [];
  private readonly layers = new Map<string, LayerData>();

  /**
   * `unconvertedDamagePercent` — starts at 100 and is decremented by every conversion. Ailments
   * read it to avoid double-counting damage that left as another element.
   */
  unconvertedDamagePercent = 100;

  /** The same budget for `DAMAGE_TAKEN_AS`, which the game tracks separately. */
  unconvertedDamageTakenAsPercent = 100;

  /**
   * `DamageEvent.conversionDepth`, capped by `MAX_CONVERSION_DEPTH = 2`. Conversion,
   * ele-as-extra and taken-as all refuse to run at or past the cap, which is what stops a
   * phys→fire→phys pair from looping.
   */
  conversionDepth = 0;

  /** The `flat_damage` layer's total, captured during the flush for ailments to read. */
  appliedFlatDamage = 0;

  /**
   * `damage_block`'s multiplier — the share of hits that are not evaded — captured on the way
   * past, the same way {@link appliedFlatDamage} is.
   *
   * 1 on an event nothing dodged, which is most of them: the layer is only written by
   * `DodgeRating` and `SpellDodgeEffect`, and only one of the two can gate any given hit.
   * Captured here rather than derived by a caller because the layer is spent during the flush
   * and afterwards the accumulator no longer describes what it did — and because a reader is
   * entitled to the figure whether or not a breakdown was asked for, which rules out reading it
   * off the trace.
   */
  hitChance = 1;

  /** Present only when a breakdown was asked for; see `damage/breakdown.ts`. */
  readonly recorder: Recorder | undefined;

  constructor(
    readonly index: LayerIndex,
    data?: EventData,
    recorder?: Recorder,
  ) {
    this.data = data ?? new EventData();
    this.recorder = recorder;
  }

  /** `EffectEvent.getLayer(layer, numberId, side)`, creating on demand as the game does. */
  getLayer(layerId: string, numberId: string, side: EffectSide): LayerData | undefined {
    const layer = this.index.get(layerId);
    if (!layer) return undefined;
    return this.layerFor(layer, numberId, side);
  }

  layerFor(layer: StatLayer, numberId: string, side: EffectSide): LayerData {
    return this.keyed(`${layer.id}|${numberId}`, layer, numberId, side);
  }

  /**
   * `EffectEvent.getConversionLayer(layer, element, numberId, side)` — one accumulator per
   * *target element*, which is why `X_AS_BONUS_Y_ELEMENT_DAMAGE` needs only a single `to`
   * rather than a map.
   */
  getConversionLayer(
    layerId: string,
    element: ElementName,
    numberId: string,
    side: EffectSide,
  ): LayerData | undefined {
    const layer = this.index.get(layerId);
    if (!layer) return undefined;
    const data = this.keyed(`${layer.id}|${element}|${numberId}`, layer, numberId, side);
    data.additionalTo = element;
    return data;
  }

  /**
   * One accumulator per (layer, number) — **not** per side.
   *
   *     public StatLayerData getLayer(StatLayer layer, String number, EffectSides side) {
   *         String id = layer.GUID() + "_" + number;
   *         if (!layers.containsKey(id)) {
   *             var data = new StatLayerData(layer.GUID(), number, 0, side);
   *             layers.put(id, data);
   *         }
   *         return layers.get(id);
   *     }
   *
   * — EffectEvent.java:110-119, and `getConversionLayer` keys the same way with the element
   * appended. The `side` is used only when the accumulator is *created*: it stamps the
   * `[Source]` / `[Target]` label and is then never consulted again, so whichever half of the
   * event writes first names the row and both halves add into it.
   *
   * Keying by side instead made the attacker's and the defender's contributions two separate
   * layers, and two `MULTIPLY` layers multiply where one would have summed. On the capture that
   * found this, `attack_damage_received` from `soul_impale` sat in a `[Target] additive_damage`
   * of its own: the engine produced 1.5776 x 1.1080, where the game produced a single
   * (57.76 + 10.80)% row. The gap is small on one debuff and compounds on every layer both
   * sides touch.
   */
  private keyed(key: string, layer: StatLayer, numberId: string, side: EffectSide): LayerData {
    let data = this.layers.get(key);
    if (!data) {
      data = new Layer(layer, numberId, side, this.recorder);
      this.layers.set(key, data);
    }
    return data;
  }

  /**
   * `getSortedLayers()` (EffectEvent.java:211-216) sorts `layers.values()` by layer priority.
   * Layer priorities are distinct so the game's sort is stable in practice; ties are broken
   * here on the composite key so the engine is deterministic even if a pack adds a collision.
   */
  sortedLayers(): LayerData[] {
    return [...this.layers.entries()]
      .sort(([ak, a], [bk, b]) =>
        a.layer.priority === b.layer.priority
          ? ak.localeCompare(bk)
          : a.layer.priority - b.layer.priority,
      )
      .map(([, data]) => data);
  }

  hasLayers(): boolean {
    return this.layers.size > 0;
  }

  /**
   * `EffectEvent.addMoreMulti`, which opens by refusing a multiplier of exactly 1:
   *
   *     fload_3; fconst_1; fcmpl; ifeq <return>
   *
   * — read off the shipped 6.4.13 jar, because neither checkout overrides it. Arithmetically the
   * guard changes nothing, but the damage log prints one `Multipliers:` row per recorded MORE,
   * so without it the breakdown grows rows the game never shows and stops lining up with the
   * hover it was built to be compared against. A 179-stat pack has a lot of `x1.000` to emit.
   */
  addMoreMulti(statId: string, numberId: string, multi: number): void {
    if (multi === 1) return;
    const effectId = this.recorder?.effectId;
    this.moreMultis.push({ statId, numberId, multi, ...(effectId === undefined ? {} : { effectId }) });
  }

  /**
   * `DamageEvent.addBonusEleDmg` (DamageEvent.java:284-289).
   *
   *     if (element == getElement()) {
   *         this.getLayer(StatLayers.Offensive.FLAT_DAMAGE, EventData.NUMBER, side).add(dmg);
   *     } else {
   *         bonusElementDamageMap.put(element, (int) (bonusElementDamageMap.getOrDefault(element, 0) + dmg));
   *     }
   *
   * The branch is the whole point and it is easy to miss: flat damage of the element the hit is
   * already dealt as does **not** become a second event. It goes onto the `flat_damage` layer of
   * *this* one, where every additive and crit multiplier then applies to it — which is why
   * `flat_physical_added_damage` is worth so much more on a physical skill than on a fire one.
   *
   * `bonusElementDamageMap` is a `Map<Elements, Integer>`, so a second write to the same element
   * merges into the first and the running total truncates. Pushing a separate entry per write
   * would spawn a second child event and round differently.
   */
  addBonusEleDmg(element: ElementName, dmg: number, side: EffectSide): void {
    if (element === this.data.getElement()) {
      this.getLayer(LAYER.FLAT_DAMAGE, EVENT.NUMBER, side)?.add(dmg);
      return;
    }
    this.mergeBonus(element, dmg, false);
  }

  /**
   * `DamageEvent.addDamageTakenAsEleDmg` (DamageEvent.java:295-298) — the target's own
   * "x damage taken as y", kept in its own map.
   *
   * It cannot go through `addBonusEleDmg`: that would route it back into `flat_damage` when the
   * element matches — already applied by the time this runs, so the damage would simply vanish —
   * and the event built from it must not sweep the attacker's stats a second time.
   */
  addDamageTakenAsEleDmg(element: ElementName, dmg: number): void {
    this.mergeBonus(element, dmg, true);
  }

  private mergeBonus(element: ElementName, dmg: number, takenAs: boolean): void {
    const existing = this.bonusElements.find((b) => b.element === element && b.takenAs === takenAs);
    if (existing) existing.amount = Math.trunc(existing.amount + dmg);
    else this.bonusElements.push({ element, amount: Math.trunc(dmg), takenAs });
  }

  get penetration(): number {
    return this.data.getNumber(EVENT.PENETRATION);
  }

  set penetration(value: number) {
    this.data.setNumber(EVENT.PENETRATION, value);
  }

  get damage(): number {
    return this.data.getNumber(EVENT.NUMBER);
  }
}
