/**
 * Whether you can stand in your own aura.
 *
 * Four of this pack's auras charge you for being in them — Holy Fire takes 33% of your health
 * plus 33% of your magic shield every half second, Sanguine and Abyss and Plague take their own
 * cuts — and the question that decides whether the build works is not "how big is the hit" but
 * "does anything refill it faster than that". The two halves were on different tabs and neither
 * subtracted the other.
 *
 * ## The order the game spends in, and why it decides the answer
 *
 * `MagicShield` absorbs before health does, so a self-hit lands on the shield first and only the
 * overflow reaches the pool underneath. That makes the two regenerations *sequential* rather
 * than pooled: magic shield regeneration pays first, and health regeneration only pays what the
 * shield's could not.
 *
 * It matters because the two are rarely alike. A build with 40 magic shield a second and 10
 * health a second survives a 35/s drain on the shield alone and never touches its health; the
 * same build against a 60/s drain is losing 20 health a second, not 10 — the shield is already
 * empty and everything past it is arriving on the pool that regenerates slowest. Adding the two
 * regenerations together would call both builds fine.
 *
 * ## Deliberately not netted off anything
 *
 * This answers survival, not damage. Nothing here is subtracted from DPS, and the damage the
 * aura deals is not subtracted from this: what you deal and what you pay are different questions
 * and a single number mixing them would answer neither.
 */

/** A pool as the resource pass reports it: how big it is and how fast it comes back. */
export type Pool = {
  max: number;
  /** The regeneration that matters here — the in-combat column, because this is combat. */
  perSecond: number;
};

export type SelfSustainInput = {
  /** `SelfDamage.perSecond` — the post-mitigation drain, at the rate the skill is sustained. */
  perSecond: number;
  /** `SelfDamage.perCast` — one pulse's worth, for the "how long until it kills me" figure. */
  perCast: number;
  magicShield: Pool;
  health: Pool;
  /**
   * The share of your pools below which the effect switches itself off, when it does.
   *
   * `remove_holy_fire_when_very_low` is a real stat on the `holy_fire` effect, and it is the
   * reason Holy Fire is survivable at all on a build that cannot out-regenerate it: the aura
   * drops itself rather than killing you. Its gate is `is_target_very_low`, which carries
   * `check_combined_hp_and_ms: true` — so the threshold is a share of health **plus magic
   * shield**, not of health alone. Unset for an effect with no such mercy.
   */
  cutoffShare?: number | undefined;
};

export type SelfSustain = {
  /** The drain, post-mitigation, per second. */
  drainPerSecond: number;
  /** How much of it magic shield regeneration absorbs — capped by the drain and by the regen. */
  fromShieldRegen: number;
  /** What reaches health regeneration: the drain the shield could not pay for. */
  reachingHealth: number;
  /** How much of *that* health regeneration absorbs. */
  fromHealthRegen: number;
  /**
   * What neither covers, per second. Zero when the build sustains it; positive when it does not,
   * and this is the rate your health bar actually falls at.
   */
  netLossPerSecond: number;
  /** True when the two regenerations between them cover the drain. */
  sustainable: boolean;
  /**
   * Seconds from full to dead at `netLossPerSecond`, or `Infinity` when it is sustained.
   *
   * The shield is spent before the health is, so the pool this drains is both of them — the same
   * order the hit itself lands in.
   */
  secondsToDeath: number;
  /**
   * Seconds until the effect removes itself, for one that does.
   *
   * Different from {@link secondsToDeath} and always shorter: the aura goes out at the cutoff
   * share of your combined bar, with the rest of it still there. It is the honest answer for Holy
   * Fire, whose real failure mode is switching off mid-fight rather than killing you.
   */
  secondsToCutoff?: number;
  /** Pulses you survive from full, ignoring regeneration entirely. */
  castsToEmpty: number;
};

export function selfSustain(input: SelfSustainInput): SelfSustain {
  const drain = Math.max(0, input.perSecond);
  const shieldRegen = Math.max(0, input.magicShield.perSecond);
  const healthRegen = Math.max(0, input.health.perSecond);

  // The shield pays first because the shield is hit first, and it can only pay while there is a
  // shield to regenerate: a build with no magic shield has nothing here however much
  // `magic_shield_regen` its gear rolls, since the stat regenerates a pool of zero.
  const fromShieldRegen = input.magicShield.max > 0 ? Math.min(drain, shieldRegen) : 0;
  const reachingHealth = drain - fromShieldRegen;
  const fromHealthRegen = Math.min(reachingHealth, healthRegen);
  const netLossPerSecond = Math.max(0, reachingHealth - fromHealthRegen);

  const pool = Math.max(0, input.magicShield.max) + Math.max(0, input.health.max);
  const secondsToDeath = netLossPerSecond > 0 ? pool / netLossPerSecond : Infinity;

  // `check_combined_hp_and_ms` — the gate reads both pools as one, so the distance to the cutoff
  // is the share of the *combined* bar above it rather than of health alone.
  const cutoffPool =
    input.cutoffShare === undefined ? undefined : pool * (1 - input.cutoffShare);
  const secondsToCutoff =
    cutoffPool === undefined || netLossPerSecond <= 0 ? undefined : cutoffPool / netLossPerSecond;

  return {
    drainPerSecond: drain,
    fromShieldRegen,
    reachingHealth,
    fromHealthRegen,
    netLossPerSecond,
    sustainable: netLossPerSecond <= 0,
    secondsToDeath,
    ...(secondsToCutoff === undefined ? {} : { secondsToCutoff }),
    castsToEmpty: input.perCast > 0 ? pool / input.perCast : Infinity,
  };
}
