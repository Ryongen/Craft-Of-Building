/**
 * How hard the enemy hits, and how often.
 *
 * `defence.ts` already flies a full incoming hit through the real mitigation layers with the
 * sheets swapped — your armour, your resists, your block and dodge, the mob's accuracy and
 * penetration, its affixes. What it says it cannot do is in its own header:
 *
 *   > **Regeneration, and the second hit.** This is one hit against a character at full. Recovery
 *   > between hits is a different question and needs an incoming-damage rate, which nothing in a
 *   > build document states.
 *
 * This file is the missing half: the size of the hit and the clock it arrives on. Nothing here
 * re-derives mitigation, and nothing here re-derives a proc's chance — both already fall out of
 * the sweep that `defence.ts` runs.
 *
 * ## The hit
 *
 * `EntityData.mobBasicAttack`, read out of `Mine_and_Slash-1.20.1-6.4.13.jar` rather than only
 * the fork:
 *
 *     cooldowns.setOnCooldown(BASIC_ATTACK_COOLDOWN_ID, 5);
 *     float multi = ServerContainer.get().VANILLA_MOB_DMG_AS_EXILE_DMG.get().floatValue();
 *     num = (data.getAmount() * CompatConfig.get().mobPercentBonusDamage() / 100f)
 *             + CompatConfig.get().mobFlatDmg();
 *     num *= multi;
 *     num = StatScaling.MOB_DAMAGE.scale(num, getLevel()); // this should be scaled last
 *
 * Four terms, and three of them were already in this repo:
 *
 *   - `mobPercentBonusDamage` 0.33 and `mobFlatDmg` 6 — {@link ORIGINAL_MODE} in `compat.ts`,
 *     hand-ported from `CompatConfigPreset` with its citation;
 *   - `vanilla_mob_dmg_as_exile_dmg` — a **server config**, not pack data, which the extractor
 *     already reads into `snapshot.externalConfig`. This pack ships 1. `inCombatRegenMultiOf` in
 *     `resources.ts` is the precedent for reading one, down to the "prefer what was extracted,
 *     fall back to the mod's own default" shape;
 *   - `MOB_DAMAGE_SCALING` — `balance().multiFor("MOB_DAMAGE", level)`. The pack's
 *     `original_balance` sets `per_level_scaling: 0.25`, so the curve is `1 + 0.25 * (lvl - 1)`
 *     and the factor at level 100 is **×25.75**. (`compat_mode_balance` sets 0.025 and the jar's
 *     own field initialiser is 0.025 too; the pack entry is what the game loads, and `balance()`
 *     reads the pack.)
 *
 * The one term that is in no registry and no config is `data.getAmount()` — the Minecraft
 * entity's own `generic.attack_damage`. That is what {@link MobOffence.vanillaAttackDamage}
 * states, and the reason it is stated is in that field's doc comment.
 *
 * The order matters and the fork's own comment flags it: the scaling is applied **last**, to the
 * sum, so the flat 6 is scaled too. Applying it to `getAmount()` first would under-report every
 * hit by roughly the whole flat term.
 *
 * ## Then the event multiplies it again
 *
 * `num` is only the event's base — the "Base Damage" line of the mod's damage log. When a monster
 * hits a player, `DamageEvent.addMobDamageMultipliers` then adds MORE multipliers on the event,
 * checked in the 6.4.13 jar:
 *
 *     if (balance.MOB_DMG_POWER_SCALING != 1) {
 *         float multi = (float) (balance.MOB_DMG_POWER_SCALING_BASE
 *                 * (float) Math.pow(balance.MOB_DMG_POWER_SCALING, sourceData.getLevel()));
 *         this.addMoreMulti(() -> Words.LVL_EXPONENT_MOB_DMG.locName(), EventData.NUMBER, multi);
 *     }
 *     MobRarity rar = sourceData.getMobRarity();
 *     this.addMoreMulti(() -> Words.MOB_RARITY_MULTI.locName(), EventData.NUMBER, rar.DamageMultiplier());
 *
 * On `original_balance` the first is `2.2 * 1.01114^lvl`, **×6.66 at level 100**, and the second
 * is the rarity's `dmg_multi` — ×1.75 for Mythic. A level 100 Mythic's basic attack logged in game
 * as Base Damage 154, "Leveled Exponent Mob DMG x6.66", "Mob Rarity Dmg Multi x1.75": leaving
 * these two out under-reported every incoming hit by about 11.7×.
 *
 * Still not modelled from the same method: `HIGH_LVL_MOB_DMG_MULTI` (a mob above your level, off
 * three `LEVEL_DISTANCE_PENALTY_*` server configs) and the map resistance-requirement multiplier.
 * `EntityConfig.dmg_multi` is already {@link MobOffence.totalDamage}.
 *
 * ## The vanilla attribute barely matters, and that is a real finding
 *
 * 0.33 is a *percent*, so a mob's own attack damage contributes `v * 0.0033` against a flat 6.
 * A zombie's 3.0 adds 0.0099 to that 6; a vindicator's 13.0 adds 0.0429. Measured on the Amfk
 * capture at level 100 the two come to **155 and 156** — a difference of less than one percent
 * after the ×25.75.
 *
 * So in `ORIGINAL_MODE` what a mob hits you for is very nearly a function of its *level* alone,
 * and which mob it is hardly enters into it. Both constants are confirmed in the 6.4.13 jar
 * (`ldc2_w 6.0d`, `ldc2_w 0.33000001311302185d` into `DefaultCompatData`), so this is the game's
 * arithmetic rather than a porting slip. It is worth a planner saying out loud, because the
 * obvious reading of an attacker picker — "choose a scarier monster, get a scarier number" — is
 * wrong: the rate is what actually differs between them, and a map's affixes are what actually
 * make a hit hurt.
 *
 * ## A mercenary is not a monster
 *
 * The method's other branch reads `WeaponDamage` off the mercenary's own unit instead, and the
 * fork's comment explains why — the mob formula "never once reads the mercenary's own Weapon
 * Damage", so a mercenary run through it grew with its level twice over. Mercenaries are an
 * accounted gap in this project (`mmorpg_mercenary`), and this file models the monster branch
 * only. It says so rather than quietly covering one with the other.
 *
 * ## What this does not cover
 *
 * A mob that **casts** rather than swings. `mobBasicAttack` is the melee and projectile basic
 * attack; a caster mob's damage comes from a spell's `value_calculation` against its own unit, at
 * a different call site entirely. That is a ranked gap, and naming it is the point — a figure
 * that silently covered only half of what hits you would be worse than one that says which half.
 */

