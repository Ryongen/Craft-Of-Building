/**
 * Spells your gear casts for you.
 *
 * 99 stats in this pack carry a `proc_spell` effect: "15% chance to cast Armageddon on hit",
 * "cast Chain Lightning when you crit", "Blood Explosion on kill". They are a real and
 * sometimes dominant share of a build's damage, and nothing was counting them.
 *
 * ## Why the chance is not computed here
 *
 * Every proc is gated, and the gates are the interesting part:
 *
 *     proc_armageddon_on_attack_hit
 *       ifs: is_is_dodged_true_is_false, random_roll, style_is_int_is_false,
 *            is_hit_or_bonus, is_armageddon_not_on_cd
 *
 * — a roll, a check that the hit landed, a check that the skill is not a spell, and a cooldown.
 * `spell_has_tag_ricochet_shot` on another one restricts it to a single skill; a dozen more use
 * `spell_has_tag_not_X` to stop a spell procing itself.
 *
 * All of that is already ported, in `conditions.ts`, and already runs: the damage sweep
 * evaluates each block's `ifs` into a weight before handing it to `applyStatEffect`. So the
 * chance a proc fires *on this skill's hit* falls out of the existing pass, and this file never
 * re-derives it. `effects.ts` records the block, `simulate.ts` returns the list, and the work
 * here is the two things the sweep cannot know: how often the trigger happens, and what the
 * procced spell does when it lands.
 *
 * ## The rate
 *
 * A proc on hit fires at `hits per second × chance`, and is then capped:
 *
 *     DEFAULT_PROC_COOLDOWN_TICKS = 20
 *
 * `SpellConfiguration.proc_cooldown_ticks` is declared by 429 spells, and the
 * `is_<spell>_not_on_cd` condition on almost every proc block is what enforces it. A proc whose
 * spell has a one-second cooldown cannot fire more than once a second however fast you attack,
 * which is what stops a fast skill from turning a 5% proc into the whole build.
 *
 * Hits per second is this skill's own — every source's landed hits over the cast cycle, which
 * `dps.ts` has already counted. That makes a proc's rate a function of the skill you are
 * measuring, which is correct and is why the same gear procs differently under a channel than
 * under a slow slam.
 *
 * ## Listing what cannot fire
 *
 * The sweep only reaches a block whose conditions left it above zero, so a proc that *cannot*
 * trigger on this skill never arrives — and "no procs" is indistinguishable from "no proc gear".
 * Those are different answers, and the second one is the one a player wants when they are
 * choosing a skill. So the sheet is scanned separately for every stat carrying a `proc_spell`,
 * and anything the sweep did not reach is listed at zero with the reason read off its own `ifs`:
 * a basic-attack-only proc, a defensive one, a kill one, or a `spell_has_tag` this skill fails.
 *
 * ## What is not modelled
 *
 * `on_mob_kill` and `on_death` procs have no rate a single-target figure can give them: they
 * fire when something dies, and how often that is depends on the pack, not the build. They are
 * listed with a rate of 0 and a reason, not dropped.
 *
 * A `when_hit` proc — the `Target`-side blocks, "when you are hit, cast X" — is defensive, and
 * how often you are hit is not a property of your build either. Same treatment.
 *
 * Procs of procs are not followed. The procced spell's own DPS is computed with its procs off,
 * which stops a two-spell cycle from recursing and costs nothing real: nothing in the pack
 * procs a spell that procs back.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, Diagnostic } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";

import type { ProcHit } from "./ctx.js";
import type { EffectState } from "./effect-state.js";
import { DEFAULT_PROC_COOLDOWN_TICKS, TICKS_PER_SECOND } from "./spell-calc.js";

/** How many distinct procs are resolved for a build, so a pathological sheet cannot stall a UI. */
const MAX_PROCS = 24;

const EMPTY: ReadonlySet<string> = new Set();

