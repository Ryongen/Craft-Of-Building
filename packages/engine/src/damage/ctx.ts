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
