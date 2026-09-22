/**
 * Everything a stat effect or condition needs to answer a question about the hit in flight.
 *
 * The game reaches for a live world here — `event.source`, `event.target`, the player's
 * cooldown map, the time of day. A build planner has none of that, so the context carries the
 * declared substitutes and, importantly, a way to say *"I was asked something I cannot know"*.
 * Every such question ends up in `report`, never silently defaulted.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildConfig, Diagnostic, Severity } from "@cte2/schema";

import type { Balance } from "../balance.js";
import type { EngineStat } from "../calculate.js";
import type { Compat } from "../compat.js";
import type { StatIndex } from "../stat-def.js";
import type { EffectState } from "./effect-state.js";
import type { DamageEventState, EffectSide } from "./event.js";

/** One `proc_spell` block the sweep reached, with the chance its conditions left it at. */
export type ProcHit = {
  /** The stat carrying the proc, for provenance. */
  statId: string;
  /** The spell it casts. */
  spellId: string;
  /** `PositionSource` on the effect: `CASTER` or `TARGET`. */
  position: string;
  /** 0..1 — every `ifs` on the block folded together, `random_roll` included. */
  chance: number;
  /** Which side of the event carried the stat: `Source` is "when you hit", `Target` "when hit". */
  side: EffectSide;
};

/**
 * One `restore_resource` block the sweep reached — a leech, in this pack.
 *
 * `RestoreResourceAction.activate` reads its number off the event and then either pools it
 * (`RestoreType.leech`) or restores it outright. Every one of the ten `restore_resource` effects
 * this pack ships declares `restore_type: "leech"`, so in practice all of them pool — but the
 * type is recorded rather than assumed, because a pack that ships a `heal` one would otherwise
 * be silently counted against the leech cap.
 */
export type RestoreRecord = {
  /** The stat carrying it, for provenance. */
  statId: string;
  effectId: string;
  /** `ResourceType` — which pool it fills. */
  resource: string;
  /** `RestoreType` — `leech` for everything in this pack. */
  restoreType: string;
  /** How much, already weighted by whatever chance the block's `ifs` resolved to. */
  amount: number;
};

/** A resolved stat sheet: what one side of the event brings. */
export type Sheet = Map<string, EngineStat>;

