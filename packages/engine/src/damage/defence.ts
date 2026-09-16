/**
 * What it takes to kill you — effective HP, per element.
 *
 * The offensive half of this engine already flies a hit through fourteen layers and asks the
 * *target's* sheet what happens to it. Defence is the same walk with the sheets swapped: the
 * character is the target, the attacker is the mob `config.enemy` describes, and the question is
 * what fraction of a raw incoming hit reaches the pools.
 *
 * So nothing here re-derives mitigation. `sweep` runs the same `armor_mitigation`,
 * `physical_mitigation`, `elemental_mitigation`, `damage_reduction`, `damage_suppression`,
 * `damage_block` and `flat_damage_reduction` layers the offensive pass does, off the same stat
 * effects. Only the pools and the avoidance averaging are new.
 *
 * ## The pools
 *
 * `magic_shield` absorbs first, and it is not simply added to health:
 *
 *     float bypassing = getChaosDamageBypassingShield(effect, info, dmg);
 *     float dmgReduced = Mth.clamp(dmg - bypassing, 0, current);
 *     ...
 *     return dmg - dmgReduced;
 *
 * — MagicShield.modifyEntityDamage, with `CHAOS_BYPASS_PERCENT = 50`. Half of chaos damage walks
 * past the shield straight into health, unless `chaos_doesnt_bypass_magic_shield` is above zero.
 * That makes the chaos pool `min(health + shield, 2 × health)` rather than `health + shield`: once
 * your shield is bigger than your health, the bypassing half kills you before the shield empties.
 *
 * ## What is deliberately not folded in
 *
 * **Mana absorption.** `DamageAbsorbedByMana` sends a percentage of each hit to mana, but only
 * while mana is above half its maximum and only down to that half:
 *
 *     if (currentMana / maxMana > 0.5F) {
 *         float dmgReduced = Mth.clamp(dmg * data.getValue() / 100F, 0, currentMana - (maxMana * 0.5F));
 *
 * so it is a buffer of `maxMana / 2` that drains at a fixed rate, not a pool. It is reported with
 * its two numbers rather than folded into one, because folding it in would mean inventing a
 * regeneration model to say how full the mana was when the hit landed.
 *
 * **Regeneration, and the second hit.** This is one hit against a character at full. Recovery
 * between hits is a different question and needs an incoming-damage rate, which nothing in a build
 * document states. `resources.ts` says how fast each pool refills between them.
 *
 * **Crit, and the attacker's damage increases.** Effective HP answers "how much *raw* incoming
 * damage do I survive". A crit, or a mob whose `dmg_multi` is 2, makes the raw number bigger — it
 * does not make your mitigation worse — so folding either in would be answering a different
 * question twice. They are recorded on `EnemySetup.offence` and reported beside the figure.
 *
 * ## The attacker
 *
 * Not a bare zero any more. `config.enemy.offence` carries what the mob hits with, and the two
 * entries that change *mitigation* — accuracy, which is subtracted from your dodge, and
 * penetration, which is taken off armour and off the raw resist before its clamp — are swept from
 * the Source side exactly as a player's would be. `buildTargetEnemy` fills it the way the Training
 * Dummy's presets do, from `MobStatUtils`: accuracy on the armour curve, and nothing else, because
 * nothing else is what the game gives a mob.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, Diagnostic, ElementName, MobOffence } from "@cte2/schema";
import { SINGLE_ELEMENTS } from "@cte2/schema";

import { balance } from "../balance.js";
import { resolveEffects, type EngineOptions, type EngineResult } from "../calculate.js";
import { ORIGINAL_MODE, type Compat } from "../compat.js";
import { statIndex } from "../stat-def.js";
import type { DamageCtx, Sheet } from "./ctx.js";
import { EVENT, DamageEventState } from "./event.js";
import { layerIndex } from "./layers.js";
import { Recorder, type LayerStep, type MoreStep } from "./breakdown.js";
import { sweep } from "./simulate.js";

/** The character's pools, as the game keeps them. */
export type Pools = {
  /** `health` — the Mine and Slash pool, not vanilla hearts. */
  health: number;
  /** `magic_shield`, which absorbs before health. */
  magicShield: number;
  /**
   * `damage_absorbed_by_mana`: the percent of each post-mitigation hit mana takes, and how much
   * mana is available to take it (half the maximum — the stat stops at that floor).
   */
  manaAbsorb: { percent: number; buffer: number };
};

export type ElementDefence = {
  element: ElementName;
  /** Fraction of a raw incoming hit that reaches the pools. 1 means nothing stopped it. */
  taken: number;
  /** The pool this element actually has to chew through, after the chaos bypass. */
  pool: number;
  /** Raw incoming damage survivable: `pool / taken`. */
  effectiveHealth: number;
  /** Layer by layer, so a number on screen can be taken apart. */
  steps: LayerStep[];
};

