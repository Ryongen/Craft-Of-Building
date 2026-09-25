/**
 * How often you actually get to press the finisher.
 *
 * A third of this pack's weapon skills are links in a chain rather than buttons you can spam.
 * `raging_dragon` gates every damage act it has on `combo_extender`, and consumes the stacks when
 * it fires; `spirit_offensive` is what grants `combo_extender`, and it in turn wants
 * `combo_linker`; `elemental_assault` grants that, and wants `combo_starter`; and nothing in the
 * skill registry grants `combo_starter` at all — it comes from `proc_combo_starter`, a stat that
 * fires on a **basic attack**.
 *
 * So `raging_dragon`'s own cycle of 0.75 s is the rate at which the button is *ready*, not the
 * rate at which it does anything. The honest figure is one pass of the whole chain, and that is
 * the number a player is choosing a build on.
 *
 * ## How the chain is found
 *
 * Two facts in the spell data, together, mean "this is a link":
 *
 *   - a positive `caster_has_mns_effect` gate on a part, and
 *   - a `REMOVE_STACKS` act for the same effect somewhere in the spell.
 *
 * Gating without consuming is a *condition* — `armageddon` wanting four `overheat` stacks, a
 * weapon skill wanting a stance — and a condition is something you maintain, not something a
 * previous cast hands over. Consuming is what makes it a resource, and a resource has a supplier:
 * whichever enabled skill in the build has a `GIVE_STACKS` act for it.
 *
 * Walk that backwards from the skill until a step needs nothing, or until nothing equipped
 * supplies what it needs — which is a broken chain, and is reported rather than papered over.
 *
 * A spell can be its own supplier, and three of the Sanguimancer's are. `banishing_blade` carries
 * both halves as entity components:
 *
 *     attached.entity_components.stack_adder[0]   GIVE_STACKS   banishing_blade
 *     attached.entity_components.stack_remover[0] REMOVE_STACKS banishing_blade
 *     attached.on_cast[2].ifs[1]  caster_has_mns_effect banishing_blade is_false
 *     attached.on_cast[3].ifs[1]  caster_has_mns_effect banishing_blade
 *
 * — so the first press fires the plain projectile and marks you, and the second fires the gated
 * one and clears the mark. That is a two-press chain of a single button, not a hole: the finisher
 * lands every other press. Excluding the spell from its own supplier search reported all three as
 * chains nothing in the build could feed, which is the opposite of what the data says.
 *
 * ## What each step costs
 *
 * `castTicks + castSpeedTicks`, the same sum `simulateFullDps` uses: a cast occupies its own cast
 * time and then arms the shared global cooldown, and `cast_speed_ticks` is already divided by the
 * cast-speed multiplier your `attack_speed` and `skill_speed` stats produced. A skill's own
 * cooldown runs while the other steps are pressed, so the pass only waits for whatever of it is
 * left when you come back round — see `passSeconds`.
 *
 * A basic attack is not a spell and has no `cast_speed_ticks`. It is paced by vanilla:
 *
 *     public float getCurrentItemAttackStrengthDelay() {
 *         return (float)(1.0D / this.getAttributeValue(Attributes.ATTACK_SPEED) * 20.0D);
 *     }
 *
 * — so a capture that recorded `minecraft:generic.attack_speed` can time it exactly, and one that
 * did not leaves that step unpriced and the whole chain with it. Reporting "2.25 s plus one swing
 * I cannot time" beats reporting 2.25 s.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, SkillSetup } from "@cte2/schema";
import { CATEGORY, entry, isSkillEnabled } from "@cte2/schema";

import type { Balance } from "../balance.js";
import { calculate, type EngineOptions } from "../calculate.js";
import { withLearnedRank } from "../collect/spell.js";
import { swingsPerSecond } from "./basic-attack.js";
import type { StatIndex } from "../stat-def.js";
import type { Sheet } from "./ctx.js";
import { casterResourceFlow, type EffectState } from "./effect-state.js";
import type { Compat } from "../compat.js";
import type { LayerIndex } from "./layers.js";
import { calculateSpell, rateOf, spellConfig } from "./spell-calc.js";

/** One press, in the order you make it. */
export type ComboStep = {
  /** `skill` for something on your bar, `basic-attack` for a weapon swing. */
  kind: "skill" | "basic-attack";
  /** The spell cast, for a `skill` step. */
  spellId?: string;
  /**
   * Every effect this press hands the pass.
   *
   * A list rather than one id: `turbo` grants `alpha` and `beta` in a single press, and a
   * supplier covering two of a finisher's three resources is the reason it was chosen.
   */
  grants: string[];
  /** Every effect this press spends. `fusion` takes `alpha` and `beta` back to make `gamma`. */
  spends: string[];
  /** What this step needs up before it does its half of the combo. */
  needs: string[];
  /** Seconds this press costs the pass, or undefined when the engine cannot time it. */
  seconds: number | undefined;
  castSeconds?: number;
  globalCooldownSeconds?: number;
  /**
   * Set when this skill's own recovery — cooldown, charges, cast speed — stretches the pass past
   * the sum of the presses. `seconds` is the press alone; the wait is in `secondsPerCast`.
   */
  cooldownBound?: boolean;
  /** Why the step costs what it does, when that is not obvious. */
  note?: string;
};