/** Why a proc contributes nothing, when it does not. */
export type ProcLimit =
  /**
   * The spell it casts is on your bar with **enabled** unticked.
   *
   * The one limit that is a decision rather than a derivation, and it wins over all of them: a
   * player who switched a skill off on the Skills tab has said they do not want it in any
   * figure, and a proc is the one way a switched-off skill could still have reached one.
   */
  | "disabled"
  /** Fires on a kill, and how often something dies is not a property of the build. */
  | "on-kill"
  /**
   * Fires when you are hit, blocked or dodged, and the document has not said how often that is.
   *
   * Not "no rate exists" any more: `config.enemy.offence` states the enemy's hit and its clock,
   * and `defence.ts` derives the rate from them. A proc gated on the block or the dodge is
   * thinned by that chance on top, because it fires on the branch that happened rather than on
   * an expectation over the whole hit.
   *
   * So this now means the narrower and more useful thing — *you have not described an attacker*
   * — and names the two fields that would answer it.
   */
  | "when-hit"
  /**
   * Only a weapon swing triggers it, so it has no rate on a *cast*.
   *
   * Not "unmodelled" any more: `basic-attack.ts` gives the same proc a real rate off the same
   * sweep, on the swing's own clock. This says the figure you are reading is the wrong one to
   * look for it in, which is a different and more useful thing than zero.
   */
  | "basic-attack"
  /** The mirror: a cast triggers it and a swing does not, so it is 0 on the basic-attack figure. */
  | "spell-only"
  /** A `spell_has_tag` gate this skill fails: the proc belongs to a different skill. */
  | "wrong-skill"
  /** The procced spell produced no damage of its own. */
  | "no-damage"
  /** Its conditions did not hold for this hit, for a reason not worth its own name. */
  | "cannot-trigger";

export type Proc = {
  /** The stat that carries it. */
  statId: string;
  spellId: string;
  /** 0..1, per triggering hit. Every `ifs` on the block folded together. */
  chance: number;
  /** `proc_cooldown_ticks` on the procced spell — the ceiling on how often it can go off. */
  cooldownTicks: number;
  /** Triggering events per second before the chance and the cooldown are applied. */
  triggersPerSecond: number;
  /** What it actually fires at: `min(triggers × chance, 1 / cooldown)`. */
  perSecond: number;
  /** Damage one proc puts on the target. */
  damagePerProc: number;
  /** `damagePerProc × perSecond`. */
  dps: number;
  /** Set when the figure is 0 for a reason worth showing. */
  limit?: ProcLimit;
  /** The gate that stopped it, when `limit` is `wrong-skill`. */
  needsTag?: string;
};

export type ProcInput = {
  snapshot: Snapshot;
  build: BuildDoc;
  effects: EffectState;
  /** Every `proc_spell` block the non-crit sweep reached. */
  onHit: readonly ProcHit[];
  /** The same from the crit sweep, so a `is_crit_true` proc is not invisible. */
  onCrit: readonly ProcHit[];
  critChance: number;
  /** Hits this skill lands per second, across every damage source. */
  hitsPerSecond: number;
  /**
   * Hits the *enemy* lands on you per second, when the document states an attacker.
   *
   * The rate a `Target`-side proc has always been missing. `defence.ts` derives it from
   * `config.enemy.offence`; `undefined` means no attacker is stated, which is the state every
   * existing document is in, and every defensive proc then keeps its `when-hit` limit.
   */
  incomingPerSecond?: number;

  /** The character sheet, to find proc stats the sweep could not reach. */
  sheet: ReadonlyMap<string, { value: number }>;
  /** The tags of the skill being measured, for the `spell_has_tag` gates. */
  spellTags: ReadonlySet<string>;
  /**
   * Spells the document has on the bar with `enabled` off.
   *
   * A procced spell is resolved by id rather than through the skill list, so nothing else in
   * this pipeline would have noticed the switch — the proc would keep paying out from a skill
   * the player had turned off.
   */
  disabledSpells?: ReadonlySet<string>;
  /** Resolves a procced spell's damage per cast. Injected to keep this file free of `dps.ts`. */
  damageOf: (spellId: string) => number;
  diagnostics: Diagnostic[];
};

/**
 * Every proc this build can fire while casting this skill, with its rate and its damage.
 *
 * The two sweeps are blended by crit chance the same way the hit is: a proc gated on
 * `is_crit_true` resolves to 0 in the non-crit branch and its roll in the crit one, so the
 * honest per-hit chance is the weighted mix rather than either branch alone.
 */
