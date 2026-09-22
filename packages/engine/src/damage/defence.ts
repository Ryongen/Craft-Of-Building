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
 * Not a bare zero any more. `config.enemy.offence` carries what the mob hits with, and everything
 * on it that changes *mitigation* is swept from the Source side exactly as a player's would be:
 * accuracy, which is subtracted from your dodge and your spell dodge, and penetration, which is
 * taken off armour and off the raw resist before its clamp.
 *
 * `buildTargetEnemy` fills it the way the Training Dummy's presets do — except that the dummy
 * pins no numbers at all and lets Mine and Slash build the block, which is exactly the thing this
 * file could not do and therefore got wrong. A mob's offence is **two** sources, not one:
 * `MobStatUtils.getMobBaseStats` scales 1 accuracy to its level, and the pack's
 * `mmorpg_base_stats/mob` — which `CommonStatUtils.addBaseStats` gives every non-player entity —
 * adds 8 more accuracy and 6 armour penetration on the same curve. Reading only the first made
 * every mob nine times less accurate and infinitely less penetrating than the game's.
 *
 * Its **affixes** reach this sheet too; see {@link attackerAffixes} for which of them do and why
 * the damage increases deliberately do not.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, Diagnostic, ElementName, MobOffence, Severity } from "@cte2/schema";
import { SINGLE_ELEMENTS, baseGearType, isTwoHanded } from "@cte2/schema";

import { balance } from "../balance.js";
import { resolveEffects, type EngineOptions, type EngineResult } from "../calculate.js";
import { ORIGINAL_MODE, type Compat } from "../compat.js";
import { statIndex } from "../stat-def.js";
import type { DamageCtx, Sheet } from "./ctx.js";
import { EVENT, DamageEventState } from "./event.js";
import { layerIndex } from "./layers.js";
import { Recorder, type LayerStep, type MoreStep } from "./breakdown.js";
import { mobAffixMods } from "./mob-affixes.js";
import { aggregateSpread, applySheetMods, sweep, type TargetMod } from "./simulate.js";

/** The character's pools, as the game keeps them. */
export type Pools = {
  /** `health` — the Mine and Slash pool, not vanilla hearts. */
  health: number;
  /** `magic_shield`, which absorbs before health. */
  magicShield: number;
  /**
   * `mana_shield`: the percent of each post-mitigation hit mana takes, and how much
   * mana is available to take it (half the maximum — the stat stops at that floor).
   */
  manaAbsorb: { percent: number; buffer: number };
};

