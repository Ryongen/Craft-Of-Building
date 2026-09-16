/**
 * The stat container: `InCalcStatData` and `InCalcStatContainer`, ported.
 *
 * Three running numbers per stat, resolved once at the end. The whole reason the engine can
 * be checked against the game is that this resolution is short and exact:
 *
 *     float finalValue = stat.base;
 *     finalValue += Flat;
 *     finalValue *= 1 + Percent / 100;
 *     if (stat.getMultiUseType() == Stat.MultiUseType.MULTIPLY_STAT) { finalValue *= Multi; }
 *     return Mth.clamp(finalValue, stat.min, stat.getHardCap());
 *
 * — InCalcStatData.java:35-50. The `if` is the load-bearing line: a `MULTIPLICATIVE_DAMAGE`
 * stat keeps its MORE modifiers out of its value and hands them to the damage layer instead.
 */

import type { ExactMod } from "./modifier.js";
import type { StatIndex } from "./stat-def.js";

/** `StatData`: what a stat resolves to. `m` is `dmgMulti`. */
export type StatValue = { value: number; dmgMulti: number };

export class InCalcStat {
  flat = 0;
  percent = 0;
  multi = 1;

  constructor(readonly id: string) {}

  /** `InCalcStatData.add` (InCalcStatData.java:68-82). */
  add(mod: ExactMod): void {
    if (mod.type === "FLAT") this.flat += mod.value;
    else if (mod.type === "PERCENT") this.percent += mod.value;
    else this.multi *= 1 + mod.value / 100;
  }

  /** `addAlreadyScaledFlat` — a flat contribution that has already been level-scaled. */
  addFlat(value: number): void {
    this.flat += value;
  }

  /**
   * `addFullyTo` (InCalcStatData.java:61-65):
   *
   *     other.Flat += Flat;
   *     other.Percent += Percent;
   *     other.Multi += 1F - Multi; // todo might be buggy // should be fixed now
   *
   * The third line adds where every other MORE path multiplies. Keep it: an `elemental_resist`
   * with a MORE on it does not hand that MORE on the way a player would expect, and the point
   * of this engine is to say what the game says.
   */
  addFullyTo(other: InCalcStat): void {
    other.flat += this.flat;
    other.percent += this.percent;
    other.multi += 1 - this.multi;
  }

  /** `clear` (InCalcStatData.java:29-33). Note `Multi` goes to 0, not 1. */
  clear(): void {
    this.flat = 0;
    this.percent = 0;
    this.multi = 0;
  }
}

export class InCalcContainer {
  private readonly stats = new Map<string, InCalcStat>();

  constructor(private readonly index: StatIndex) {}

  /** `getStatInCalculation` — creating on demand, as the game does. */
  of(id: string): InCalcStat {
    let stat = this.stats.get(id);
    if (!stat) {
      stat = new InCalcStat(id);
      this.stats.set(id, stat);
    }
    return stat;
  }

  has(id: string): boolean {
    return this.stats.has(id);
  }

  ids(): string[] {
    return [...this.stats.keys()];
  }

  apply(mod: ExactMod): void {
    this.of(mod.statId).add(mod);
  }

  /** `InCalcStatContainer.calculate` — resolve every stat in flight. */
  calculate(): StatContainer {
    const out = new Map<string, StatValue>();
    for (const [id, stat] of this.stats) {
      const shape = this.index.shapeOf(id);
      let value = shape.base + stat.flat;
      value *= 1 + stat.percent / 100;
      if (shape.multiUseType === "MULTIPLY_STAT") value *= stat.multi;
      out.set(id, {
        value: clamp(value, shape.min, shape.max),
        dmgMulti: shape.multiUseType === "MULTIPLICATIVE_DAMAGE" ? stat.multi : 1,
      });
    }
    return new StatContainer(out, this.index);
  }
}

/** `StatContainer`: resolved stats, still mutable by the after-calculation passes. */
export class StatContainer {
  constructor(
    private readonly stats: Map<string, StatValue>,
    private readonly index: StatIndex,
  ) {}

  /** `getCalculatedStat` — missing stats read as `StatData.empty()`, i.e. 0 with a multi of 1. */
  get(id: string): StatValue {
    return this.stats.get(id) ?? { value: 0, dmgMulti: 1 };
  }

  getOrCreate(id: string): StatValue {
    let stat = this.stats.get(id);
    if (!stat) {
      stat = { value: 0, dmgMulti: 1 };
      this.stats.set(id, stat);
    }
    return stat;
  }

  /** `StatData.setValue` — clamped to the hard cap, not the soft one. */
  setValue(id: string, value: number): void {
    const shape = this.index.shapeOf(id);
    this.getOrCreate(id).value = clamp(value, shape.min, shape.max);
  }

  /**
   * `StatData.softCapStat`, the final pass:
   *
   *     this.v1 = Mth.clamp(this.v1, GetStat().min, GetStat().getCap(data));
   *
   * where `getCap` is the soft cap plus `getAdditionalMax` only when one is set, and the hard
   * cap otherwise (Stat.java:116-121). Nothing in the mod calls `setSoftCap`, so in practice
   * this re-clamps to the same bounds `calculate` already applied. It runs anyway, because
   * the after-calculation passes can push a value past them.
   */
  applySoftCaps(): void {
    for (const [id, stat] of this.stats) {
      const shape = this.index.shapeOf(id);
      const cap = shape.hasSoftcap ? shape.softcap : shape.max;
      stat.value = clamp(stat.value, shape.min, cap);
    }
  }

  clone(): StatContainer {
    return new StatContainer(new Map([...this.stats].map(([id, s]) => [id, { ...s }])), this.index);
  }

  ids(): string[] {
    return [...this.stats.keys()];
  }

  entries(): [string, StatValue][] {
    return [...this.stats];
  }
}

/** `Mth.clamp`. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