export function resolveProcs(input: ProcInput): Proc[] {
  const blended = blend(input.onHit, input.onCrit, input.critChance);
  // Everything the build carries, so a proc the sweep never reached is still named. The sweep's
  // answer wins wherever the two overlap: it is the ported condition pass, this is a scan.
  for (const candidate of candidates(input.snapshot, input.sheet)) {
    const key = `${candidate.statId}:${candidate.spellId}`;
    if (!blended.has(key)) blended.set(key, { ...candidate, chance: 0 });
  }

  const out: Proc[] = [];

  for (const hit of [...blended.values()].sort((a, b) => b.chance - a.chance).slice(0, MAX_PROCS)) {
    const cooldownTicks = procCooldownOf(input.snapshot, hit.spellId);
    const capPerSecond = TICKS_PER_SECOND / Math.max(1, cooldownTicks);
    const limit = limitOf(hit, input.spellTags, input.disabledSpells ?? EMPTY, input.incomingPerSecond);

    const triggersPerSecond = limit === undefined ? triggerRateOf(hit, input) : 0;
    const perSecond = Math.min(triggersPerSecond * hit.chance, capPerSecond);
    const damagePerProc = perSecond > 0 ? input.damageOf(hit.spellId) : 0;

    out.push({
      statId: hit.statId,
      spellId: hit.spellId,
      chance: hit.chance,
      cooldownTicks,
      triggersPerSecond,
      perSecond,
      damagePerProc,
      dps: damagePerProc * perSecond,
      ...(limit === undefined
        ? damagePerProc <= 0 && perSecond > 0
          ? { limit: "no-damage" as const }
          : {}
        : { limit }),
      ...(limit === "wrong-skill" && hit.needsTag !== undefined ? { needsTag: hit.needsTag } : {}),
    });
  }

  out.sort((a, b) => b.dps - a.dps);
  for (const proc of out) {
    if (proc.limit !== "on-kill" && proc.limit !== "when-hit") continue;
    input.diagnostics.push({
      severity: "info",
      code: "proc-rate-unknown",
      path: "skills",
      message:
        proc.limit === "on-kill"
          ? `\`${proc.statId}\` casts \`${proc.spellId}\` on a kill, and how often something dies ` +
            `depends on the pack rather than on the build. It is listed and not counted.`
          : `\`${proc.statId}\` casts \`${proc.spellId}\` when you are hit, and this build does not ` +
            `say how often that is. State the enemy's attack damage and how often it swings on ` +
            `the Config tab — an attacker profile fills both — and this gets a real rate. It is ` +
            `listed and not counted until then.`,
    });
  }
  return out;
}

/** The total a rotation's procs add, for the headline. */
export function procDps(procs: readonly Proc[]): number {
  return procs.reduce((sum, proc) => sum + proc.dps, 0);
}

/**
 * How one skill's presses land inside a pass of the rotation.
 *
 * `Proc.triggersPerSecond` is measured against that skill's *own* cycle — the rate you would see
 * spamming nothing else — so it cannot be summed across a rotation directly. `cycleSeconds`
 * converts it back to triggers per press, and `presses` says how many presses one pass buys.
 */
export type RotationPresses = {
  procs: readonly Proc[];
  /** The cycle `triggersPerSecond` was measured over. */
  cycleSeconds: number;
  /** Presses of this skill in one pass. 1 for a rotation step, a fraction for an upkeep buff. */
  presses: number;
};

/**
 * Every proc the whole rotation fires, merged across the skills that trigger it.
 *
 * Merging rather than summing is the point, and `proc_cooldown_ticks` is why. Two skills that
 * each proc Armageddon at 1/s do not proc it twice a second if Armageddon may only go off once
 * a second — the cooldown is one ceiling over the build, not one per skill, so it has to be
 * applied to the combined trigger rate and never to each skill's own.
 *
 * The chance is weighted by triggers rather than averaged. A `spell_has_tag` gate makes the same
 * stat a 25% proc on one skill and a dead one on another, and the honest per-trigger chance is
 * the mix the rotation actually produces — which is the fast skill's chance when the fast skill
 * is doing the triggering.
 *
 * A limit survives only when *every* skill in the pass is limited: one skill that can trigger a
 * proc is enough to make it a real contributor, and reporting it as "only basic attacks trigger
 * it" because the other three cannot would be false.
 */