export type ElementDefence = {
  element: ElementName;
  /** Fraction of a raw incoming hit that reaches the pools. 1 means nothing stopped it. */
  taken: number;
  /**
   * The same fraction with every avoidance roll assumed to fail.
   *
   * `taken` has dodge and block folded in as expectation — `1 - chance` on the block layer, and
   * `50 × chance` off the suppression layer — which is the only form an *average* can take. This
   * is the other question: mitigation alone, no rolls. Always `>= taken`, and equal to it for a
   * character with neither stat.
   */
  takenUnavoided: number;
  /** The pool this element actually has to chew through, after the chaos bypass. */
  pool: number;
  /** Raw incoming damage survivable on average: `pool / taken`. */
  effectiveHealth: number;
  /**
   * The largest single hit that does not kill you: `pool / takenUnavoided`.
   *
   * The number a one-shot is measured against, and it is deliberately not effective HP. A 40%
   * dodge chance makes you take 40% less damage *over a fight* and does nothing whatsoever about
   * the hit that lands — so a build can have a comfortable effective HP and be one unlucky
   * boss slam from dead, and the gap between these two figures is exactly that risk.
   */
  maximumHit: number;
  /** Layer by layer, so a number on screen can be taken apart. */
  steps: LayerStep[];
  /** The same, with the avoidance rolls off — what `maximumHit` was measured through. */
  unavoidedSteps: LayerStep[];
  /**
   * What the hit turned out to be made of by the time it reached the pools.
   *
   * Shares of {@link taken}, summing to 1, biggest first. For most builds against most mobs it
   * is one entry at 100% and says nothing; it exists for the case where it is not, which the
   * rest of this tab could not previously express at all.
   *
   * **The row is named for what the attacker swings, not for what lands.** A mob carrying Fire
   * Lord has `phys_to_fire 75` and `plus_phys_to_fire 50`, so a raw physical hit arrives as a
   * quarter physical and the rest fire — and *this row is still the physical one*, because the
   * question it answers is "how much raw physical damage do I survive". The Fire row is a hit
   * that started as fire, which Fire Lord does not touch and therefore does not change. That is
   * the right model and it reads as a bug without something on screen saying what the physical
   * row is actually being hit by, which is this.
   *
   * Post-mitigation rather than pre, because it is read to decide what to buy: fire that your
   * capped fire resistance has already eaten is not the part of the hit worth spending on.
   */
  arrivesAs: { element: ElementName; share: number }[];
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
  /**
   * The element with the lowest maximum hit: what one-shots you first.
   *
   * Usually the same element as `weakest` and not always — avoidance is physical-only (dodge)
   * or element-blind (block), so a character whose dodge is carrying their physical effective HP
   * is softer to a single physical slam than the averaged figure suggests.
   */
  mostFragile: ElementDefence;
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
  // `DamageAbsorbedByMana.GUID` is `mana_shield` — the class name is not the stat id, and
  // there has never been a stat called `damage_absorbed_by_mana`. Reading that name returned
  // `undefined` on every real sheet, so the buffer below and its diagnostic never once fired,
  // including for a build wearing the Mana Battery keystone. Confirmed against the static
  // initialiser in `Mine_and_Slash-1.20.1-6.4.13.jar`; `code-only-stats.generated.ts` had it
  // right all along.
  const manaPercent = sheet.get("mana_shield")?.value ?? 0;
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

  const hasShield = wearsShield(build, snapshot);

  const offence = build.config?.enemy?.offence ?? {};
  const attacker = attackerSheet(offence);
  const carried = attackerAffixes(build, snapshot, index, bal, attackerLevel, attacker, diagnostics);

  const byElement = SINGLE_ELEMENTS.map((element) => {
    const input = {
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
      hasShield,
    };

    const { taken, steps, arrivesAs } = takenFraction(input);
    // Two sweeps per element rather than one, because the two questions have different answers
    // and neither can be derived from the other: the avoidance layers sit in the middle of the
    // chain, so their contribution is not a factor that can be divided back out afterwards.
    // Ten sweeps of fourteen layers is a fraction of a millisecond.
    const unavoided = takenFraction({ ...input, noAvoidance: true, diagnostics: [] });

    const pool = poolFor(element.guid, health, magicShield, shieldHolds);
    return {
      element: element.name,
      taken,
      takenUnavoided: unavoided.taken,
      pool,
      effectiveHealth: taken > 0 ? pool / taken : Number.POSITIVE_INFINITY,
      maximumHit: unavoided.taken > 0 ? pool / unavoided.taken : Number.POSITIVE_INFINITY,
      steps,
      unavoidedSteps: unavoided.steps,
      arrivesAs,
    };
  });

  const weakest = byElement.reduce((worst, entry) =>
    entry.effectiveHealth < worst.effectiveHealth ? entry : worst,
  );
  const mostFragile = byElement.reduce((worst, entry) =>
    entry.maximumHit < worst.maximumHit ? entry : worst,
  );

  if (pools.manaAbsorb.percent > 0) {
    diagnostics.push({
      severity: "info",
      code: "mana-absorb-not-in-ehp",
      path: "config",
      message:
        `\`mana_shield\` sends ${pools.manaAbsorb.percent.toFixed(1)}% of every hit to ` +
        `mana, but only while mana is above half its maximum — a buffer of ` +
        `${Math.round(pools.manaAbsorb.buffer)}, not a pool. How full that buffer is when a hit ` +
        `lands depends on regeneration between hits, which nothing in a build document states, so ` +
        `it is reported beside the effective HP rather than added to it.`,
    });
  }

  const blockChance = sheet.get("block_chance")?.value ?? 0;
  if (blockChance > 0 && !hasShield) {
    diagnostics.push({
      severity: "info",
      code: "block-needs-shield",
      path: "gear",
      message:
        `\`block_chance\` is ${blockChance.toFixed(1)}%, but \`BlockChance\` refuses to fire ` +
        `without a shield in the offhand — \`canActivate\` tests the offhand stack with ` +
        `\`instanceof ShieldItem\`, and this build has none. The chance is on the sheet and stops ` +
        `nothing, so it is left out of the figures below rather than quietly counted.`,
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
      `${pierces ? " and the penetration on `config.enemy.offence`" : " and no penetration"}` +
      `${carried.applied.length === 0 ? "" : `, carrying ${carried.applied.join(", ")} from its affixes`}. ` +
      `A target preset fills those from \`MobStatUtils\` and the pack's \`mmorpg_base_stats/mob\`, ` +
      `which between them give a mob accuracy, armour penetration and nothing else. ` +
      `Crit and the attacker's damage increases are not in this figure — they scale the hit, not ` +
      `your mitigation.` +
      `${carried.withheld.length === 0 ? "" : ` Its ${carried.withheld.join(", ")} is real and is left out here for that reason; the Damage tab is where it shows.`}`,
  });

  return { pools, hitSize, attackerLevel, byElement, weakest, mostFragile, diagnostics };
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

/**
 * The mob's own affixes, folded onto the sheet it hits you with.
 *
 * `config.enemy.affixes` already described the target when *you* attack it; this is the other
 * direction, and it was missing entirely — an enemy could carry Fire Lord and every effective-HP
 * figure would be the same as against a bare mob. It should not be: `fire_lord` is
 * `phys_to_fire 75` and `plus_phys_to_fire 50`, so three quarters of its physical hit arrives as
 * fire and half again on top of that, and which of your resists is doing the work changes
 * completely.
 *
 * ## What is let through, and what is held back
 *
 * The rule is the one `attackerSheet` already states: a stat that changes **what the hit is made
 * of, or what it walks through** belongs here; a stat that only changes **how big it is** does
 * not, because effective HP is measured per unit of raw incoming damage and scaling the hit
 * would answer a different question twice.
 *
 * So conversion, gain-as-extra, accuracy and every penetration are applied. `total_damage`,
 * `all_<element>_damage` and `critical_hit` are not, and are named in a diagnostic rather than
 * dropped silently — a mob carrying `savage` really does hit harder, and the place that says so
 * is the damage figure, not this one.
 */
function attackerAffixes(
  build: BuildDoc,
  snapshot: Snapshot,
  index: ReturnType<typeof statIndex>,
  bal: ReturnType<typeof balance>,
  mobLevel: number,
  sheet: Sheet,
  diagnostics: Diagnostic[],
): { applied: string[]; withheld: string[] } {
  const affixIds = build.config?.enemy?.affixes ?? [];
  if (affixIds.length === 0) return { applied: [], withheld: [] };

  const report = (severity: Severity, code: string, path: string, message: string): void => {
    diagnostics.push({ severity, code, path, message });
  };

  const applied: string[] = [];
  const withheld: string[] = [];
  const mods: TargetMod[] = [];

  for (const mod of mobAffixMods(snapshot, index, bal, mobLevel, affixIds, report)) {
    if (!shapesTheHit(mod.statId)) {
      if (sizesTheHit(mod.statId) && !withheld.includes(mod.statId)) withheld.push(mod.statId);
      continue;
    }
    // Reported under the affix's own stat id and *applied* to whatever that id spreads to.
    // `penetrating` grants `elemental_penetration`, which no layer reads: the layers are per
    // single element, and the aggregate only reaches them through `ITransferToOtherStats` — a
    // pass this hand-built sheet never runs. Without the spread the affix moved your physical
    // and chaos figures (`armor_penetration` and `chaos_penetration` are real ids) and left fire,
    // cold and lightning untouched, which is not a mob that penetrates elements at all.
    if (!applied.includes(mod.statId)) applied.push(mod.statId);
    for (const statId of aggregateSpread(mod.statId)) {
      mods.push({ ...mod, statId, path: "config.enemy.affixes" });
    }
  }

  applySheetMods(sheet, mods, index, report);
  return { applied, withheld };
}

/**
 * Conversion, gain-as-extra, accuracy and penetration — the four families that decide which of
 * your layers a hit meets.
 *
 * Matched by shape rather than listed, so an affix a pack adds with a new element lands without
 * an edit here: `phys_to_<element>`, `plus_phys_to_<element>`, `<element>_penetration`.
 */
function shapesTheHit(statId: string): boolean {
  return (
    statId === "accuracy" ||
    statId === "armor_penetration" ||
    statId.endsWith("_penetration") ||
    statId.startsWith("phys_to_") ||
    statId.startsWith("plus_phys_to_") ||
    statId.startsWith("ele_to_")
  );
}

/** Pure multipliers on the hit's size — real, and deliberately not in effective HP. */
function sizesTheHit(statId: string): boolean {
  return (
    statId === "total_damage" ||
    statId === "critical_hit" ||
    statId === "critical_damage" ||
    /^all_\w+_damage$/.test(statId)
  );
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

/**
 * Whether the character has a shield in the offhand — `BlockChance`'s hardest gate.
 *
 *     if (!(effect.target.getOffhandItem().getItem() instanceof ShieldItem)) { return false; }
 *
 * The check is on the item class, which a build document does not carry, so the base's `shield`
 * tag stands in for it. Across the pack's three `offhand_family` bases that is exact rather than
 * approximate: `RoE_Weapons-0.1.7.jar` declares `Shield0Item extends ShieldItem`, while
 * `Tome0Item` and `Totem0Item` both extend plain `Item`. A tome grants magic shield and a totem
 * grants dodge; neither lets you block, and neither is a `ShieldItem`.
 *
 * A two-handed weapon empties the offhand outright — Better Combat returns `ItemStack.EMPTY`
 * for the slot, so `GearData` reads no offhand at all — which means a greatsword build holding
 * a shield blocks nothing. {@link isTwoHanded} is the same test `validate.ts` warns on.
 */
function wearsShield(build: BuildDoc, snapshot: Snapshot): boolean {
  const gear = build.gear ?? [];
  if (gear.some((item) => isTwoHanded(snapshot, item.base))) return false;
  return gear.some((item) => baseGearType(snapshot, item.base)?.tags.includes("shield") ?? false);
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
  /** Assume every avoidance roll failed — see `DamageCtx.noAvoidance`. */
  noAvoidance?: boolean;
  /** Whether a shield is in the offhand — see `DamageCtx.targetHasShield`. */
  hasShield: boolean;
};

/**
 * One hit of `element`, swept against the character's own sheet.
 *
 * ## Converted damage is followed, not dropped
 *
 * `event.damage` is `EventData.NUMBER` alone, and both conversion paths *remove* their share
 * from it: `PhysicalDamageTakenAs` on your own sheet, and an attacker's `phys_to_fire`, each
 * subtract what they moved and park it on `event.bonusElements` as a child event. Reading
 * `NUMBER` on its own therefore counted converted damage as damage that never arrived, and a
 * character with `phys_taken_as_fire` and no fire resistance at all read as though half the hit
 * had been prevented rather than merely relabelled.
 *
 * So each child is swept in turn, at its own element and against its own mitigation layers,
 * exactly as `collectBonusElements` does on the offensive side. The two differences are the
 * ones the game makes: a `damage_taken_as` child sets `disableSourceStats`, because it was
 * built with `calcSourceEffects = false` and must not sweep the attacker a second time, and the
 * depth carries so `MAX_CONVERSION_DEPTH` still stops a phys→fire→phys pair from looping.
 */
function takenFraction(
  input: TakenInput,
): { taken: number; steps: LayerStep[]; arrivesAs: { element: ElementName; share: number }[] } {
  const landed = new Map<ElementName, number>();
  const { dealt, steps } = sweepOnce(input, input.element, input.hitSize, 0, false, landed);

  const total = [...landed.values()].reduce((sum, n) => sum + n, 0);
  const arrivesAs =
    total <= 0
      ? []
      : [...landed.entries()]
          .filter(([, value]) => value > 0)
          .map(([element, value]) => ({ element, share: value / total }))
          .sort((a, b) => b.share - a.share);

  return { taken: input.hitSize > 0 ? dealt / input.hitSize : 1, steps, arrivesAs };
}

/** One event and every child it spawns, summed. */
function sweepOnce(
  input: TakenInput,
  element: ElementName,
  amount: number,
  depth: number,
  takenAs: boolean,
  /**
   * Where each node's own contribution is tallied, by the element it arrived as.
   *
   * A map threaded down rather than merged back up, because the recursion already sums `dealt`
   * and a second accumulator returned alongside it would be two things to keep in step.
   */
  landed: Map<ElementName, number>,
): { dealt: number; steps: LayerStep[] } {
  const recorder = new Recorder();
  const event = new DamageEventState(input.layers, undefined, recorder);
  event.conversionDepth = depth;
  event.data.setupNumber(EVENT.NUMBER, amount);
  event.data.setString(EVENT.ELEMENT, element);
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
    // A `damage_taken_as` child is built with `calcSourceEffects = false`, so the attacker must
    // not be swept onto it a second time. A conversion child is not, and is.
    disableSourceStats: takenAs,
    sourceIsTarget: false,
    // The character is the target of every sweep in this file, so their own offhand answers
    // `BlockChance`'s shield gate.
    targetHasShield: input.hasShield,
    ...(input.noAvoidance === true ? { noAvoidance: true } : {}),
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

  let dealt = Math.max(0, event.damage);
  landed.set(element, (landed.get(element) ?? 0) + dealt);

  // Everything conversion moved off `NUMBER`, followed to where it landed. The child's steps
  // are deliberately not merged into `steps`: the layer trace on screen is a reading of one
  // element's chain, and interleaving a second element's would make the column stop adding up.
  for (const bonus of event.bonusElements) {
    if (bonus.amount <= 0) continue;
    dealt += sweepOnce(input, bonus.element, bonus.amount, depth + 1, bonus.takenAs, landed).dealt;
  }

  return { dealt, steps };
}