/** A link nothing in the build supplies. */
export type BrokenLink = {
  effectId: string;
  /** The spell that wanted it. */
  forSpell: string;
  note: string;
};

export type ComboChain = {
  /** In press order; the last entry is the skill the figure is about. */
  steps: ComboStep[];
  /** One full pass, or undefined when any step could not be timed. */
  secondsPerCast: number | undefined;
  /** How often the last step lands. `1 / secondsPerCast`. */
  castsPerSecond: number | undefined;
  /** The effects the last skill both gates on and spends: what the pass exists to deliver. */
  resources: string[];
  /** Of those, the ones standing when it fires — the branch of the truth table you land in. */
  holds: string[];
  /** Of those, the ones `config.effects` sets by hand, which the pass takes as given. */
  fixed: string[];
  broken: BrokenLink[];
};

export type ComboInput = {
  snapshot: Snapshot;
  build: BuildDoc;
  index: StatIndex;
  layers: LayerIndex;
  balance: Balance;
  compat: Compat;
  effects: EffectState;
  /** The skill the figure is about — the last step of the chain. */
  skill: SkillSetup;
  /** Options for the per-step stat sheets, so every step describes the same character. */
  engineOptions: EngineOptions;
  /** The character sheet the caller already built, so the walk does not rebuild it. */
  sheet: Sheet;
  /**
   * The press order, when the caller has already worked it out.
   *
   * `simulateDps` has to: the charge state the plan settles on is what decides which branch of
   * the spell exists, so it is resolved before the effect state and handed down rather than
   * derived twice and risking two different answers.
   */
  plan?: ComboPlan;
};

/**
 * Stop a pathological datapack from walking forever.
 *
 * Eight was the bound when a chain was one thread of single-resource links. `phase_dive` needs
 * three at once and `fusion` spends two of them to make the third, so a correct pass of the
 * alpha/beta/gamma family is six presses before any of them is a link in something longer.
 */
const MAX_PRESSES = 12;

/** One pass `simulateDps` priced while choosing which charge state to play for. */
export type ComboRotation = {
  /** The resources up when the finisher fires. */
  holds: string[];
  /** In press order; undefined for a basic attack. */
  presses: (string | undefined)[];
  /** One pass, or undefined when it could not be timed or never completes. */
  secondsPerCast: number | undefined;
  /**
   * The finisher's damage at this pass's rate: `comboDps`, or `dps` for a pass that is the
   * finisher alone. Undefined when the pass has no rate.
   */
  dps: number | undefined;
  broken: boolean;
  /** The one the rest of the result describes. */
  chosen: boolean;
};

/** One press of the pass, before anything has tried to time it. */
export type ComboPress = {
  kind: "skill" | "basic-attack";
  spellId?: string;
  /** Every effect this press hands the pass. */
  grants: string[];
  /** Every effect this press spends — `fusion` takes `alpha` and `beta` back. */
  spends: string[];
  /** The resource it was pressed for, when it was pressed to supply one. */
  suppliedFor?: string;
  /** Carried through to the timed step for a basic attack, which explains its own rate. */
  note?: string;
  /** The stat that grants the resource on a swing, for a basic-attack press. */
  fromStat?: string;
  /** That stat's chance, as a fraction — you swing until it procs. */
  chance?: number;
};

/**
 * The press order that reaches the skill, and the resources standing when it fires.
 *
 * Separate from {@link resolveCombo} because it is derived from the spell data alone — which
 * skill grants what, which spends what — and nothing about the character. That is what lets the
 * charge state it settles on be handed to `resolveEffectState` *before* any sheet exists, which
 * is the only order in which the rate and the damage can be made to describe the same rotation.
 */
