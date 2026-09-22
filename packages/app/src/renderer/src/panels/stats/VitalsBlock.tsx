/**
 * The sidebar: the numbers a build is actually read by, and nothing else.
 *
 * This used to sit on top of the complete 223-row stat sheet, and the two were doing different
 * jobs in one column. This one is read *while you click* — "what is my effective HP now",
 * between every node on the tree — and that only works if it is short, fixed and never reflows.
 * The exhaustive list is a reference you go and consult, so it went to the Stats tab, where it is
 * `StatList` and where it can use the width. What is left here is one continuous list with no
 * second search box and no sticky header cropping the row above it.
 *
 * ## Why these are not just sheet rows
 *
 * Roughly half of them are not on the sheet at all. A hit, a cast rate, a crit multiplier, the
 * DPS figures and the resource budget are properties of *a skill*, resolved by the damage
 * pipeline; effective HP per element is the defence pass. The sheet knows none of it. That is
 * why this reads `useDerived` whole rather than `derived.stats`, and why the order below is
 * authored here rather than being another `SHEET_GROUPS` section.
 *
 * ## Every row opens
 *
 * There used to be no rule about which rows were clickable: the ones that happened to be stats
 * were, and the skill and defence figures — the headline numbers — were dead. Now all of them
 * open the detail window below, stats into their provenance and figures into the arithmetic that
 * produced them. See `SheetDetail`, and note that the skill's crit chance and crit multiplier
 * open the **spell's** stat unit rather than the character sheet, because that is the sheet the
 * damage pipeline read and the only one a support gem is in.
 *
 * ## What it costs
 *
 * Nothing. Every figure comes out of the run `useDerived` already made for the open document —
 * the same one the Damage, Defence and Compare tabs read — so this is a render of forty spans
 * rather than a second pass of anything.
 */

import {
  SINGLE_ELEMENTS,
  statDisplay,
  statName,
  type ElementName,
} from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { useDerived, type DerivedBuild } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { USABLE_NOUN, num, smart, usable } from "../../ui/format.js";
import { StatIcon } from "../../ui/StatIcon.js";
import { statLook } from "../../ui/stat-look.js";
import { elementColour, elementLabel } from "../../ui/palette.js";
import type { SheetFocus } from "./SheetDetail.js";

/**
 * The resists, in the order the layers apply them and the order the mob types come in.
 *
 * `SINGLE_ELEMENTS` is `Elements.getAllSingle()` — Physical, Fire, Cold, Lightning, Chaos — so
 * the resist list, the effective-HP list and the game's own tooltip are all in one order. Two
 * lists over the same five elements that disagreed about the order would be read as two
 * different sets.
 */
const RESIST_OF: Record<string, string> = {
  physical: "physical_resist",
  fire: "fire_resist",
  water: "water_resist",
  lightning: "lightning_resist",
  chaos: "chaos_resist",
};

/** Whether two focuses are the same row, so clicking a row twice closes it. */
function same(a: SheetFocus | null, b: SheetFocus): boolean {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind === "figure" && b.kind === "figure") return a.id === b.id;
  if (a.kind === "ehp" && b.kind === "ehp") return a.element === b.element;
  if ((a.kind === "stat" || a.kind === "skill-stat") && "statId" in b) return a.statId === b.statId;
  return false;
}

export function VitalsBlock({
  focus,
  onFocus,
}: {
  focus: SheetFocus | null;
  onFocus: (focus: SheetFocus | null) => void;
}): ReactNode {
  const derived = useDerived();
  const pick = (next: SheetFocus) => () => onFocus(same(focus, next) ? null : next);

  return (
    <div className="vitals">
      <SkillVitals derived={derived} focus={focus} pick={pick} />
      <Attributes focus={focus} pick={pick} />
      <Survival derived={derived} focus={focus} pick={pick} />
    </div>
  );
}

/** What each group hands its rows, so a row does not have to know how selection works. */
type Pick = (next: SheetFocus) => () => void;