export type Defence = {
  pools: Pools;
  /** The reference hit the layers were measured against — `flat_damage_reduction` needs a size. */
  hitSize: number;
  /** The attacker's level, which the armour and dodge curves are read at. */
  attackerLevel: number;
  byElement: ElementDefence[];
  /** The element with the lowest effective HP: what actually kills you. */
  weakest: ElementDefence;
  diagnostics: Diagnostic[];
};

export type DefenceOptions = {
  balanceId?: string;
  baseStatsId?: string;
  compat?: Compat;
  /** `CompatConfig.newbieResists()` — see `collect/newbie-resists.ts`. Defaults to on. */
  newbieResists?: boolean;
  /**
   * The size of the incoming hit, before any mitigation.
   *
   * It matters because two layers are flat rather than proportional — `flat_damage_reduction`,
   * which `damage_shield` writes to — so "how much of a hit do I take" has no single answer.
   * Defaults to one full life bar, which is the scale at which the question is interesting.
   */
  hitSize?: number;
  /** A sheet already computed for this build, to avoid a second stat pass. */
  sheet?: EngineResult;
};

/**
 * Effective HP, per element.
 *
 * One hit, against a character at full, from the attacker `config.enemy` describes. The two
 * things a mob brings that change *mitigation* — accuracy, which is subtracted from your dodge,
 * and penetration, which comes off armour and off the raw resist before its clamp — are swept
 * from the Source side exactly as a player's would be. Everything else a mob has belongs to how
 * big the hit is rather than to how much of it you stop, and is reported beside the figure
 * instead of folded into it.
 *
 * With an empty `config.enemy.offence` that leaves a bare attacker, and these figures are then
 * the optimistic end: your own resists and armour at face value. A target preset fills it from
 * `MobStatUtils`, which gives a mob accuracy and nothing else.
 */
export function defence(
  build: BuildDoc,
  snapshot: Snapshot,
  options: DefenceOptions = {},
): Defence {
  const diagnostics: Diagnostic[] = [];
  const index = statIndex(snapshot);
  const layers = layerIndex(snapshot);
  const bal = balance(snapshot, options.balanceId);
  const compat = options.compat ?? ORIGINAL_MODE;

  const engineOptions: EngineOptions = {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
    ...(options.newbieResists === undefined ? {} : { newbieResists: options.newbieResists }),
  };
  const run = options.sheet ?? resolveEffects(build, snapshot, engineOptions);
  const sheet = run.stats;

  const health = sheet.get("health")?.value ?? 0;
  const magicShield = sheet.get("magic_shield")?.value ?? 0;
  const manaPercent = sheet.get("damage_absorbed_by_mana")?.value ?? 0;
  const mana = sheet.get("mana")?.value ?? 0;
  const pools: Pools = {
    health,
    magicShield,
    manaAbsorb: { percent: manaPercent, buffer: manaPercent > 0 ? mana / 2 : 0 },
  };

  const hitSize = options.hitSize ?? Math.max(1, health + magicShield);
  // The curves for armour and dodge are read at the *attacker's* level, so an incoming hit needs
  // one. The enemy block is where a document states who it is fighting.
  const attackerLevel =
    build.config?.enemy?.level ?? build.config?.enemyLevel ?? build.character.level;

  // `chaos_doesnt_bypass_magic_shield` switches the bypass off entirely.
  const shieldHolds = (sheet.get("chaos_doesnt_bypass_magic_shield")?.value ?? 0) > 0;

  const offence = build.config?.enemy?.offence ?? {};
  const attacker = attackerSheet(offence);

  const byElement = SINGLE_ELEMENTS.map((element) => {
    const { taken, steps } = takenFraction({
      snapshot,
      index,
      layers,
      balance: bal,
      compat,
      build,
      sheet,
      effects: run.effects,
      element: element.name,
      hitSize,
      attackerLevel,
      attacker,
      diagnostics,
    });

    const pool = poolFor(element.guid, health, magicShield, shieldHolds);
    return {
      element: element.name,
      taken,
      pool,
      effectiveHealth: taken > 0 ? pool / taken : Number.POSITIVE_INFINITY,
      steps,
    };
  });

  const weakest = byElement.reduce((worst, entry) =>
    entry.effectiveHealth < worst.effectiveHealth ? entry : worst,
  );

  if (pools.manaAbsorb.percent > 0) {
    diagnostics.push({
      severity: "info",
      code: "mana-absorb-not-in-ehp",
      path: "config",
      message:
        `\`damage_absorbed_by_mana\` sends ${pools.manaAbsorb.percent.toFixed(1)}% of every hit to ` +
        `mana, but only while mana is above half its maximum — a buffer of ` +
        `${Math.round(pools.manaAbsorb.buffer)}, not a pool. How full that buffer is when a hit ` +
        `lands depends on regeneration between hits, which nothing in a build document states, so ` +
        `it is reported beside the effective HP rather than added to it.`,
    });
  }
  const pierces =
    (offence.armorPenetration ?? 0) > 0 ||
    Object.values(offence.penetration ?? {}).some((v) => v > 0);
  diagnostics.push({
    severity: "info",
    code: "ehp-attacker",
    path: "config.enemy.offence",
    message:
      `Effective HP is measured against a level ${attackerLevel} attacker with ` +
      `${offence.accuracy === undefined ? "no accuracy" : `${round(offence.accuracy)} accuracy`}` +
      `${pierces ? " and the penetration on `config.enemy.offence`" : " and no penetration"}. ` +
      `A target preset fills those from \`MobStatUtils\`, which gives a mob accuracy and nothing ` +
      `else; a mob that pierces resists is carrying a map affix, and that is a number to state. ` +
      `Crit and the attacker's damage increases are not in this figure — they scale the hit, not ` +
      `your mitigation.`,
  });

  return { pools, hitSize, attackerLevel, byElement, weakest, diagnostics };
}