export type ComboPlan = {
  presses: ComboPress[];
  /** The effects this skill both gates on and spends: its combo resources. */
  resources: string[];
  /** The resources the pass set out to deliver — all of them, unless a partial one was asked for. */
  target: string[];
  /** Resources `config.effects` states on or off, which the pass neither supplies nor chooses. */
  fixed: string[];
  /** The resources up at the moment the last press lands. */
  holds: string[];
  broken: BrokenLink[];
};

/**
 * Work out what you have to press, in order, to fire `spellId` with its resources up.
 *
 * ## Why a set rather than a thread
 *
 * The walk this replaces followed one resource — `needed[0]` — and said so:
 *
 *     // One chain, not a tree. A spell consuming two resources is not a shape this pack has
 *
 * It is a shape this pack has. `phase_dive` is a truth table over three charges: eight mutually
 * exclusive `on_cast` branches, one per combination of `alpha`, `beta` and `gamma`, each
 * throwing a different projectile with a different `value_calculation`, and a ninth ungated part
 * that spends all three. `chronobreak`, `timewinder`, `pulsar_singularity_trap` and
 * `parallel_convergence` are the same table over the same three charges.
 *
 * Following one of the three priced a three-press chain — `zap`, `fusion`, `phase_dive` — while
 * the damage half was computed with all three charges up, off the eighth branch. So the rate
 * described one rotation and the number described another, and the DPS was their quotient.
 *
 * ## Why the presses are simulated forwards
 *
 * Because a supplier can spend what another supplier just made. `fusion` gates on `alpha` and
 * `beta`, gives `gamma`, and takes `alpha` and `beta` away again — so reaching all three means
 * pressing the `alpha`/`beta` suppliers twice, once to feed `fusion` and once to rebuild what it
 * consumed. Walking backwards from the finisher cannot see that; running the presses forwards
 * and re-asking "what is still missing" after each one falls out of it for free.
 *
 * Supplier choice is greedy, not optimal: the equipped skill covering the most of what is
 * missing wins, then the one needing least itself, then bar order. `turbo` grants `alpha` and
 * `beta` in one press and beats casting `zap` and `cold_snap` separately, which is the right
 * answer and is also the one a player would find. A genuinely optimal ordering is a search, and
 * a figure nobody can re-derive by hand is worse than a slightly long one they can.
 *
 * ## A partial pass
 *
 * `target` narrows what the finisher waits for — `["alpha", "beta"]` is "turbo, then fire",
 * skipping the fusion detour and landing the alpha+beta branch. Only the finisher is narrowed:
 * `fusion` still needs both of its charges to make `gamma`, so a gamma-only pass still pays for
 * them. Which partial pass is worth playing is a damage question, answered in `simulateDps`
 * over {@link comboCandidates}.
 */