/**
 * The main skill: what one press does, how often, and what it costs.
 *
 * Absent entirely when no skill is set, rather than nine rows of zero — a build with no skill
 * has no hit, and printing 0 for one claims it was measured.
 */
function SkillVitals({
  derived,
  focus,
  pick,
}: {
  derived: DerivedBuild;
  focus: SheetFocus | null;
  pick: Pick;
}): ReactNode {
  const { snapshot } = useWorld();
  const { dps, damage, fullDps } = derived;
  if (dps === undefined || damage === undefined) {
    return (
      <div className="vitals-group">
        <div className="vitals-title">Main skill</div>
        <div className="muted text-sm">No skill set, so there is no hit to report.</div>
      </div>
    );
  }

  const { rate, cost } = dps;
  // Casts per second rather than seconds per cast: every other rate in the app is per-second,
  // and a cooldown skill's 0.33/s is easier to compare against another skill than "3.00s".
  const perSecond = rate.cycleSeconds > 0 ? 1 / rate.cycleSeconds : 0;

  // The realised multiplier, not `critical_damage`. The stat is one input to a multiplicative
  // layer that `double_damage` and the conversion children also reach, so the ratio of the two
  // branches is what a crit is actually worth on this skill — and it is the number that moves
  // when a support gem is linked.
  const critMulti = damage.hit.total > 0 ? damage.crit.total / damage.hit.total : 0;

  // Which pool this skill actually spends, and what it spends. `manaSpentAs` is `blood` under
  // the Blood Magic game changer, so naming the pool from the cost rather than from the stat is
  // what keeps a blood build's row from reading "Mana".
  const spend =
    cost.manaPerCast > 0
      ? { pool: cost.manaSpentAs, perCast: cost.manaPerCast, perSecond: cost.manaPerSecond }
      : cost.energyPerCast > 0
        ? { pool: cost.energySpentAs, perCast: cost.energyPerCast, perSecond: cost.energyPerSecond }
        : undefined;

  return (
    <div className="vitals-group">
      <div className="vitals-title">Main skill</div>

      <Row
        label="Hit"
        statId="total_damage"
        value={smart(damage.average.total)}
        hint={`Average of ${smart(damage.hit.total)} non-crit and ${smart(damage.crit.total)} crit, weighted by crit chance. One damage source; the Damage tab has the rest.`}
        active={same(focus, { kind: "figure", id: "hit" })}
        onSelect={pick({ kind: "figure", id: "hit" })}
      />
      {/*
        The other hit this build lands, and the one nothing on screen used to name.

        Freeze and Electrify deal no damage when they land: each one adds to a pool on the target
        that a later hit carrying `freeze_proc_chance` or `electrify_proc_chance` releases in one
        go (`EntityAilmentData.shatterAccumulated`). So a cold build's Shatter is a second,
        much larger hit on its own schedule, and it was inside the ailment DPS figure with
        nothing to say how big the spike was. Absent entirely without a proc chance, because
        then the pool only ever leaks and there is no spike to report.
      */}
      {dps.ailmentHit > 0 && (
        <Row
          label="Ailment hit"
          statId="ailment_damage"
          value={smart(dps.ailmentHit)}
          hint={
            `The pool a Shatter or Shock releases, at steady state. The hit that tips it lands ` +
            `too, so the spike on screen is ${smart(damage.average.total + dps.ailmentHit)} — ` +
            `two events, reported as two figures. It depends on your cast rate: the pool leaks ` +
            `10% a second while it waits.`
          }
          active={same(focus, { kind: "figure", id: "ailment-hit" })}
          onSelect={pick({ kind: "figure", id: "ailment-hit" })}
        />
      )}
      <Row
        label={rate.channelled ? "Pulse rate" : "Cast rate"}
        statId="cast_speed"
        value={`${num(perSecond, 2)}/s`}
        hint={
          `One cycle is ${num(rate.cycleSeconds, 2)}s: ${num(rate.castSeconds, 2)}s casting plus ` +
          `${num(rate.cooldownSeconds, 2)}s ${rate.chargeBased ? "charge regeneration" : "recovery"}` +
          (rate.castsPerCycle > 1 ? `, firing ${rate.castsPerCycle} times` : "") +
          "."
        }
        active={same(focus, { kind: "figure", id: "rate" })}
        onSelect={pick({ kind: "figure", id: "rate" })}
      />
      {/*
        Both crit rows open the **skill's** stat unit, not the character's. A support gem writes
        into that unit and nowhere else, so the character breakdown for `critical_hit` is a real
        number that leaves out the one source a player linked on purpose.
      */}
      <Row
        label="Crit chance"
        statId="critical_hit"
        value={`${num(damage.critChance * 100, 2)}%`}
        hint="This skill's own crit chance, support gems included. Click for where it came from."
        active={same(focus, { kind: "skill-stat", statId: "critical_hit" })}
        onSelect={pick({ kind: "skill-stat", statId: "critical_hit" })}
      />
      <Row
        label="Crit multiplier"
        statId="critical_damage"
        value={`${num(critMulti, 2)}×`}
        hint="What a crit is actually worth on this skill: the crit branch over the non-crit one, so double damage and the conversion children are in it."
        active={same(focus, { kind: "figure", id: "crit-multi" })}
        onSelect={pick({ kind: "figure", id: "crit-multi" })}
      />
      {/*
        How many of those hits land. Dodge is folded into every damage figure above as
        expectation, so a build missing one attack in ten reads 10% smaller with nothing on
        screen saying why — the Damage tab said it per act and the sidebar never did.
      */}
      <Row
        label="Chance to hit"
        statId="accuracy"
        value={`${num(damage.hitChance * 100, 2)}%`}
        hint="The target's evasion against your accuracy. The damage figures above already have it folded in."
        active={same(focus, { kind: "figure", id: "hit-chance" })}
        onSelect={pick({ kind: "figure", id: "hit-chance" })}
      />
      <Row
        label="Hit DPS"
        statId="total_damage"
        value={smart(dps.dps)}
        hint="This skill, on its own button."
        active={same(focus, { kind: "figure", id: "hit-dps" })}
        onSelect={pick({ kind: "figure", id: "hit-dps" })}
      />
      {/* The three DoTs alone. The pool releases used to be in this row and are their own row
          now: they are the same clock and nothing else about them is alike, and a build whose
          whole cold output is Shatter read as a build with mysterious bleed damage. */}
      <Row
        label="Ailment DPS"
        statId="ailment_damage"
        value={smart(dps.ailmentDps - dps.ailmentProcDps)}
        hint="Bleed, ignite, poison and the rest, on their own clock. Never part of the hit."
        active={same(focus, { kind: "figure", id: "ailment-dps" })}
        onSelect={pick({ kind: "figure", id: "ailment-dps" })}
      />
      {dps.ailmentProcDps > 0 && (
        <Row
          label="Ailment hit DPS"
          statId="ailment_damage"
          value={smart(dps.ailmentProcDps)}
          hint={
            `The Ailment hit above, at the rate you actually set it off: every freeze or ` +
            `electrify you land fills the pool and every proc empties it, so this is the ` +
            `accumulation rate times the share of the pool that reaches a proc instead of ` +
            `leaking away.`
          }
          active={same(focus, { kind: "figure", id: "ailment-proc-dps" })}
          onSelect={pick({ kind: "figure", id: "ailment-proc-dps" })}
        />
      )}
      <Row
        label="Combined DPS"
        statId="total_damage"
        value={smart(dps.dps + dps.ailmentDps)}
        strong
        hint="Hit, ailments and Shatter/Shock: this skill's whole output on its own button. Procs, summons and the weapon swing are not in it — the topbar's Total DPS is the figure that has everything."
        active={same(focus, { kind: "figure", id: "combined-dps" })}
        onSelect={pick({ kind: "figure", id: "combined-dps" })}
      />

      {/*
        The same question asked of every skill you actually press, which is what a rotation
        build is read by.

        Deliberately not the topbar's Total DPS: that adds your pets and the weapon swing, which
        are real and are not what you get for pressing these buttons. This is the rotation, the
        procs it sets off, and every ticked skill's ailments including its Shatters and Shocks.
        Absent when nothing is ticked, because then it would be Combined DPS printed twice.
      */}
      {fullDps !== undefined && fullDps.dps > 0 && (
        <Row
          label="Full DPS"
          statId="total_damage"
          value={smart(fullDps.dps + fullDps.ailmentDps)}
          strong
          hint={
            `Every skill ticked into Full DPS, cast once each per pass: ` +
            `${smart(fullDps.skillDps)} from the casts` +
            (fullDps.procDps > 0 ? `, ${smart(fullDps.procDps)} from what they proc` : "") +
            (fullDps.ailmentDps > 0 ? `, ${smart(fullDps.ailmentDps)} from their ailments` : "") +
            `. One pass is ${num(fullDps.rotationSeconds, 2)}s. Pets and the weapon swing are ` +
            `not in it; the topbar's Total DPS has those.`
          }
          active={same(focus, { kind: "figure", id: "full-dps" })}
          onSelect={pick({ kind: "figure", id: "full-dps" })}
        />
      )}

      {spend === undefined ? (
        <Row label="Cost" value="free" hint="This skill declares no mana or energy cost." />
      ) : (
        <>
          <Row
            label={`${statName(snapshot, spend.pool)} cost`}
            statId={spend.pool}
            value={smart(spend.perCast)}
            hint="Per cast, with every linked support gem's cost multiplier applied."
            active={same(focus, { kind: "figure", id: "cost" })}
            onSelect={pick({ kind: "figure", id: "cost" })}
          />
          <Row
            indent
            label="Cost per second"
            value={`${smart(spend.perSecond)}/s`}
            hint={
              cost.sustainable
                ? "Sustained casting. Your regeneration covers it."
                : "Sustained casting — more than your regeneration covers, so this rate is not one you can hold."
            }
            tone={cost.sustainable ? undefined : "bad"}
            active={same(focus, { kind: "figure", id: "cost-rate" })}
            onSelect={pick({ kind: "figure", id: "cost-rate" })}
          />
        </>
      )}
    </div>
  );
}