export function rotationProcs(
  entries: readonly RotationPresses[],
  rotationSeconds: number,
): Proc[] {
  type Acc = {
    statId: string;
    spellId: string;
    cooldownTicks: number;
    triggersPerPass: number;
    /** Σ (triggers × chance), so the merged chance is a trigger-weighted mean. */
    weighted: number;
    /** The chance to show when nothing triggered it at all, so a limited row is not blank. */
    bestChance: number;
    damagePerProc: number;
    limits: (ProcLimit | undefined)[];
    needsTag?: string;
  };

  const merged = new Map<string, Acc>();

  for (const entry of entries) {
    for (const proc of entry.procs) {
      const key = `${proc.statId}:${proc.spellId}`;
      let acc = merged.get(key);
      if (acc === undefined) {
        acc = {
          statId: proc.statId,
          spellId: proc.spellId,
          cooldownTicks: proc.cooldownTicks,
          triggersPerPass: 0,
          weighted: 0,
          bestChance: 0,
          damagePerProc: 0,
          limits: [],
        };
        merged.set(key, acc);
      }
      const triggers = proc.triggersPerSecond * entry.cycleSeconds * entry.presses;
      acc.triggersPerPass += triggers;
      acc.weighted += triggers * proc.chance;
      acc.bestChance = Math.max(acc.bestChance, proc.chance);
      // The same spell cast by the same build, so the skills that resolved it agree; the ones
      // that could not trigger it report 0 and must not drag the figure down.
      acc.damagePerProc = Math.max(acc.damagePerProc, proc.damagePerProc);
      acc.limits.push(proc.limit);
      if (acc.needsTag === undefined && proc.needsTag !== undefined) acc.needsTag = proc.needsTag;
    }
  }

  const out: Proc[] = [];
  for (const acc of merged.values()) {
    const triggersPerSecond = rotationSeconds > 0 ? acc.triggersPerPass / rotationSeconds : 0;
    const chance = acc.triggersPerPass > 0 ? acc.weighted / acc.triggersPerPass : acc.bestChance;
    const capPerSecond = TICKS_PER_SECOND / Math.max(1, acc.cooldownTicks);
    const perSecond = Math.min(triggersPerSecond * chance, capPerSecond);
    const limit = acc.limits.some((l) => l === undefined) ? undefined : worstLimit(acc.limits);

    out.push({
      statId: acc.statId,
      spellId: acc.spellId,
      chance,
      cooldownTicks: acc.cooldownTicks,
      triggersPerSecond,
      perSecond: limit === undefined ? perSecond : 0,
      damagePerProc: acc.damagePerProc,
      dps: limit === undefined ? acc.damagePerProc * perSecond : 0,
      ...(limit === undefined ? {} : { limit }),
      ...(limit === "wrong-skill" && acc.needsTag !== undefined ? { needsTag: acc.needsTag } : {}),
    });
  }

  out.sort((a, b) => b.dps - a.dps);
  return out;
}

/**
 * Which reason to show when several skills each had one.
 *
 * Ordered by how much it tells the reader: a switch they flipped beats a gate they did not know
 * about, and both beat "its conditions did not hold".
 */
const LIMIT_ORDER: ProcLimit[] = [
  "disabled",
  "wrong-skill",
  "basic-attack",
  "spell-only",
  "when-hit",
  "on-kill",
  "no-damage",
  "cannot-trigger",
];