export function planCombo(
  snapshot: Snapshot,
  build: BuildDoc,
  spellId: string,
  sheet?: Sheet,
  target?: readonly string[],
): ComboPlan {
  const equipped = (build.skills ?? []).filter(isSkillEnabled);
  const goal = spellData(snapshot, spellId);
  const resources = goal === undefined ? [] : consumedGates(goal);
  const { on: fixedOn, off: fixedOff } = fixedResources(build, resources);
  const fixed = [...fixedOn, ...fixedOff];
  // A resource the document states is not the pass's to deliver: it is up, or it is not, and
  // nothing is pressed to change that.
  const wanted = (target === undefined ? resources : resources.filter((e) => target.includes(e)))
    .filter((e) => !fixed.includes(e));
  /** What `id` has to have up before it is pressed. */
  const needsOf = (id: string, spell: Record<string, unknown>): string[] =>
    id === spellId ? wanted : consumedGates(spell);

  const presses: ComboPress[] = [];
  const broken: BrokenLink[] = [];
  const held = new Set<string>(fixedOn);
  const inFlight = new Set<string>();
  /**
   * What was standing the moment the finisher was pressed.
   *
   * Snapshotted rather than read off `held` at the end, because the finisher's own press is the
   * one that spends them: `phase_dive`'s ninth, ungated part clears all three charges on the way
   * out, so the state afterwards says the branch it had just used was not available. Taking it
   * before the press also gives the honest answer on a chain with a hole in it — a pass that got
   * `alpha` and then found nothing supplying `beta` really does fire the alpha-only branch.
   */
  let atFinisher: Set<string> | undefined;

  const pressSkill = (id: string, suppliedFor?: string): void => {
    const spell = spellData(snapshot, id);
    const grants = spell === undefined ? [] : grantedEffects(spell);
    const spends = spell === undefined ? [] : removedEffects(spell);
    presses.push({
      kind: "skill",
      spellId: id,
      grants,
      spends,
      ...(suppliedFor === undefined ? {} : { suppliedFor }),
    });
    for (const effect of grants) held.add(effect);
    // A spell that spends what it also gives keeps it: `banishing_blade`'s `stack_adder` and
    // `stack_remover` are different branches of the same press, and which one runs is decided by
    // whether you were already marked. Removing after adding would make the self-toggle supply
    // nothing and report a chain that never completes.
    for (const effect of spends) if (!grants.includes(effect)) held.delete(effect);
  };

  /** Satisfy everything `id` needs, then press it. False when the pass cannot be completed. */
  const deliver = (id: string, suppliedFor?: string): boolean => {
    const spell = spellData(snapshot, id);
    if (spell === undefined) return false;
    // A supplier that needs itself would recurse; the self-toggle below is the legitimate way
    // for a spell to feed its own gate, and it emits a bare press rather than coming back here.
    if (inFlight.has(id)) return false;
    inFlight.add(id);
    try {
      for (;;) {
        const missing = needsOf(id, spell).filter((effect) => !held.has(effect));
        if (missing.length === 0) break;
        if (presses.length >= MAX_PRESSES) {
          broken.push({
            effectId: missing[0]!,
            forSpell: id,
            note:
              `Feeding \`${id}\` its ${missing.length === 1 ? "resource" : "resources"} ` +
              `(${missing.map((m) => `\`${m}\``).join(", ")}) takes more than ${MAX_PRESSES} ` +
              `presses, which is longer than any rotation in this pack, so it is reported rather than ` +
              `guessed at.`,
          });
          return false;
        }

        const want = missing[0]!;
        // What the finisher was not asked to fire holding. A supplier handing it over as well
        // lands a different branch from the one this pass is for — `turbo` asked for alpha
        // arrives holding alpha and beta, and "alpha only" would never be priced at all.
        const unwanted = resources.filter((e) => !wanted.includes(e) && !fixedOn.includes(e));
        const supplier = pickSupplier(snapshot, equipped, want, missing, id, unwanted);
        if (supplier !== undefined) {
          if (!deliver(supplier, want)) return false;
          continue;
        }

        // The spell is its own supplier — press it once to arm the gated half. It is emitted
        // directly rather than through `deliver`, because coming back round would re-enter a
        // spell already in flight and the guard above would call the pass broken.
        if (grantsEffect(snapshot, id, want)) {
          pressSkill(id, want);
          continue;
        }

        // Nothing on the bar supplies it. A basic attack might — that is how every combo in
        // this pack starts.
        const fromStat = statGrant(snapshot, build, want, sheet);
        if (fromStat !== undefined) {
          presses.push(fromStat);
          held.add(want);
          continue;
        }

        broken.push({
          effectId: want,
          forSpell: id,
          note:
            `Nothing enabled in this build applies \`${want}\`, and no stat grants it either, ` +
            `so ${id} never gets to fire its gated half.`,
        });
        return false;
      }

      if (id === spellId) atFinisher = new Set(held);
      pressSkill(id, suppliedFor);
      return true;
    } finally {
      inFlight.delete(id);
    }
  };

  if (!deliver(spellId) && !presses.some((press) => press.spellId === spellId)) {
    // The skill itself still belongs in the table. A broken chain is not "nothing happens", it
    // is "here is the button, and here is why you never get to press it usefully" — dropping the
    // row left the panel showing a reason with nothing to attach it to.
    atFinisher = new Set(held);
    pressSkill(spellId);
  }

  const standing = atFinisher ?? held;
  return {
    presses,
    resources,
    target: wanted,
    // What the document states beats what the presses did: `resolveEffectState` keeps a chosen
    // effect as chosen, so a supplier's grant of a resource set off never reaches the damage, and
    // the holds have to say the same or the card labels one branch and prices another.
    holds: resources.filter((e) => fixedOn.includes(e) || (standing.has(e) && !fixedOff.includes(e))),
    fixed,
    broken,
  };
}

/**
 * The resources `config.effects` states outright, split by which way.
 *
 * The same reading `resolveEffectState` gives an entry — `true` or a positive stack count is up,
 * `false` or zero is off — because the two have to agree about what the finisher fires holding.
 */