/** Strength, Intelligence, Dexterity — read straight off the sheet. */
function Attributes({ focus, pick }: { focus: SheetFocus | null; pick: Pick }): ReactNode {
  return (
    <div className="vitals-group">
      <div className="vitals-title">Attributes</div>
      <StatRowOf statId="strength" focus={focus} pick={pick} />
      <StatRowOf statId="intelligence" focus={focus} pick={pick} />
      <StatRowOf statId="dexterity" focus={focus} pick={pick} />
    </div>
  );
}

/**
 * What it takes to kill you, pools first and mitigation after.
 *
 * Effective HP leads because it is the only defensive figure that answers the question on its
 * own: armour, resists and dodge are all terms in it, and a build is compared on the total.
 *
 * **The five per-element rows fold up under it**, and default to folded. They are the terms of
 * the number above them rather than five more figures, and expanded they were a third of the
 * block's height for a comparison most edits do not change — five rows that move together are
 * one row unless you are asking which is worst, and the headline already says which. Open once
 * and it stays open for the session.
 */
function Survival({
  derived,
  focus,
  pick,
}: {
  derived: DerivedBuild;
  focus: SheetFocus | null;
  pick: Pick;
}): ReactNode {
  const { defence, resources, dps, selfSustain } = derived;
  const [showElements, setShowElements] = useState(false);

  /**
   * The pool this character actually runs on.
   *
   * Taken from what the main skill spends, because that is what "main resource" means to a
   * player: a blood mage's mana pool is real and irrelevant. With no skill to ask, the largest
   * of mana and energy stands in — a build whose energy pool is 4,000 and whose mana is 40 is a
   * weapon-skill build whether or not it has chosen a skill yet.
   */
  const spentAs =
    dps === undefined
      ? undefined
      : dps.cost.manaPerCast > 0
        ? dps.cost.manaSpentAs
        : dps.cost.energyPerCast > 0
          ? dps.cost.energySpentAs
          : undefined;
  const pools = resources.byResource.filter((r) => r.resource !== "health" && r.resource !== "magic_shield");
  const main =
    pools.find((r) => r.resource === spentAs) ??
    [...pools].sort((a, b) => b.max - a.max)[0];

  const magicShield = resources.byResource.find((r) => r.resource === "magic_shield");
  const health = resources.byResource.find((r) => r.resource === "health");

  return (
    <div className="vitals-group">
      <div className="vitals-title">Survival</div>

      <Row
        label="Effective HP"
        statId="health"
        value={smart(defence.weakest.effectiveHealth)}
        strong
        caret={showElements ? "open" : "closed"}
        hint={`Against ${defence.weakest.element}, which is what actually kills you: the pool divided by the share of a hit that gets through. Click the arrow for the other four.`}
        active={same(focus, { kind: "figure", id: "ehp" })}
        onSelect={pick({ kind: "figure", id: "ehp" })}
        onToggle={() => setShowElements((v) => !v)}
      />

      {/* Per element, in `Elements.getAllSingle()` order — the same order the resists below are
          in, so the two lists read as one table with a gap in the middle. */}
      {showElements &&
        orderedElements(defence.byElement).map((entry) => (
          <Row
            key={entry.element}
            indent
            label={elementLabel(entry.element)}
            colour={elementColour(entry.element)}
            value={smart(entry.effectiveHealth)}
            tone={entry.element === defence.weakest.element ? "bad" : undefined}
            hint={`${num(entry.taken * 100, 2)}% of a ${entry.element} hit reaches your pools.`}
            active={same(focus, { kind: "ehp", element: entry.element })}
            onSelect={pick({ kind: "ehp", element: entry.element })}
          />
        ))}

      {/*
        The other defensive headline, and the one a one-shot is measured against.

        Effective HP has dodge and block folded in as expectation, which is the right shape for
        "damage taken over a fight" and the wrong one for "the boss slam that killed me" — you
        cannot spend a 50% dodge chance on one particular hit. So this is the same pools through
        mitigation alone. The gap between the two rows is how much of the build's defence is luck,
        which is why they sit together and why the hint names the gap when there is one.
      */}
      <Row
        label="Maximum hit"
        statId="dmg_reduction"
        value={smart(defence.mostFragile.maximumHit)}
        strong
        tone={avoidanceGap(defence) > 0.05 ? "bad" : undefined}
        hint={
          `The largest single ${defence.mostFragile.element} hit you survive from full, with ` +
          `every dodge and block roll assumed to fail. ` +
          (avoidanceGap(defence) > 0.005
            ? `Your effective HP is ${num((1 / (1 - avoidanceGap(defence))) * 100 - 100, 0)}% higher than this because avoidance is averaged into it — that share of your defence is luck.`
            : `The same as your effective HP, because nothing in this build avoids hits.`)
        }
        active={same(focus, { kind: "figure", id: "max-hit" })}
        onSelect={pick({ kind: "figure", id: "max-hit" })}
      />

      {showElements &&
        orderedElements(defence.byElement).map((entry) => (
          <Row
            key={`max-${entry.element}`}
            indent
            label={elementLabel(entry.element)}
            colour={elementColour(entry.element)}
            value={smart(entry.maximumHit)}
            tone={entry.element === defence.mostFragile.element ? "bad" : undefined}
            hint={`${num(entry.takenUnavoided * 100, 2)}% of a ${entry.element} hit reaches your pools once avoidance has failed.`}
            active={same(focus, { kind: "max-hit", element: entry.element })}
            onSelect={pick({ kind: "max-hit", element: entry.element })}
          />
        ))}

      <StatRowOf statId="health" focus={focus} pick={pick} />
      {/*
        Health regeneration, under Health, for the same reason the other two pools have one: it
        is a term of the row above it. It was the one pool without it, and it is the pool that
        pays for self-damage — so the block could show a 646/s drain on the Damage tab with
        nothing anywhere to set it against.
      */}
      {health !== undefined && (
        <Row
          indent
          label="Regeneration"
          value={`${num(health.inCombatPerSecond, 2)}/s`}
          hint={
            `${num(health.perSecond, 2)}/s out of combat` +
            (health.secondsToFull === undefined
              ? ", and it never fills from empty"
              : `, ${num(health.secondsToFull, 1)}s from empty to full`) +
            (health.note === undefined ? "." : ` — ${health.note}`)
          }
          active={same(focus, { kind: "stat", statId: "health_regen" })}
          onSelect={pick({ kind: "stat", statId: "health_regen" })}
        />
      )}

      {main !== undefined && (
        <>
          <StatRowOf statId={main.resource} focus={focus} pick={pick} value={smart(main.max)} />
          <Row
            indent
            label="Regeneration"
            value={`${num(main.perSecond, 2)}/s`}
            hint={
              `${num(main.inCombatPerSecond, 2)}/s in combat` +
              (main.secondsToFull === undefined
                ? ", and it never fills from empty"
                : `, ${num(main.secondsToFull, 1)}s from empty to full`) +
              (main.note === undefined ? "." : ` — ${main.note}`)
            }
            active={same(focus, { kind: "stat", statId: `${main.resource}_regen` })}
            onSelect={pick({ kind: "stat", statId: `${main.resource}_regen` })}
          />
        </>
      )}

      <StatRowOf
        statId="magic_shield"
        focus={focus}
        pick={pick}
        value={smart(defence.pools.magicShield)}
      />
      {magicShield !== undefined && (
        <Row
          indent
          label="Regeneration"
          value={`${num(magicShield.perSecond, 2)}/s`}
          hint={`${num(magicShield.inCombatPerSecond, 2)}/s in combat.`}
          active={same(focus, { kind: "stat", statId: "magic_shield_regen" })}
          onSelect={pick({ kind: "stat", statId: "magic_shield_regen" })}
        />
      )}

      {/*
        What your own skill is doing to you, set against the two regenerations in the order the
        game spends them.

        Only present for a build that takes self-damage — four auras and ten spells — and it sits
        directly under the pools because that is what it is about. The shield pays first because
        the shield is hit first; health regeneration only ever sees what the shield could not
        cover, which is why the two are not simply added together.
      */}
      {selfSustain !== undefined && selfSustain.drainPerSecond > 0 && (
        <>
          <Row
            label="Self-damage"
            statId="health"
            value={`${smart(selfSustain.drainPerSecond)}/s`}
            strong
            tone={selfSustain.sustainable ? undefined : "bad"}
            hint={
              `What this skill costs you per second, after your own mitigation. It is not netted ` +
              `off your DPS — what you deal and what you pay are different questions.`
            }
            active={same(focus, { kind: "figure", id: "self-damage" })}
            onSelect={pick({ kind: "figure", id: "self-damage" })}
          />
          <Row
            indent
            label={selfSustain.sustainable ? "Covered by regeneration" : "Not covered"}
            value={
              selfSustain.sustainable
                ? `${smart(selfSustain.fromShieldRegen)} + ${smart(selfSustain.fromHealthRegen)}/s`
                : `−${smart(selfSustain.netLossPerSecond)}/s`
            }
            tone={selfSustain.sustainable ? undefined : "bad"}
            hint={
              `Magic shield regeneration pays first because the shield is hit first: ` +
              `${smart(selfSustain.fromShieldRegen)}/s of it. Health regeneration pays the ` +
              `${smart(selfSustain.reachingHealth)}/s that reaches it, up to ` +
              `${smart(selfSustain.fromHealthRegen)}/s.` +
              (selfSustain.sustainable
                ? " Between them they cover it, so you can hold this indefinitely."
                : ` Neither covers the last ${smart(selfSustain.netLossPerSecond)}/s.`)
            }
          />
          {!selfSustain.sustainable && (
            <Row
              indent
              label={selfSustain.secondsToCutoff === undefined ? "Dead in" : "Aura drops in"}
              value={`${num(selfSustain.secondsToCutoff ?? selfSustain.secondsToDeath, 1)}s`}
              tone="bad"
              hint={
                selfSustain.secondsToCutoff === undefined
                  ? "From full health and magic shield, with nothing else hitting you."
                  : `This effect takes itself off at a quarter of your combined health and magic ` +
                    `shield rather than killing you, so this is when it goes out. You would be ` +
                    `dead in ${num(selfSustain.secondsToDeath, 1)}s if it did not.`
              }
            />
          )}
        </>
      )}

      <StatRowOf statId="armor" focus={focus} pick={pick} />
      <StatRowOf statId="physical_resist" focus={focus} pick={pick} />
      <StatRowOf statId="dodge" focus={focus} pick={pick} />
      <StatRowOf statId="dmg_reduction_chance" focus={focus} pick={pick} />
      <StatRowOf statId="block_chance" focus={focus} pick={pick} />

      {SINGLE_ELEMENTS.filter((e) => e.guid !== "physical").map((element) => {
        const statId = RESIST_OF[element.guid];
        if (statId === undefined) return null;
        return <StatRowOf key={statId} statId={statId} focus={focus} pick={pick} />;
      })}

      <StatRowOf statId="move_speed" focus={focus} pick={pick} />
    </div>
  );
}