function worstLimit(limits: readonly (ProcLimit | undefined)[]): ProcLimit {
  for (const candidate of LIMIT_ORDER) {
    if (limits.includes(candidate)) return candidate;
  }
  return "cannot-trigger";
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Blended = {
  statId: string;
  spellId: string;
  /** `Source` is "when you hit", `Target` "when you are hit". */
  side: string;
  /** `on_damage`, `on_mob_kill`, `on_death`. */
  events: readonly string[];
  /** The condition ids on the block, for naming what stopped it. */
  ifs: readonly string[];
  /** A positive `spell_has_tag_<tag>` gate, when the block has one. */
  needsTag?: string;
  chance: number;
};

/**
 * One entry per (stat, spell), with the two branches weighted by crit chance.
 *
 * Keyed on both because one stat can proc two spells and two stats can proc the same one —
 * `proc_blood_explosion_on_crit` and `proc_blood_explosion_bleed` are different gear doing the
 * same thing, and they share a cooldown but not a chance.
 */
function blend(
  onHit: readonly ProcHit[],
  onCrit: readonly ProcHit[],
  critChance: number,
): Map<string, Blended> {
  const out = new Map<string, Blended>();
  const fold = (hits: readonly ProcHit[], weight: number): void => {
    for (const hit of hits) {
      const key = `${hit.statId}:${hit.spellId}`;
      const existing = out.get(key);
      if (existing) existing.chance += hit.chance * weight;
      else {
        out.set(key, {
          statId: hit.statId,
          spellId: hit.spellId,
          side: hit.side,
          events: [],
          ifs: [],
          chance: hit.chance * weight,
        });
      }
    }
  };
  fold(onHit, 1 - critChance);
  fold(onCrit, critChance);
  return out;
}

/**
 * Why a proc contributes nothing, read off its own block.
 *
 * Order matters: a defensive proc is defensive whatever else is true of it, and a proc that
 * belongs to another skill is more usefully reported as such than as "conditions failed".
 */
function limitOf(
  hit: Blended,
  spellTags: ReadonlySet<string>,
  disabledSpells: ReadonlySet<string>,
  /** Undefined when no attacker is stated, which is what keeps `when-hit` meaning something. */
  incomingPerSecond: number | undefined,
): ProcLimit | undefined {
  // The player's own switch, so it is asked before anything derived.
  if (disabledSpells.has(hit.spellId)) return "disabled";
  // Deliberately still `when-hit` even with an attacker stated, and asked *before* the plain
  // `Target`-side case below, because one of these is a `Target`-side proc too.
  //
  // A proc gated on the block or the dodge fires on the branch that *happened*, so its rate is
  // the incoming rate times that chance alone — and block, dodge and spell dodge are not
  // separable from the outside: the sweep folds all three into one avoidance outcome, and
  // splitting them would mean re-deriving the `DodgeRating` and `SpellDodgeEffect` curves here,
  // against this file's whole premise that it never re-derives what the sweep already answered.
  // Reported with its reason rather than given a rate that would silently be the wrong one.
  if (hit.ifs.includes("is_is_blocked_true") || hit.ifs.includes("is_is_dodged_true")) {
    return "when-hit";
  }
  // A `Target`-side block is one the *enemy's* hit on you triggers — which now has a rate, when
  // the document says how often that happens.
  if (hit.side === "Target") return incomingPerSecond === undefined ? "when-hit" : undefined;
  if (hit.events.includes("on_mob_kill") || hit.events.includes("on_death")) return "on-kill";
  if (hit.chance > 0) return undefined;
  if (hit.needsTag !== undefined && !spellTags.has(hit.needsTag)) return "wrong-skill";
  if (hit.ifs.includes("is_is_basic_atk_true")) return "basic-attack";
  if (hit.ifs.includes("is_is_basic_atk_true_is_false")) return "spell-only";
  return "cannot-trigger";
}

/**
 * How often this proc's trigger happens, per second.
 *
 * Two clocks, and which one a proc is on is a property of the block rather than of the skill:
 * your hits for an ordinary offensive proc, the enemy's hits for a `Target`-side one.
 *
 * A proc that fires on the *avoidance* — "when you block", "when you dodge" — is on a third
 * clock this cannot give it, and {@link limitOf} keeps it at `when-hit` for that reason.
 */
function triggerRateOf(hit: Blended, input: ProcInput): number {
  const incoming = input.incomingPerSecond;
  if (hit.side === "Target" && incoming !== undefined) return incoming;
  return input.hitsPerSecond;
}

/**
 * Which stats cast `spellId`, and whether the build has any of them.
 *
 * The inverse of what the rest of this module does. `resolveProcs` starts from the sheet and
 * asks what it casts; this starts from a spell and asks what would cast it — which is the only
 * way to say anything honest about a spell a player cannot press.
 *
 * The pack's 20 `cursed_*` variants, the curses, `mirror_image`, `power_surge`, `martyrdom`,
 * `eighth_gate` and `blood_harvest` all declare `cast_speed_ticks: 0`. Asked for one directly,
 * the engine has no cast rate to pace it with, and the honest answer is not a number — it is
 * "this happens when `<stat>` fires, and here is whether you have it".
 *
 * `onSheet` is the distinction that matters: a build carrying the stat gets a real answer from
 * `DpsResult.procs` while it is casting something else, and a build carrying none is being shown
 * a spell it has no way to produce.
 */
export function procSourcesFor(
  snapshot: Snapshot,
  spellId: string,
  sheet: ReadonlyMap<string, { value: number }>,
): { statId: string; onSheet: boolean }[] {
  const out: { statId: string; onSheet: boolean }[] = [];
  const effects = snapshot.registries[CATEGORY.statEffect] ?? {};

  for (const [statId, stat] of Object.entries(snapshot.registries[CATEGORY.stat] ?? {})) {
    const blocks = (stat.data as Record<string, unknown>)["effect"];
    if (!Array.isArray(blocks)) continue;

    for (const raw of blocks) {
      const ids = (raw as Record<string, unknown>)["effects"];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const data = effects[id]?.data as Record<string, unknown> | undefined;
        if (data?.["ser"] !== "proc_spell") continue;
        if (data["spellId"] !== spellId) continue;
        if (!out.some((o) => o.statId === statId)) {
          out.push({ statId, onSheet: (sheet.get(statId)?.value ?? 0) > 0 });
        }
      }
    }
  }
  return out;
}