function fixedResources(build: BuildDoc, resources: readonly string[]): { on: string[]; off: string[] } {
  const stated = build.config?.effects ?? {};
  const on: string[] = [];
  const off: string[] = [];
  for (const id of resources) {
    const value = stated[id];
    if (value === undefined) continue;
    if (value === true || (typeof value === "number" && value > 0)) on.push(id);
    else off.push(id);
  }
  return { on, off };
}

/**
 * Every distinct pass worth pricing for `spellId`: one per subset of its resources, the full set
 * first.
 *
 * The full pass is not automatically the best one. `phase_dive` holding all three charges costs
 * turbo, fusion and turbo again before it fires; holding alpha and beta costs one turbo, and a
 * branch that hits for less can still win when it comes round three times as often. So each
 * subset is planned, and `simulateDps` prices them and keeps the winner.
 *
 * Two subsets are never offered:
 *
 *   - one leaving out a resource the finisher grants itself. `banishing_blade` marks you on the
 *     plain press, so "never marked" is not a rotation you can play — the next press is marked.
 *   - one whose pass lands in the same charge state as an earlier one, and completes or breaks
 *     the same way. Asking for alpha alone on a bar whose only alpha supplier is `turbo` arrives
 *     holding alpha and beta anyway, and pricing it twice would list the same rotation twice.
 *     The shorter pass is kept.
 *
 * A broken full pass is kept, so the break is still reported; a broken partial one is dropped.
 */
export function comboCandidates(
  snapshot: Snapshot,
  build: BuildDoc,
  spellId: string,
  sheet?: Sheet,
): ComboPlan[] {
  const full = planCombo(snapshot, build, spellId, sheet);
  const { resources } = full;
  if (resources.length === 0) return [full];

  // Stated in `config.effects`, a resource is the document's call and not the search's: every
  // candidate holds it the same way, so enumerating it would only list the same branch twice.
  const forced = resources.filter(
    (e) => !full.fixed.includes(e) && grantsEffect(snapshot, spellId, e),
  );
  const free = resources.filter((e) => !forced.includes(e) && !full.fixed.includes(e));
  const whole = forced.length + free.length;

  // Largest subsets first, so the full pass is the one the dedupe keeps a broken copy of.
  const subsets: string[][] = [];
  for (let mask = (1 << free.length) - 1; mask >= 0; mask--) {
    subsets.push([...forced, ...free.filter((_, i) => (mask & (1 << i)) !== 0)]);
  }
  subsets.sort((a, b) => b.length - a.length);

  const byHolds = new Map<string, ComboPlan>();
  for (const subset of subsets) {
    const plan = subset.length === whole ? full : planCombo(snapshot, build, spellId, sheet, subset);
    // The full pass is the one that says what the bar cannot reach. A partial pass that breaks
    // too says the same thing again and can never be played, so it is not a candidate.
    if (plan !== full && plan.broken.length > 0) continue;
    // Brokenness is part of the key. A full pass that stalls on `beta` fires holding alpha, and
    // so does a clean "zap, then fire" — but only the first can say the full pass is out of reach.
    const key = `${plan.holds.join(",")}${plan.broken.length > 0 ? "!" : ""}`;
    const seen = byHolds.get(key);
    if (seen === undefined || plan.presses.length < seen.presses.length) byHolds.set(key, plan);
  }
  return [...byHolds.values()];
}

/**
 * The equipped skill best placed to supply `want`, or undefined when none is.
 *
 * Greedy on coverage first: `turbo` grants `alpha` and `beta` together, so on a bar that also
 * carries `zap` and `cold_snap` it is one press instead of two. Then on how much it spills — a
 * resource the finisher was not asked to fire holding, which is why a pass for alpha alone
 * presses `zap` rather than `turbo`. Then on what the supplier itself needs, so a supplier you
 * can simply press beats one that drags its own chain in behind it.
 */
function pickSupplier(
  snapshot: Snapshot,
  equipped: readonly SkillSetup[],
  want: string,
  missing: readonly string[],
  exclude: string,
  unwanted: readonly string[] = [],
): string | undefined {
  let best: { id: string; covers: number; spills: number; needs: number; order: number } | undefined;
  equipped.forEach((setup, order) => {
    if (setup.spellId === exclude) return;
    if (!grantsEffect(snapshot, setup.spellId, want)) return;
    const spell = spellData(snapshot, setup.spellId);
    if (spell === undefined) return;
    const grants = grantedEffects(spell);
    const covers = missing.filter((effect) => grants.includes(effect)).length;
    const spills = unwanted.filter((effect) => grants.includes(effect)).length;
    const needs = consumedGates(spell).length;
    const better =
      best === undefined ||
      covers > best.covers ||
      (covers === best.covers && spills < best.spills) ||
      (covers === best.covers && spills === best.spills && needs < best.needs) ||
      (covers === best.covers && spills === best.spills && needs === best.needs && order < best.order);
    if (better) best = { id: setup.spellId, covers, spills, needs, order };
  });
  return best?.id;
}