import type { Snapshot } from "@cte2/extractor";
import type { MobOffence } from "@cte2/schema";
import { CATEGORY, entry, serverConfigNumber } from "@cte2/schema";

import { balance } from "../balance.js";
import type { Compat } from "../compat.js";

/**
 * `ServerContainer.VANILLA_MOB_DMG_AS_EXILE_DMG`, as the extractor spells it.
 *
 * Same shape as `resources.ts`'s `IN_COMBAT_REGEN_MULTI_KEY`: the TOML key, read from the install
 * the snapshot was taken from, so a server that tuned it is described rather than assumed.
 */
const VANILLA_MOB_DMG_KEY = "general.vanilla_mob_dmg_as_exile_dmg";

/**
 * The mod's own default for it, for a snapshot taken before the extractor read the TOML.
 *
 * `ServerContainer`'s field initialiser. This pack ships the same value, so the fallback is a
 * floor rather than something load-bearing.
 */
const DEFAULT_VANILLA_MOB_DMG_MULTI = 1;

/**
 * `BASIC_ATTACK_COOLDOWN_ID` is stamped for 5 ticks on every swing — the `iconst_5` in the
 * disassembly. So nothing in the game lands more than four basic attacks a second, whatever its
 * AI goal is doing, and a stated rate above this is describing something the game will not do.
 */
export const MAX_BASIC_ATTACKS_PER_SECOND = 4;