export type DamageCtx = {
  snapshot: Snapshot;
  index: StatIndex;
  balance: Balance;
  compat: Compat;
  event: DamageEventState;
  /** The attacker's sheet — the **spell** unit, with support gems folded in. */
  source: Sheet;
  /** The declared enemy's sheet — or the character's own, on a self-hit. */
  target: Sheet;
  sourceLevel: number;
  targetLevel: number;
  /** `mmorpg_spells` entry being cast, absent for a basic attack. */
  spell: Record<string, unknown> | undefined;
  spellId: string;
  spellTags: ReadonlySet<string>;
  config: BuildConfig;
  /** Which exile effects are up, for the conditions that ask. */
  effects: EffectState;
  /**
   * The exile effect this event is *about* — set only on the `on_exile_effect` sweep.
   *
   * `EventData.EXILE_EFFECT`, in the shape the two conditions that read it need.
   * `EffectHasTagCondition` and `IsEffectCondition` both open with
   * `if (event.data.hasExileEffect())` and return `false` when there is none, so leaving this
   * unset is not a gap — it is what every other event in the game reports, and it is why both
   * conditions resolve to `unknown` on a damage sweep rather than to a guess.
   */
  exileEffect?: { id: string; tags: ReadonlySet<string> };
  /**
   * Where `proc_spell` effects are recorded, when a caller wants them.
   *
   * The damage sweep already walks every stat effect block the character has and hands
   * `applyStatEffect` the probability its `ifs` resolved to — `random_roll` folded in,
   * `spell_has_tag` answered against the skill being cast. That is exactly the number a proc
   * needs, so procs are collected off the sweep rather than re-derived beside it.
   */
  procs?: ProcHit[];
  /**
   * Where `restore_resource` effects are recorded, when a caller wants them.
   *
   * Same reasoning as `procs`: leech is gated on the element that hit, whether the hit was
   * dodged and what attack type it was, and the sweep has already answered all three. Reading
   * the number off the event at priority 32 — after the layers flush at 30, before magic shield
   * and mana absorption at 100 — is what `AFTER_DAMAGE_BONUSES` means, and its comment says so:
   * "for stuff like leech, because we don't want absorbs, mana shields etc to stop leech".
   */
  restores?: RestoreRecord[];
  diagnostics: Diagnostic[];
  report(severity: Severity, code: string, path: string, message: string): void;
  /** Condition ids already reported as unknowable, so each is named once rather than per stat. */
  reportedConditions: Set<string>;
  /** Keys already reported by the effect interpreter, same reason. */
  reportedEffects: Set<string>;
  /**
   * Booleans the caller has decided for this run — `crit` in a branched simulation.
   *
   * A `set_bool` effect targeting a pinned key is skipped. Without this the crit branch would
   * be undone the moment `critical_hit` re-rolled itself at priority 0, and the "crit" figure
   * would silently become the averaged one.
   */
  pinnedBooleans: Set<string>;
  /** Set by `disable_attacker_stats`: the target switches off the source-side sweep. */
  disableSourceStats: boolean;
  /**
   * Whether the caster is also the thing being hit — `source_is_target`.
   *
   * False for every ordinary figure, because a planner is modelling a hit on something else.
   * True for the ten spells that declare a `damage` act against a `self` selector and pay
   * their own health for it: `asura`, `forbidden_rite`, `eighth_gate`. That hit is resolved
   * against the character's own armour and resists, and `no_attacker_stats_on_selfdmg` — which
   * this pack gives every character — switches off the attacker half of it entirely.
   */
  sourceIsTarget: boolean;
  /**
   * Whether `in_combat` is up, when the caller is describing a scenario rather than asking.
   *
   * `in_combat` is a ten-second cooldown re-stamped by every hit landed or taken, so it is not
   * something a build document can be read off — it is answered by `config.conditions` like any
   * other. The regeneration tick is the exception: it is computed for both states deliberately,
   * and that is a decision of the caller's rather than a property of the build.
   */
  inCombat?: boolean;
  /**
   * Whether the **target** has a shield in its offhand — `BlockChance` refuses to fire without one.
   *
   *     if (!(effect.target.getOffhandItem().getItem() instanceof ShieldItem)) { return false; }
   *
   * — `BlockChance$Effect.canActivate`, in `Mine_and_Slash-1.20.1-6.4.13.jar`. A live game asks
   * the entity; a planner has to be told, so this is `undefined` wherever the target is not a
   * character whose gear is known — an enemy, chiefly — and `blockEffect` treats that as "no"
   * rather than as "yes". A gate nothing reads is a gate that always passes, and block passing
   * for a shieldless build is the specific bug this field exists to stop.
   *
   * Refusing costs nothing on the enemy side: no `mmorpg_base_stats` entry in this pack grants a
   * mob `block_chance`, so the effect never runs there at all.
   */
  targetHasShield?: boolean;

  /**
   * Resolve the hit as though every avoidance roll failed.
   *
   * Dodge and block are rolls, and the pipeline folds them in as *expectation* — `dodgeEffect`
   * multiplies the block layer by `1 - chance` rather than zeroing the hit, because a figure
   * averaged over many hits is the only form a DPS or effective-HP number can use. That is the
   * right answer to "how much damage do I take over a fight" and the wrong one to "what is the
   * largest single hit I survive": you cannot spend a 40% dodge chance on the hit that kills you.
   *
   * With this set, `canAvoidHit` is false and the two rolls do nothing, so the sweep reports
   * mitigation alone — armour, the resists, flat reduction, `dmg_received`. It is the same door
   * a self-hit already goes through, and it exists for `Defence.maximumHit`.
   */
  noAvoidance?: boolean;
};

export function sheetValue(sheet: Sheet, statId: string): number {
  return sheet.get(statId)?.value ?? 0;
}

export function sheetOf(ctx: DamageCtx, side: EffectSide): Sheet {
  return side === "Source" ? ctx.source : ctx.target;
}

export function levelOf(ctx: DamageCtx, side: EffectSide): number {
  return side === "Source" ? ctx.sourceLevel : ctx.targetLevel;
}