/**
 * One sheet stat, named and formatted the way the sheet names and formats it.
 *
 * Through `statName` and the engine's own `usableValue` rather than a label typed here, so a row
 * in this block and the same row on the Stats tab cannot print two different numbers.
 *
 * **A stat nothing granted still renders, at 0.** The engine's map holds only the stats
 * something touched, so a character with no block chance has no `block_chance` entry at all —
 * and on a fixed, chosen list of rows like this one, a row that disappears reads as a row that
 * was forgotten. "Block chance: 0" is the answer to the question; silence is not. That rule is
 * the opposite of `StatList`'s, where the list is exhaustive and hiding the zeroes is the only
 * thing that makes it readable.
 */
function StatRowOf({
  statId,
  focus,
  pick,
  value: override,
}: {
  statId: string;
  focus: SheetFocus | null;
  pick: Pick;
  /** For the pools, whose maximum is a defence-pass figure rather than the raw stat. */
  value?: string;
}): ReactNode {
  const { snapshot } = useWorld();
  const derived = useDerived();
  const stat = derived.stats.get(statId);

  // A resist's raw value is already a percentage, so the parenthetical needs its own sign: the
  // row read `75.00% (120)` and the 120 looked like a rating rather than the 120% resistance it
  // is. See `usable`.
  const rawIsPercent = statDisplay(snapshot, statId).isPerc;

  const value =
    override ??
    (stat === undefined
      ? smart(0)
      : stat.usableValue === undefined
        ? smart(stat.value)
        : usable(stat.usableValue, stat.value, rawIsPercent));

  return (
    <Row
      label={statName(snapshot, statId)}
      statId={statId}
      value={value}
      hint={
        stat === undefined
          ? `${statId} — nothing in this build grants it`
          : stat.usableValue === undefined
            ? statId
            : `${smart(stat.usableValue)}% ${USABLE_NOUN[statId] ?? "effective"} — ${statId}` +
              (rawIsPercent && stat.value > stat.usableValue + 0.5
                ? `. ${smart(stat.value)}% is granted; everything past ${smart(stat.usableValue)}% is over the cap and does nothing until something raises it.`
                : "")
      }
      active={same(focus, { kind: "stat", statId })}
      onSelect={pick({ kind: "stat", statId })}
    />
  );
}