/**
 * Every `proc_spell` the sheet carries, whether or not this skill can trigger it.
 *
 * The same walk `effect-state.ts` does for `give_exile_effect`: a stat above zero whose effect
 * block names a `proc_spell` is a spell the build can cast without pressing anything.
 */
function candidates(
  snapshot: Snapshot,
  sheet: ReadonlyMap<string, { value: number }>,
): Omit<Blended, "chance">[] {
  const out: Omit<Blended, "chance">[] = [];
  const effects = snapshot.registries[CATEGORY.statEffect] ?? {};

  for (const [statId, stat] of Object.entries(snapshot.registries[CATEGORY.stat] ?? {})) {
    if ((sheet.get(statId)?.value ?? 0) <= 0) continue;
    const blocks = (stat.data as Record<string, unknown>)["effect"];
    if (!Array.isArray(blocks)) continue;

    for (const raw of blocks) {
      const block = raw as Record<string, unknown>;
      const ids = Array.isArray(block["effects"]) ? (block["effects"] as unknown[]) : [];
      const ifs = (Array.isArray(block["ifs"]) ? (block["ifs"] as unknown[]) : []).filter(
        (i): i is string => typeof i === "string",
      );
      const events = (Array.isArray(block["events"]) ? (block["events"] as unknown[]) : []).filter(
        (e): e is string => typeof e === "string",
      );
      // `spell_has_tag_not_<tag>` is a negated gate registered under its own id, so only the
      // positive form restricts the proc to a skill.
      const tagGate = ifs.find((i) => i.startsWith("spell_has_tag_") && !i.includes("_not_") && !i.endsWith("_is_false"));
      const needsTag = tagGate === undefined ? undefined : tagFor(snapshot, tagGate);

      for (const id of ids) {
        if (typeof id !== "string") continue;
        const data = effects[id]?.data as Record<string, unknown> | undefined;
        if (data === undefined || data["ser"] !== "proc_spell") continue;
        const spellId = data["spellId"];
        if (typeof spellId !== "string") continue;
        out.push({
          statId,
          spellId,
          side: typeof block["side"] === "string" ? (block["side"] as string) : "Source",
          events,
          ifs,
          ...(needsTag === undefined ? {} : { needsTag }),
        });
      }
    }
  }
  return out;
}

/** The tag a `spell_has_tag` condition tests for — an object field, not the id's suffix. */
function tagFor(snapshot: Snapshot, conditionId: string): string | undefined {
  const data = entry(snapshot, CATEGORY.statCondition, conditionId)?.data as
    | Record<string, unknown>
    | undefined;
  const tag = data?.["tag"];
  if (typeof tag === "string") return tag;
  if (tag !== null && typeof tag === "object") {
    const id = (tag as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * `proc_cooldown_ticks` on the procced spell.
 *
 * The `is_<spell>_not_on_cd` condition every proc block carries is what reads it in game, and
 * that condition is unanswerable from a static document — so the cooldown is applied here, as a
 * ceiling on the rate, rather than as a gate on the roll.
 */
function procCooldownOf(snapshot: Snapshot, spellId: string): number {
  const config = entry(snapshot, CATEGORY.spell, spellId)?.data?.["config"];
  const value =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)["proc_cooldown_ticks"]
      : undefined;
  return typeof value === "number" && value > 0 ? value : DEFAULT_PROC_COOLDOWN_TICKS;
}