/**
 * The chain that ends in `skill`, or undefined when the skill is not a link in one.
 *
 * Undefined rather than a one-step chain: a skill you can simply press has a cast rate already,
 * and a "combo" card showing one row would be noise.
 */
export function resolveCombo(input: ComboInput): ComboChain | undefined {
  const plan =
    input.plan ?? planCombo(input.snapshot, input.build, input.skill.spellId, input.sheet);

  /** Each skill's own press-to-press floor, for {@link passSeconds}. */
  const periods = new Map<string, number>();
  const steps: ComboStep[] = plan.presses.map((press) => {
    if (press.kind === "basic-attack") {
      const swing = swingSeconds(input.build, input.sheet);
      const chance = press.chance ?? 1;
      return {
        kind: "basic-attack" as const,
        needs: [],
        grants: press.grants,
        spends: press.spends,
        seconds: swing === undefined || chance <= 0 ? undefined : swing / chance,
        ...(swing === undefined ? {} : { castSeconds: swing }),
        ...(press.note === undefined ? {} : { note: press.note }),
      };
    }
    const declared = (input.build.skills ?? []).find((s) => s.spellId === press.spellId);
    const setup = withLearnedRank(
      input.snapshot,
      input.build,
      declared ?? { spellId: press.spellId! },
      input.engineOptions.spellRanks,
    );
    const rate = rateFor(input, setup);
    periods.set(press.spellId!, rate.periodSeconds);
    const spell = spellData(input.snapshot, press.spellId!);
    return {
      kind: "skill" as const,
      spellId: press.spellId!,
      seconds: rate.seconds,
      castSeconds: rate.castSeconds,
      globalCooldownSeconds: rate.globalCooldownSeconds,
      needs: spell === undefined ? [] : consumedGates(spell),
      grants: press.grants,
      spends: press.spends,
    };
  });

  // One step and nothing missing means a skill you can simply press, which has a cast rate
  // already; a "combo" card with one row in it would be noise. One step and a missing link is the
  // opposite — it is the case worth saying out loud, because the skill will never fire at all.
  // Resources set by hand are the exception: the card is where the document's pin is explained,
  // and without it a build that ticked gamma on never learns why nothing is being chosen.
  if (steps.length < 2 && plan.broken.length === 0 && plan.fixed.length === 0) return undefined;

  // A chain with a hole in it has no rate at all — you never reach the last step — which is a
  // different answer from "slow", and reporting the sum of the steps that do exist would read as
  // the second.
  const timed = plan.broken.length === 0 && steps.every((s) => s.seconds !== undefined);
  const pressing = steps.reduce((sum, s) => sum + (s.seconds ?? 0), 0);
  const { seconds: total, boundBy } = timed
    ? passSeconds(steps, periods)
    : { seconds: pressing, boundBy: undefined };
  if (boundBy !== undefined) {
    for (const step of steps) if (step.spellId === boundBy) step.cooldownBound = true;
  }

  return {
    steps,
    secondsPerCast: timed && total > 0 ? total : undefined,
    castsPerSecond: timed && total > 0 ? 1 / total : undefined,
    resources: plan.resources,
    holds: plan.holds,
    fixed: plan.fixed,
    broken: plan.broken,
  };
}

// ---------------------------------------------------------------------------
// Reading the chain out of the spell data
// ---------------------------------------------------------------------------

/**
 * Effects the spell both gates on and spends — its combo resources.
 *
 * The two halves have to meet: `whirlwind` gates on a stance and never consumes one, which makes
 * the stance a thing you stand in rather than a thing another cast handed you. Following it would
 * put "cast fighter_stance" into the chain as though you had to re-enter it every 0.75 seconds.
 */
function consumedGates(spell: Record<string, unknown>): string[] {
  const gated = new Set<string>();
  const consumed = new Set<string>();

  walk(spell["attached"], (node) => {
    const type = stringAt(node, "type");
    const map = asObject(node["map"]) ?? {};
    if (type === "caster_has_mns_effect" || type === "has_mns_effect") {
      // `is_false` is the spell's "and the plain version when you do not" branch, which is the
      // opposite of a requirement.
      if (map["is_false"] === true) return;
      const id = stringAt(map, "exile_potion_id");
      if (id !== undefined) gated.add(id);
    }
    if (type === "exile_effect" && stringAt(map, "potion_action") === "REMOVE_STACKS") {
      const id = stringAt(map, "exile_potion_id");
      if (id !== undefined) consumed.add(id);
    }
  });

  return [...gated].filter((id) => consumed.has(id));
}