function Row({
  label,
  statId,
  colour,
  value,
  hint,
  strong = false,
  indent = false,
  tone,
  active = false,
  caret,
  onSelect,
  onToggle,
}: {
  label: string;
  /** Draws the pack's icon for this stat, and tints the label with the stat's colour. */
  statId?: string;
  /** For a row that is not a stat but still has a colour of its own — a per-element figure. */
  colour?: string | undefined;
  value: string;
  hint?: string;
  /** A figure the rows around it are terms of — effective HP, combined DPS. */
  strong?: boolean;
  /** A term of the row above it: per-element EHP, a regeneration rate. */
  indent?: boolean;
  // Explicitly nullable: under `exactOptionalPropertyTypes` a caller computing `bad` from a
  // condition hands down `"bad" | undefined`, and "no tone" and "tone not mentioned" mean the
  // same thing here.
  tone?: "bad" | undefined;
  /** The row whose detail is open, so the sidebar says what the window below it is about. */
  active?: boolean;
  /** A disclosure triangle, for a row that folds the rows under it away. */
  caret?: "open" | "closed";
  onSelect?: () => void;
  /**
   * What the caret does, which is deliberately not what the row does.
   *
   * Effective HP both opens a breakdown and folds five rows away, and those are two different
   * intentions — one arrow, one row, and the arrow stops the click from reaching the row.
   */
  onToggle?: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  /*
   * A label is tinted only where its stat has an identity of its own.
   *
   * `statLook` returns `var(--text)` for a stat nothing has an opinion about, which is most of
   * them, and painting forty rows in forty colours would be the same as painting none: the
   * colour has to mean "this is the fire one" for it to be worth anything. So an explicit
   * colour wins and everything else stays at the row's own dim, where the value leads.
   */
  const identity = statId === undefined ? undefined : statLook(snapshot, statId).colour;
  const tint = colour ?? (identity === "var(--text)" ? undefined : identity);

  return (
    <div
      className={
        `vitals-row${strong ? " strong" : ""}${indent ? " indent" : ""}` +
        `${onSelect ? " pick" : ""}${active ? " active" : ""}`
      }
      title={hint}
      onClick={onSelect}
    >
      {caret !== undefined && (
        <span
          className="vitals-caret"
          title={caret === "open" ? "Hide the per-element figures" : "Show every element"}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
        >
          {caret === "open" ? "▾" : "▸"}
        </span>
      )}
      {statId !== undefined && <StatIcon statId={statId} size={13} />}
      <span className="vitals-label ellipsis" style={tint === undefined ? undefined : { color: tint }}>
        {label}
      </span>
      <span className={`vitals-value${tone === "bad" ? " bad" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * How much of the headline effective HP is avoidance rather than mitigation.
 *
 * `1 - taken/takenUnavoided` on the element the two figures are each reported for. Zero for a
 * character with no dodge and no block, which is most early builds and no late one.
 */
function avoidanceGap(defence: DerivedBuild["defence"]): number {
  const row = defence.mostFragile;
  if (row.takenUnavoided <= 0) return 0;
  return Math.max(0, 1 - row.taken / row.takenUnavoided);
}

/** The defence pass's own list, put into `Elements.getAllSingle()` order. */
function orderedElements<T extends { element: ElementName }>(entries: readonly T[]): T[] {
  const rank = new Map(SINGLE_ELEMENTS.map((e, i) => [e.name, i]));
  return [...entries].sort(
    (a, b) => (rank.get(a.element) ?? 99) - (rank.get(b.element) ?? 99),
  );
}