/** The raw hit a mob's basic attack puts on the event, before a single mitigation layer. */
export type MobHit = {
  /** {@link base} times the event's mob multipliers — the hit your mitigation then faces. */
  raw: number;
  /** The stated `generic.attack_damage`, for a breakdown that wants to show its working. */
  vanillaAttackDamage: number;
  /** `(v * mobPercentBonusDamage / 100) + mobFlatDmg`, before the config and level multipliers. */
  afterCompat: number;
  /** `vanilla_mob_dmg_as_exile_dmg`, from the server config or the mod's default. */
  configMulti: number;
  /** `MOB_DAMAGE_SCALING.getMultiFor(level)` — ×25.75 at level 100 on this pack. */
  levelMulti: number;
  /** `num` at the end of `mobBasicAttack`: the damage log's "Base Damage". */
  base: number;
  /** "Leveled Exponent Mob DMG" — ×6.66 at level 100 on this pack. */
  levelExponentMulti: number;
  /** "Mob Rarity Dmg Multi" — the rarity's `dmg_multi`. */
  rarityMulti: number;
};

/**
 * What one basic attack from the described mob is worth, or `undefined` when none is described.
 *
 * `undefined` rather than 0 on purpose, and every caller is expected to keep the distinction: a
 * mob that hits for nothing and a mob nobody has described are different answers, and only one of
 * them is a reason to print a figure.
 */
export function mobHitSize(
  snapshot: Snapshot,
  offence: MobOffence | undefined,
  level: number,
  compat: Compat,
  /** The attacker's `mmorpg_mob_rarity` id. Unset reads as `common`. */
  rarityId?: string,
): MobHit | undefined {
  const vanillaAttackDamage = offence?.vanillaAttackDamage;
  if (vanillaAttackDamage === undefined || vanillaAttackDamage <= 0) return undefined;

  const afterCompat =
    (vanillaAttackDamage * compat.mobPercentBonusDamage) / 100 + compat.mobFlatBonusDamage;
  const configMulti =
    serverConfigNumber(snapshot, VANILLA_MOB_DMG_KEY) ?? DEFAULT_VANILLA_MOB_DMG_MULTI;
  // `this should be scaled last` — the mod author's own comment, and it is load-bearing: the
  // scaling multiplies the flat term too.
  const bal = balance(snapshot);
  const levelMulti = bal.multiFor("MOB_DAMAGE", level);
  const base = afterCompat * configMulti * levelMulti;
  const levelExponentMulti = mobLevelExponentMulti(snapshot, level);
  const rarityMulti = mobRarityDamageMulti(snapshot, rarityId ?? "common");

  return {
    raw: base * levelExponentMulti * rarityMulti,
    vanillaAttackDamage,
    afterCompat,
    configMulti,
    levelMulti,
    base,
    levelExponentMulti,
    rarityMulti,
  };
}

/** "Leveled Exponent Mob DMG": `BASE * SCALING^level`, or 1 when `SCALING` is 1. */
export function mobLevelExponentMulti(snapshot: Snapshot, level: number): number {
  const bal = balance(snapshot);
  if (bal.mobDmgPowerScaling === 1) return 1;
  return bal.mobDmgPowerScalingBase * Math.pow(bal.mobDmgPowerScaling, level);
}

/** `MobRarity.DamageMultiplier()` — the rarity's `dmg_multi`, 1 when the pack has no such rarity. */
export function mobRarityDamageMulti(snapshot: Snapshot, rarityId: string): number {
  const value = entry(snapshot, CATEGORY.mobRarity, rarityId)?.data?.["dmg_multi"];
  return typeof value === "number" ? value : 1;
}

/**
 * How often that hit lands, clamped to what the game will actually deliver.
 *
 * `undefined` when unstated, for the same reason {@link mobHitSize} returns it.
 */
export function mobAttackRate(offence: MobOffence | undefined): number | undefined {
  const rate = offence?.attacksPerSecond;
  if (rate === undefined || rate <= 0) return undefined;
  return Math.min(rate, MAX_BASIC_ATTACKS_PER_SECOND);
}