/** True when some part of the spell hands the effect out. */
function grantsEffect(snapshot: Snapshot, spellId: string, effectId: string): boolean {
  const spell = entry(snapshot, CATEGORY.spell, spellId)?.data;
  if (spell === undefined) return false;
  let found = false;
  walk(spell["attached"], (node) => {
    if (found) return;
    if (stringAt(node, "type") !== "exile_effect") return;
    const map = asObject(node["map"]) ?? {};
    if (stringAt(map, "exile_potion_id") !== effectId) return;
    if (!(stringAt(map, "potion_action") ?? "GIVE_STACKS").startsWith("GIVE")) return;
    found = true;
  });
  return found;
}

/**
 * The press before the first skill: whatever stat hands out the starting resource.
 *
 * In this pack that is always `proc_combo_starter`, which carries an `is_is_basic_atk` condition
 * — so the press is a weapon swing, and vanilla times it.
 *
 * The sheet is optional because {@link planCombo} is otherwise pure spell data. Without one the
 * stat cannot be read, so the search stops at the equipped skills and the resource is reported
 * as unsupplied rather than quietly assumed.
 */
function statGrant(snapshot: Snapshot, build: BuildDoc, effectId: string, sheet?: Sheet): ComboPress | undefined {
  if (sheet === undefined) return undefined;
  const effects = snapshot.registries[CATEGORY.statEffect] ?? {};
  const stats = snapshot.registries[CATEGORY.stat] ?? {};

  for (const [statId, stat] of Object.entries(stats)) {
    const value = sheet.get(statId)?.value ?? 0;
    if (value <= 0) continue;
    for (const rawBlock of asArray(asObject(stat.data)?.["effect"])) {
      const block = asObject(rawBlock);
      if (block === undefined) continue;
      const basic = asArray(block["ifs"]).some(
        (i) => typeof i === "string" && i.includes("is_basic_atk"),
      );
      for (const rawId of asArray(block["effects"])) {
        if (typeof rawId !== "string") continue;
        const data = asObject(effects[rawId]?.data);
        if (data === undefined) continue;
        if (!(stringAt(data, "ser") ?? "").startsWith("give_exile_effect")) continue;
        if (stringAt(data, "effect") !== effectId) continue;
        if (!basic) continue;

        const swing = swingSeconds(build, sheet);
        // The stat is a chance. At 40% you swing two and a half times per starter, and the
        // chain waits for every one of them.
        const chance = Math.min(100, Math.max(0, value)) / 100;
        const seconds = swing === undefined || chance <= 0 ? undefined : swing / chance;
        return {
          kind: "basic-attack",
          grants: [effectId],
          spends: [],
          suppliedFor: effectId,
          fromStat: statId,
          chance,
          note:
            `\`${statId}\` grants \`${effectId}\` on a basic attack, at ${round(value)}%` +
            (swing === undefined
              ? `. The swing itself is vanilla's \`1 / attack_speed\`, and no ` +
                `\`minecraft:generic.attack_speed\` was recorded, so it cannot be timed.`
              : `, and a full-strength swing is ${round(swing)}s.` +
                (chance < 1 ? ` At that chance a starter costs ${round(seconds!)}s of swinging.` : "")),
        };
      }
    }
  }
  return undefined;
}

/** The spell's raw registry data, or undefined when the id names nothing. */
function spellData(snapshot: Snapshot, spellId: string): Record<string, unknown> | undefined {
  return entry(snapshot, CATEGORY.spell, spellId)?.data as Record<string, unknown> | undefined;
}

/** Every effect a press of the spell hands the caster. */
function grantedEffects(spell: Record<string, unknown>): string[] {
  return casterResourceFlow(spell).grants;
}

/**
 * Every effect a press of the spell takes off the caster.
 *
 * What makes a supplier cost something: `fusion` gives `gamma` and spends `alpha` and `beta` on
 * the way, so a pass that wants all three has to rebuild two of them afterwards.
 */
function removedEffects(spell: Record<string, unknown>): string[] {
  return casterResourceFlow(spell).spends;
}