/**
 * The attacker's stats, as a sheet the sweep can read.
 *
 * Only what changes *mitigation* goes on it. `total_damage` and the crit pair would inflate the
 * number this divides by and make effective HP fall for a reason that has nothing to do with your
 * defences — they belong to how big the hit is, which is the other half of the question.
 */
function attackerSheet(offence: MobOffence): Sheet {
  const sheet: Sheet = new Map();
  const put = (id: string, value: number | undefined): void => {
    if (value === undefined || value === 0) return;
    sheet.set(id, { value, dmgMulti: 1, hardcap: 0, softcap: 0 });
  };
  put("accuracy", offence.accuracy);
  put("armor_penetration", offence.armorPenetration);
  for (const [guid, value] of Object.entries(offence.penetration ?? {})) {
    put(`${guid}_penetration`, value);
  }
  return sheet;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The chaos bypass, solved.
 *
 * Half of a chaos hit ignores the shield, so surviving `D` raw chaos means the shield absorbs
 * `min(D/2, S)` and health takes the rest. Below `H <= S` the binding constraint is the bypassing
 * half alone, giving `D = 2H`; above it the shield empties first and `D = H + S`. `min` of the two
 * is both arms at once.
 */
function poolFor(guid: string, health: number, shield: number, shieldHolds: boolean): number {
  if (guid !== "chaos" || shieldHolds) return health + shield;
  return Math.min(health + shield, 2 * health);
}

type TakenInput = {
  snapshot: Snapshot;
  index: ReturnType<typeof statIndex>;
  layers: ReturnType<typeof layerIndex>;
  balance: ReturnType<typeof balance>;
  compat: Compat;
  build: BuildDoc;
  sheet: Sheet;
  effects: EngineResult["effects"];
  element: ElementName;
  hitSize: number;
  attackerLevel: number;
  /** The attacker's own sheet — accuracy and penetration, swept from the Source side. */
  attacker: Sheet;
  diagnostics: Diagnostic[];
};

/** One hit of `element`, swept against the character's own sheet. */
function takenFraction(input: TakenInput): { taken: number; steps: LayerStep[] } {
  const recorder = new Recorder();
  const event = new DamageEventState(input.layers, undefined, recorder);
  event.data.setupNumber(EVENT.NUMBER, input.hitSize);
  event.data.setString(EVENT.ELEMENT, input.element);
  event.data.setString(EVENT.ATTACK_TYPE, "hit");
  event.data.setBoolean(EVENT.CRIT, false);

  const ctx: DamageCtx = {
    snapshot: input.snapshot,
    index: input.index,
    balance: input.balance,
    compat: input.compat,
    event,
    source: input.attacker,
    target: input.sheet,
    sourceLevel: input.attackerLevel,
    targetLevel: input.build.character.level,
    spell: undefined,
    spellId: "",
    spellTags: new Set(),
    config: input.build.config ?? {},
    effects: input.effects,
    diagnostics: input.diagnostics,
    report: (severity, code, path, message) =>
      input.diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    // Crit is pinned off: eHP is per unit of raw damage, and a crit changes how big the raw
    // number is rather than how much of it you stop.
    pinnedBooleans: new Set([EVENT.CRIT]),
    disableSourceStats: false,
    sourceIsTarget: false,
  };

  const steps: LayerStep[] = [];
  const moreMultis: MoreStep[] = [];
  sweep(
    ctx,
    [
      { side: "Source", sheet: input.attacker },
      { side: "Target", sheet: input.sheet },
    ],
    steps,
    moreMultis,
  );

  const dealt = Math.max(0, event.damage);
  return { taken: input.hitSize > 0 ? dealt / input.hitSize : 1, steps };
}
