import type { DpsResult, FullDpsResult } from "./damage/dps.js";

/**
 * Everything that lands on a target while you play this build, composed in one place.
 *
 * Two surfaces reported a figure called "Total DPS" and composed it independently, and they did
 * not agree: the topbar added summons and not the weapon swing, `vitalsOf` added the swing and
 * not summons. So a minion build — nineteen of this pack's skills, whose whole output is
 * `summonDps` — read as a real number in the chrome and as **zero** in every what-if the app
 * made, which meant the tree hover and the gem ranking both reported that nothing you could do
 * to such a build mattered. Nothing in the types could notice; the docstring on the topbar's
 * copy asserted the two were the same composition.
 *
 * One function now, and both call it. The terms come back beside the sum because the callers
 * want them individually: `Vitals` keeps a field per clock, and the topbar's hint names each.
 */
export type DamageRates = {
  /** True when a rotation is ticked, so it stands in for the single skill everywhere below. */
  inRotation: boolean;
  /** The rotation where one is ticked, the main skill's own figure otherwise. */
  primaryDps: number;
  /**
   * Spells the build casts for you.
   *
   * Already inside {@link primaryDps} when `inRotation` — `simulateFullDps` merges the rotation's
   * procs against one shared `proc_cooldown_ticks` ceiling — so {@link total} adds it only when
   * the single skill is standing in.
   */
  procDps: number;
  /** Ailments, on their own clock. Never part of a hit. */
  ailmentDps: number;
  /** The pets. Never in either DPS figure above; see the note in the body. */
  summonDps: number;
  /** The weapon swing, on its own clock too. 0 where nobody computed one. */
  basicDps: number;
  /**
   * What the swing procs. On the swing's clock, so in the total whichever skill is main — the
   * same reason the swing itself is. It is where Ice-Tipped Blade's Cryogenic Rupture is counted.
   */
  basicProcDps: number;
  /** The sum. What every surface in this app means by "Total DPS". */
  total: number;
};

export function damageRates(parts: {
  /** The main skill, or whichever skill is being asked about. */
  dps: DpsResult | undefined;
  fullDps: FullDpsResult | undefined;
  /**
   * The weapon swing's figure, where the caller has one.
   *
   * Optional because computing it costs an engine call and not every surface pays for one; a
   * caller that omits it gets a total without the swing rather than a wrong one.
   */
  basicDps?: number;
  /** The swing's procs, where the caller has the swing. */
  basicProcDps?: number;
}): DamageRates {
  const rotationDps = parts.fullDps?.dps ?? 0;
  const inRotation = rotationDps > 0;
  const primaryDps = inRotation ? rotationDps : (parts.dps?.dps ?? 0);
  const procDps = (inRotation ? parts.fullDps?.procDps : parts.dps?.procDps) ?? 0;
  const ailmentDps = (inRotation ? parts.fullDps?.ailmentDps : parts.dps?.ailmentDps) ?? 0;
  // Always the single skill's, even inside a rotation: `FullDpsResult` carries no summon term at
  // all, so there is nothing to double-count and nothing else to read. A rotation of two summon
  // skills therefore reports only the main one's pets — an undercount, which is the direction to
  // be wrong in, and one the engine would have to grow a field to fix.
  const summonDps = parts.dps?.summonDps ?? 0;
  const basicDps = parts.basicDps ?? 0;
  const basicProcDps = parts.basicProcDps ?? 0;

  return {
    inRotation,
    primaryDps,
    procDps,
    ailmentDps,
    summonDps,
    basicDps,
    basicProcDps,
    total:
      primaryDps + (inRotation ? 0 : procDps) + ailmentDps + summonDps + basicDps + basicProcDps,
  };
}