/**
 * `Player.getCurrentItemAttackStrengthDelay()` — `1 / attack_speed * 20` ticks.
 *
 * Vanilla's attribute, but only its weapon half is fixed: Mine and Slash's `attack_speed` is a
 * `MULTIPLY_BASE` modifier on it, so the rate moves with the build and `basic-attack.ts` re-applies
 * it. A partial-strength swing still hits, but a player chaining a combo waits for the full one,
 * and it is the only delay with a defined value.
 *
 * Through `basic-attack.ts` so the chain and the swing's own damage figure can never disagree
 * about how fast you swing.
 */
function swingSeconds(build: BuildDoc, sheet: Sheet): number | undefined {
  const speed = swingsPerSecond(build, sheet);
  return speed === undefined ? undefined : 1 / speed;
}

// ---------------------------------------------------------------------------
// What a step costs
// ---------------------------------------------------------------------------

/**
 * How long one pass takes, and which skill's recovery stretched it, if any did.
 *
 * Pressing is the floor: every step's cast plus the global cooldown it arms, back to back. A
 * skill's own recovery runs *while* you press the others, so it only costs time when the gap
 * before you come back round to it is shorter than the recovery. `chronobreak` on an 8s cooldown
 * behind one 0.55s `zap` is an 8s pass, not 8.55s — the zap fits inside the wait.
 *
 * A skill pressed twice in a pass has two gaps, and each has to cover its recovery: `turbo`
 * either side of `fusion` waits out its own cooldown in between, and again before the next pass.
 * So per skill the pass is at least the sum of its gaps, each raised to its recovery. That is a
 * lower bound, reached by a player who holds each press until it is ready and no longer — two
 * skills both waiting in the same gap would each count the wait, and this does not add them up.
 *
 * The recovery is the skill's standalone cycle, cooldown or charge regen or cast speed, so a
 * charge-paced trap whose `cooldown_ticks` reads zero is still held to its real rate.
 */
function passSeconds(
  steps: readonly ComboStep[],
  periods: ReadonlyMap<string, number>,
): { seconds: number; boundBy: string | undefined } {
  const costs = steps.map((s) => s.seconds ?? 0);
  let seconds = costs.reduce((sum, c) => sum + c, 0);
  let boundBy: string | undefined;

  for (const [spellId, period] of periods) {
    const at = steps.flatMap((s, i) => (s.spellId === spellId ? [i] : []));
    let needed = 0;
    at.forEach((start, k) => {
      // The pass repeats, so the last press's gap runs round to the first one of the next pass.
      const end = k + 1 < at.length ? at[k + 1]! : at[0]! + steps.length;
      let gap = 0;
      for (let i = start; i < end; i++) gap += costs[i % steps.length]!;
      needed += Math.max(period, gap);
    });
    if (needed > seconds + 1e-9) {
      seconds = needed;
      boundBy = spellId;
    }
  }
  return { seconds, boundBy };
}

function rateFor(
  input: ComboInput,
  skill: SkillSetup,
): {
  seconds: number;
  castSeconds: number;
  globalCooldownSeconds: number;
  /** Press to press, on its own — cooldown, charge regen or cast speed, whichever won. */
  periodSeconds: number;
} {
  const spell = entry(input.snapshot, CATEGORY.spell, skill.spellId)!.data;
  const declared = spellConfig(spell);
  // The spell unit, not the character sheet: a support gem's cast-speed bonus is real for one
  // skill and absent for every other, and the chain is a sum of exactly those.
  const sheet: Sheet = calculate(input.build, input.snapshot, {
    ...input.engineOptions,
    skill,
    effects: input.effects,
  }).stats;

  const calc = calculateSpell({
    equipped: input.build.skills ?? [],
    snapshot: input.snapshot,
    index: input.index,
    layers: input.layers,
    balance: input.balance,
    sheet,
    spell,
    skill,
    characterLevel: input.build.character.level,
    config: input.build.config ?? {},
    compat: input.compat,
    effects: input.effects,
    diagnostics: [],
  });
  const rate = rateOf(calc, declared);

  // A step costs its cast plus the arm it puts on everything else. Its own recovery is not a
  // cost of the step: it runs while the other presses happen, and `passSeconds` charges only
  // what is left of it when you come back round.
  return {
    seconds: rate.castSeconds + rate.globalCooldownSeconds,
    castSeconds: rate.castSeconds,
    globalCooldownSeconds: rate.globalCooldownSeconds,
    periodSeconds: rate.cycleSeconds,
  };
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = asObject(value);
  if (node === undefined) return;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringAt(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
