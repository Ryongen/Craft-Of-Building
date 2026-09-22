/**
 * Where a figure came from — the window that opens under the sidebar and under the Stats tab.
 *
 * The sheet could already do this for a *stat*: click `fire_resist` and the drill-down names
 * every item, perk and aura that fed it. Half the sidebar is not stats, though. A hit, a cast
 * rate, a crit multiplier, the DPS figures, the resource budget and effective HP are all
 * produced by the damage and defence passes, and every one of them was a number with nothing
 * behind it: clickable rows sat beside unclickable ones with no rule saying which was which.
 *
 * So this is the other half. Each figure states the arithmetic that produced it, with the terms
 * as rows, and every term that *is* a stat is itself clickable — so "why is my DPS that" walks
 * down to "because `cast_speed` is 43%" and then to "because of this ring".
 *
 * ## The crit chance case, specifically
 *
 * Crit chance was the complaint that started this, and it is a scope bug rather than a missing
 * panel. `simulateHit` reads `critical_hit` off the **spell's** stat unit, and a support gem
 * writes into that unit and nowhere else; the sidebar's row opened the *character* breakdown,
 * which is a different number that no gem is in. The row now opens the skill-scoped breakdown —
 * see `StatBreakdown`'s `scope` — so the gem that is actually responsible is the first thing
 * under it.
 */

import { spellName, statName, type ElementName } from "@cte2/schema";
import type { ReactNode } from "react";

import { damageRates } from "../../state/compare.js";
import { useDerived, type DerivedBuild } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { num, smart } from "../../ui/format.js";
import { elementLabel } from "../../ui/palette.js";
import { StepRow } from "../../ui/StepRow.js";
import { formatStep, layerLabel } from "../../ui/trace-format.js";
import { StatBreakdown } from "./StatBreakdown.js";

/**
 * The figures that are not stats, by id.
 *
 * A closed union rather than a string, because every one of them needs a hand-written
 * explanation and a typo would silently render an empty panel.
 */
export type FigureId =
  | "hit"
  /** The pool a Shatter or a Shock releases — the build's second, larger hit. */
  | "ailment-hit"
  | "rate"
  | "crit-multi"
  /** The share of this skill's hits the target does not dodge. */
  | "hit-chance"
  | "hit-dps"
  | "ailment-dps"
  /** The Shatter/Shock share of the ailment clock, which behaves nothing like a DoT. */
  | "ailment-proc-dps"
  | "combined-dps"
  /** The whole ticked rotation with its procs and ailments — no pets, no weapon swing. */
  | "full-dps"
  | "cost"
  | "cost-rate"
  /** What your own skill charges you, against the two regenerations that pay for it. */
  | "self-damage"
  | "ehp"
  /** The largest single hit survived, with every avoidance roll assumed to fail. */
  | "max-hit"
  /** The topbar's headline figure: the rotation, its procs, its ailments, pets and the swing. */
  | "total-dps";

/**
 * What the detail window is showing.
 *
 * `stat` is the character sheet, `skill-stat` is the main skill's own unit, and `figure` is
 * something the pipeline produced rather than a stat at all. Threaded as one value because the
 * sidebar and the Stats tab both hold exactly one of these and both have to be able to clear it.
 */
export type SheetFocus =
  | { kind: "stat"; statId: string }
  | { kind: "skill-stat"; statId: string }
  | { kind: "figure"; id: FigureId }
  /** Effective HP against one element, which is a defence-pass row rather than a stat. */
  | { kind: "ehp"; element: ElementName }
  /** The same element's maximum hit — the unavoided half of the same pair. */
  | { kind: "max-hit"; element: ElementName };

export function SheetDetail({
  focus,
  onFocus,
}: {
  focus: SheetFocus;
  onFocus: (focus: SheetFocus | null) => void;
}): ReactNode {
  const derived = useDerived();
  const select = (statId: string): void => onFocus({ kind: "stat", statId });

  // Switching sheets keeps the stat and changes only which unit it is read on, which is exactly
  // what the two banners inside the breakdown offer.
  if (focus.kind === "stat" || focus.kind === "skill-stat") {
    const statId = focus.statId;
    return (
      <StatBreakdown
        statId={statId}
        scope={focus.kind === "skill-stat" ? "skill" : "character"}
        onSelect={select}
        onScope={(scope) =>
          onFocus({ kind: scope === "skill" ? "skill-stat" : "stat", statId })
        }
      />
    );
  }
  if (focus.kind === "ehp" || focus.kind === "max-hit") {
    return (
      <ElementDetail
        element={focus.element}
        unavoided={focus.kind === "max-hit"}
        derived={derived}
      />
    );
  }
  return <FigureDetail id={focus.id} derived={derived} onFocus={onFocus} />;
}

/** The heading every figure panel shares, so the window reads the same whatever is in it. */
function Detail({
  title,
  lead,
  children,
}: {
  title: string;
  /** One sentence on what the figure is. Never the arithmetic — that is the rows. */
  lead: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="breakdown">
      <div className="row mb-3">
        <strong className="grow ellipsis">{title}</strong>
        <span className="badge">derived figure</span>
      </div>
      <p className="muted text-sm mt-0 mb-4 selectable prose">{lead}</p>
      {children}
    </div>
  );
}

/** One term of a figure. `onSelect` is what turns a term into the next question. */
function Term({
  label,
  value,
  hint,
  strong = false,
  onSelect,
}: {
  label: ReactNode;
  value: string;
  hint?: string | undefined;
  strong?: boolean;
  onSelect?: (() => void) | undefined;
}): ReactNode {
  return (
    <StepRow
      label={strong ? <strong>{label}</strong> : label}
      value={value}
      {...(hint === undefined ? {} : { title: hint })}
      {...(onSelect === undefined ? {} : { onClick: onSelect })}
    />
  );
}

/**
 * One element's two survival figures — whichever of them was asked for.
 *
 * The same component for both because they are the same arithmetic over two different sweeps,
 * and showing them side by side is the point: the difference between them is the share of your
 * defence that is a dice roll.
 */
function ElementDetail({
  element,
  unavoided,
  derived,
}: {
  element: ElementName;
  /** The maximum hit rather than the average — avoidance assumed to fail. */
  unavoided: boolean;
  derived: DerivedBuild;
}): ReactNode {
  const row = derived.defence.byElement.find((e) => e.element === element);
  const name = elementLabel(element);
  const title = unavoided ? `Maximum hit — ${name}` : `Effective HP — ${name}`;
  if (row === undefined) {
    return <Detail title={title} lead="The defence pass reported nothing for this element." />;
  }

  const luck = row.takenUnavoided > 0 ? 1 - row.taken / row.takenUnavoided : 0;

  return (
    <Detail
      title={title}
      lead={
        unavoided
          ? `The largest single ${name.toLowerCase()} hit that does not kill you from full, with every dodge and block roll assumed to fail. Mitigation still applies — armour, the resists and flat reduction are not rolls.`
          : `Raw ${name.toLowerCase()} damage you survive from full, on average: the pool divided by the share of a hit that reaches it. Dodge and block are folded in as expectation, which is what makes this an average rather than a guarantee.`
      }
    >
      <div className="steps">
        <Term
          label="Pool"
          value={smart(row.pool)}
          hint="Health plus magic shield, except against chaos — chaos bypasses the shield, which is why its pool is smaller."
        />
        <Term
          label={unavoided ? "Share that gets through, unavoided" : "Share of a hit that gets through"}
          value={`${num((unavoided ? row.takenUnavoided : row.taken) * 100, 2)}%`}
          hint="After every mitigation layer. 100% means nothing stops it."
        />
        <Term
          label={unavoided ? "Maximum hit" : "Effective HP"}
          value={smart(unavoided ? row.maximumHit : row.effectiveHealth)}
          strong
        />
      </div>

      {luck > 0.005 && (
        <>
          <div className="section-title">The other figure</div>
          <div className="steps">
            <Term
              label={unavoided ? "Effective HP (averaged)" : "Maximum hit (unavoided)"}
              value={smart(unavoided ? row.effectiveHealth : row.maximumHit)}
            />
            <Term
              label="Of your mitigation here, this much is a roll"
              value={`${num(luck * 100, 1)}%`}
              hint="Dodge zeroes a hit on a roll and block halves one on a roll. Averaged over a fight that is real damage prevented; against one particular hit it is nothing."
            />
          </div>
          <div className="muted text-sm mt-3 prose">
            A build can sit comfortably on the averaged figure and still be one unlucky slam from
            dead. Armour, the resists and flat reduction are in both numbers; dodge and block are
            only in the first.
          </div>
        </>
      )}

      <div className="faint text-sm mt-4 prose">
        The Defence tab takes the mitigation apart layer by layer, for both sweeps.
      </div>
    </Detail>
  );
}

function FigureDetail({
  id,
  derived,
  onFocus,
}: {
  id: FigureId;
  derived: DerivedBuild;
  onFocus: (focus: SheetFocus) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const { dps, damage } = derived;

  /*
   * The topbar's figure is answerable with no main skill at all — a build that only summons has
   * pets and no hit — so it is handled before the guard the skill figures need.
   */
  if (id === "total-dps") return <TotalDpsDetail derived={derived} onFocus={onFocus} />;
  if (id === "full-dps") return <FullDpsDetail derived={derived} onFocus={onFocus} />;

  if (dps === undefined || damage === undefined) {
    return <Detail title="No skill" lead="Nothing is set as the main skill, so there is no figure to take apart." />;
  }

  const stat = (statId: string): (() => void) => () => onFocus({ kind: "stat", statId });
  const onSkill = (statId: string): (() => void) => () => onFocus({ kind: "skill-stat", statId });
  const { rate, cost } = dps;
  const perSecond = rate.cycleSeconds > 0 ? 1 / rate.cycleSeconds : 0;
  const spell = spellName(snapshot, dps.spellId);

  switch (id) {
    case "hit":
      return (
        <Detail
          title={`Hit — ${spell}`}
          lead="What one landing press puts on the target, averaged across the crit branch and the non-crit one. This is a single damage source; a skill with several is summed on the Damage tab."
        >
          <div className="steps">
            <Term label="Non-crit" value={smart(damage.hit.total)} />
            <Term label="Crit" value={smart(damage.crit.total)} />
            <Term
              label="Crit chance"
              value={`${num(damage.critChance * 100, 2)}%`}
              hint="Off this skill's own stat unit, which is where support gems land. Click through."
              onSelect={onSkill("critical_hit")}
            />
            <Term label="Average" value={smart(damage.average.total)} strong />
          </div>

          <div className="section-title">How the non-crit hit was built</div>
          <HitTrace derived={derived} />
        </Detail>
      );

    case "rate":
      return (
        <Detail
          title={rate.channelled ? `Pulse rate — ${spell}` : `Cast rate — ${spell}`}
          lead={
            rate.channelled
              ? "A held channel re-arms itself every cast time and never goes through a cooldown, so this is the pulse interval rather than a cast-and-recover cycle."
              : "One cycle is the cast plus the recovery after it, because recovery starts when the cast finishes rather than alongside it. The rate is one over that."
          }
        >
          <div className="steps">
            <Term
              label="Casting"
              value={`${num(rate.castSeconds, 2)}s`}
              hint="cast_time_ticks, divided by your cast or attack speed."
              onSelect={stat(rate.channelled ? "cast_speed" : "attack_cast_speed")}
            />
            <Term
              label={rate.chargeBased ? "Charge regeneration" : "Recovery"}
              value={`${num(rate.cooldownSeconds, 2)}s`}
              hint={
                rate.chargeBased
                  ? "A charge spell's rate is how fast a charge comes back, not its cooldown — the game force-writes cooldown_ticks to 3 when charges are declared."
                  : rate.castSpeedBound
                    ? "Bound by cast speed rather than by the spell's own cooldown: getEffectiveCooldownTicks is max(cooldown_ticks, cast_speed_ticks)."
                    : "The spell's own cooldown, reduced by cdr."
              }
              onSelect={stat("cdr")}
            />
            {rate.castsPerCycle > 1 && (
              <Term
                label="Casts per cycle"
                value={String(rate.castsPerCycle)}
                hint="times_to_cast — one press fires the spell more than once."
              />
            )}
            {rate.globalCooldownSeconds > 0 && (
              <Term
                label="Global cooldown"
                value={`${num(rate.globalCooldownSeconds, 2)}s`}
                hint="Armed by this cast and shared with every other skill. It floors the cycle."
              />
            )}
            <Term label="Cycle" value={`${num(rate.cycleSeconds, 2)}s`} />
            <Term label="Rate" value={`${num(perSecond, 2)}/s`} strong />
          </div>
        </Detail>
      );

    case "crit-multi": {
      const multi = damage.hit.total > 0 ? damage.crit.total / damage.hit.total : 0;
      return (
        <Detail
          title={`Crit multiplier — ${spell}`}
          lead="What a crit is actually worth on this skill, measured rather than read off a stat: the crit branch divided by the non-crit one. Double damage and the conversion children are inside it, which is why it is not simply 1 + critical_damage."
        >
          <div className="steps">
            <Term label="Non-crit" value={smart(damage.hit.total)} />
            <Term label="Crit" value={smart(damage.crit.total)} />
            <Term label="Ratio" value={`${num(multi, 3)}×`} strong />
            <Term
              label={statName(snapshot, "critical_damage")}
              value="the stat behind it"
              hint="One input to a multiplicative layer, not the multiplier itself."
              onSelect={onSkill("critical_damage")}
            />
          </div>
        </Detail>
      );
    }

    case "hit-chance":
      return (
        <Detail
          title={`Chance to hit — ${spell}`}
          lead="The share of this skill's hits the target does not dodge — damage_block's multiplier. It is already folded into every damage figure, as expectation rather than as a roll, so this says how much of the number above is the miss."
        >
          <div className="steps">
            <Term
              label="Chance to hit"
              value={`${num(damage.hitChance * 100, 2)}%`}
              hint="1 wherever nothing can dodge the hit: dodge takes physical attacks and magic dodge takes magic spells."
              strong
            />
            <Term
              label="Missed"
              value={`${num((1 - damage.hitChance) * 100, 2)}%`}
              hint="The share of the damage above that never lands. The Damage tab's trace has the subtraction."
            />
            <Term
              label={statName(snapshot, "accuracy")}
              value="the stat behind it"
              hint="Your accuracy against the target's evasion rating."
              onSelect={stat("accuracy")}
            />
          </div>
        </Detail>
      );

    case "hit-dps":
      return (
        <Detail
          title={`Hit DPS — ${spell}`}
          lead="This skill on its own button, with nothing else pressed. Steady state: a cast's whole output is amortised over the cast interval however long it takes to arrive."
        >
          <div className="steps">
            <Term
              label="Damage per cast"
              value={smart(dps.damagePerCast)}
              hint="Every damage source this cast produces, not only the largest one."
              onSelect={() => onFocus({ kind: "figure", id: "hit" })}
            />
            <Term
              label="Cycle"
              value={`${num(rate.cycleSeconds, 2)}s`}
              onSelect={() => onFocus({ kind: "figure", id: "rate" })}
            />
            <Term label="Hit DPS" value={smart(dps.dps)} strong />
            {dps.persistentDps > 0 && (
              <Term
                label="of which outlives the cycle"
                value={smart(dps.persistentDps)}
                hint="Sources still dealing damage when the next cast starts. The Damage tab's Overlap card says how long the figure takes to become true."
              />
            )}
          </div>
        </Detail>
      );

    case "ailment-hit":
      return (
        <Detail
          title={`Ailment hit — ${spell}`}
          lead="Freeze and Electrify deal nothing when they land. Each one adds to a pool on the target, and a hit carrying Shatter or Shock chance releases the whole of it at once — so a cold build's real hit is this one, on its own schedule."
        >
          <div className="steps">
            <Term
              label="Hit that tips it"
              value={smart(damage.average.total)}
              hint="It lands as well. The two are separate events: `shatterAccumulated` fires an `EventBuilder.ofDamage` of its own."
              onSelect={() => onFocus({ kind: "figure", id: "hit" })}
            />
            <Term label="Pool released" value={smart(dps.ailmentHit)} />
            <Term label="Spike" value={smart(damage.average.total + dps.ailmentHit)} strong />
            <Term
              label="At this rate"
              value={`${smart(dps.ailmentProcDps)}/s`}
              onSelect={() => onFocus({ kind: "figure", id: "ailment-proc-dps" })}
            />
          </div>
          <div className="faint text-sm mt-4 prose">
            The pool is a leaking bucket: every freeze or electrify you inflict fills it, 10% a
            second drains away while it waits, and a proc empties it. So the figure depends on how
            fast you cast as well as on the two chances — a slow rotation has a smaller spike as
            well as a rarer one. The Damage tab lists what each ailment accumulates.
          </div>
        </Detail>
      );

    case "ailment-proc-dps":
      return (
        <Detail
          title={`Ailment hit DPS — ${spell}`}
          lead="What Shatter and Shock are worth per second: the pool you accumulate, times the share of it that reaches a proc instead of leaking away."
        >
          <div className="steps">
            <Term
              label="Pool per release"
              value={smart(dps.ailmentHit)}
              onSelect={() => onFocus({ kind: "figure", id: "ailment-hit" })}
            />
            <Term label="Shatter / Shock DPS" value={smart(dps.ailmentProcDps)} strong />
            <Term
              label="Ticking ailments beside it"
              value={`${smart(dps.ailmentDps - dps.ailmentProcDps)}/s`}
              onSelect={() => onFocus({ kind: "figure", id: "ailment-dps" })}
            />
          </div>
          <div className="faint text-sm mt-4 prose">
            Both halves are on the ailment clock and both are already inside Combined DPS. They
            are two rows because nothing else about them is alike: a DoT is a rate that is either
            up or not, and this is a pool that is either released or wasted, moved by{" "}
            <code>freeze_chance</code> and <code>freeze_proc_chance</code> rather than by{" "}
            <code>dot_speed</code>.
          </div>
        </Detail>
      );

    case "ailment-dps":
      return (
        <Detail
          title={`Ailment DPS — ${spell}`}
          lead="Bleed, ignite, poison and the rest, on their own clock. Never part of the hit and never part of Hit DPS — an ailment ticks whether or not you cast again."
        >
          <div className="steps">
            <Term label="Ailment DPS" value={smart(dps.ailmentDps - dps.ailmentProcDps)} strong />
            {dps.ailmentProcDps > 0 && (
              <Term
                label="Shatter / Shock, counted separately"
                value={`${smart(dps.ailmentProcDps)}/s`}
                hint="Same clock, nothing else in common. It has its own row."
                onSelect={() => onFocus({ kind: "figure", id: "ailment-proc-dps" })}
              />
            )}
            <Term
              label={statName(snapshot, "ailment_damage")}
              value="the stat behind it"
              onSelect={stat("ailment_damage")}
            />
          </div>
          <div className="faint text-sm mt-4 prose">
            The Damage tab lists them one by one, with the chance to apply and the duration each
            one rolled.
          </div>
        </Detail>
      );

    case "combined-dps":
      return (
        <Detail
          title={`Combined DPS — ${spell}`}
          lead="The hit plus its ailments — this skill's whole output while it is the only thing you press. Procs, summons and the weapon swing are not in it; the topbar's Total DPS is the figure that has everything."
        >
          <div className="steps">
            <Term
              label="Hit DPS"
              value={smart(dps.dps)}
              onSelect={() => onFocus({ kind: "figure", id: "hit-dps" })}
            />
            <Term
              label="Ailment DPS"
              value={smart(dps.ailmentDps - dps.ailmentProcDps)}
              onSelect={() => onFocus({ kind: "figure", id: "ailment-dps" })}
            />
            {dps.ailmentProcDps > 0 && (
              <Term
                label="Ailment hit DPS"
                value={smart(dps.ailmentProcDps)}
                hint="Shatter and Shock releasing what your freezes and electrifies accumulated."
                onSelect={() => onFocus({ kind: "figure", id: "ailment-proc-dps" })}
              />
            )}
            <Term label="Combined" value={smart(dps.dps + dps.ailmentDps)} strong />
            {dps.procDps > 0 && (
              <Term label="Procs (not counted here)" value={`${smart(dps.procDps)}/s`} />
            )}
            {dps.summonDps > 0 && (
              <Term label="Summons (not counted here)" value={`${smart(dps.summonDps)}/s`} />
            )}
          </div>
        </Detail>
      );

    case "self-damage": {
      const self = dps.selfDamage;
      const sustain = derived.selfSustain;
      if (self === undefined || sustain === undefined) {
        return <Detail title="No self-damage" lead="This skill charges you nothing to cast." />;
      }
      return (
        <Detail
          title={`Self-damage — ${spell}`}
          lead="A hit you inflict on yourself. It carries none of your own offence and cannot crit, and it cannot be dodged or blocked — but your mitigation still applies. It is never netted off your DPS."
        >
          <div className="steps">
            <Term
              label="Raw, per cast"
              value={smart(self.rawPerCast)}
              hint="The value calculation's own number, before anything of yours touches it."
            />
            <Term
              label="Mitigated"
              value={`${num(self.mitigated * 100, 1)}%`}
              hint="Your armour, your resists and your dmg_received. Increases to damage and crit do not apply — no_attacker_stats_on_selfdmg switches the attacker half of the sweep off — but mitigation does."
            />
            <Term label="You take, per cast" value={smart(self.perCast)} />
            <Term label="Drain" value={`${smart(sustain.drainPerSecond)}/s`} strong />
            <Term
              label="Magic shield regeneration pays"
              value={`${smart(sustain.fromShieldRegen)}/s`}
              hint="First, because the shield absorbs before health does. A build with no magic shield pays nothing from here, however much magic_shield_regen its gear rolls."
              onSelect={stat("magic_shield_regen")}
            />
            <Term
              label="Reaching health"
              value={`${smart(sustain.reachingHealth)}/s`}
              hint="The part of the drain the shield's regeneration could not cover."
            />
            <Term
              label="Health regeneration pays"
              value={`${smart(sustain.fromHealthRegen)}/s`}
              onSelect={stat("health_regen")}
            />
            <Term
              label="Net"
              value={sustain.sustainable ? "covered" : `−${smart(sustain.netLossPerSecond)}/s`}
              strong
              hint={
                sustain.sustainable
                  ? "The two regenerations between them cover it, so you can hold this indefinitely."
                  : "Your bar falls at this rate with nothing else hitting you."
              }
            />
          </div>
          {!sustain.sustainable && (
            <div className="notice">
              {sustain.secondsToCutoff === undefined
                ? `Dead in ${num(sustain.secondsToDeath, 1)}s from full, with nothing else hitting you.`
                : `This effect takes itself off at a quarter of your combined health and magic ` +
                  `shield rather than killing you, so it goes out after ` +
                  `${num(sustain.secondsToCutoff, 1)}s. Without that it would kill you in ` +
                  `${num(sustain.secondsToDeath, 1)}s.`}
            </div>
          )}
        </Detail>
      );
    }

    case "cost":
    case "cost-rate": {
      const mana = cost.manaPerCast > 0;
      const pool = mana ? cost.manaSpentAs : cost.energySpentAs;
      const perCast = mana ? cost.manaPerCast : cost.energyPerCast;
      const drain = mana ? cost.manaPerSecond : cost.energyPerSecond;
      const regen = mana ? cost.manaRegen : cost.energyRegen;
      const budget = cost.budget.find((row) => row.resource === pool);

      return (
        <Detail
          title={`${statName(snapshot, pool)} cost — ${spell}`}
          lead="What the spell declares, multiplied by every linked support gem's cost multiplier, then paced by how often you can press it."
        >
          <div className="steps">
            <Term
              label="Per cast"
              value={smart(perCast)}
              hint="mana_cost or ene_cost on the spell, times the product of the gems' manaMulti."
              onSelect={stat(mana ? "mana_cost" : "spirit_cost")}
            />
            <Term
              label="Cycle"
              value={`${num(rate.cycleSeconds, 2)}s`}
              onSelect={() => onFocus({ kind: "figure", id: "rate" })}
            />
            <Term label="Spent per second" value={`${smart(drain)}/s`} strong />
            <Term
              label="Regeneration, in combat"
              value={`${smart(regen)}/s`}
              hint="in_combat is a ten-second cooldown that every hit re-stamps, so a rotation never leaves it. Anything gated on being out of combat is worth nothing here."
              onSelect={stat(`${pool}_regen`)}
            />
            {budget !== undefined && (
              <Term
                label="Net"
                value={`${budget.netPerSecond >= 0 ? "+" : ""}${smart(budget.netPerSecond)}/s`}
                hint={
                  budget.sustainable
                    ? "Income covers the spend, so this rate is one you can hold."
                    : "More than your income, so this rate is not one you can hold."
                }
              />
            )}
          </div>
          {!cost.sustainable && (
            <div className="notice">
              Something in the ledger does not keep up. The Damage tab&apos;s Sustain card shows
              every pool with its leech, its cap and how long a full one lasts.
            </div>
          )}
        </Detail>
      );
    }

    case "ehp":
      return (
        <Detail
          title="Effective HP"
          lead={`The worst of the five elements, because that is what actually kills you — here, ${elementLabel(derived.defence.weakest.element)}. Expand the row to compare the others.`}
        >
          <div className="steps">
            {derived.defence.byElement.map((row) => (
              <Term
                key={row.element}
                label={elementLabel(row.element)}
                value={smart(row.effectiveHealth)}
                strong={row.element === derived.defence.weakest.element}
                hint={`${num(row.taken * 100, 2)}% of a raw hit reaches a pool of ${smart(row.pool)}.`}
                onSelect={() => onFocus({ kind: "ehp", element: row.element })}
              />
            ))}
          </div>
        </Detail>
      );

    case "max-hit": {
      const fragile = derived.defence.mostFragile;
      const luck =
        fragile.takenUnavoided > 0 ? 1 - fragile.taken / fragile.takenUnavoided : 0;
      return (
        <Detail
          title="Maximum hit"
          lead={`The largest single hit you survive from full with every avoidance roll failing — here a ${elementLabel(fragile.element)} one. Mitigation is in it; dodge and block are not, because you cannot spend a chance on one particular hit.`}
        >
          <div className="steps">
            {derived.defence.byElement.map((row) => (
              <Term
                key={row.element}
                label={elementLabel(row.element)}
                value={smart(row.maximumHit)}
                strong={row.element === fragile.element}
                hint={`${num(row.takenUnavoided * 100, 2)}% of a raw hit reaches a pool of ${smart(row.pool)} once avoidance has failed.`}
                onSelect={() => onFocus({ kind: "max-hit", element: row.element })}
              />
            ))}
          </div>

          {/*
            Named explicitly rather than left as a difference between two numbers on two rows.
            A build whose physical effective HP is twice its maximum physical hit is a build
            carrying half its physical defence on a dodge roll, and that is the finding.
          */}
          {luck > 0.005 ? (
            <div className="notice">
              <strong>{num(luck * 100, 0)}% of your mitigation against {elementLabel(fragile.element)} is a
              roll.</strong>{" "}
              Averaged over a fight that is real — your effective HP of{" "}
              {smart(fragile.effectiveHealth)} counts it. Against the one hit that kills you it is
              worth nothing, which is why this figure is {smart(fragile.maximumHit)}.
            </div>
          ) : (
            <div className="muted text-sm mt-3 prose">
              Nothing in this build avoids hits, so this figure and your effective HP are the same
              number. Dodge and block are what separate them.
            </div>
          )}

          <div className="steps mt-4">
            <Term
              label="Effective HP, for comparison"
              value={smart(derived.defence.weakest.effectiveHealth)}
              hint={`Against ${elementLabel(derived.defence.weakest.element)}, averaged.`}
              onSelect={() => onFocus({ kind: "figure", id: "ehp" })}
            />
          </div>
        </Detail>
      );
    }
  }
}

/**
 * What the topbar's headline number is made of.
 *
 * Five terms on four different clocks, and the reason to spell them out is that the composition
 * is not obvious and matters: a rotation already counts its own procs, so they are *not* added
 * again; summons are always the main skill's because `FullDpsResult` carries no summon term; and
 * the weapon swing is in it even for a build that never swings, at zero. `damageRates` is the
 * one function that decides all of this — the Compare tab prices every what-if through it — so
 * this reads its answer rather than re-adding the parts.
 */
/**
 * The rotation, taken apart: what the casts do, what they set off, what they leave burning.
 *
 * Deliberately narrower than Total DPS, which is the topbar's figure and adds the pets and the
 * weapon swing. Those are real and they are not what you get for pressing these buttons — a
 * player deciding which skills to tick is asking about the buttons.
 */
function FullDpsDetail({
  derived,
  onFocus,
}: {
  derived: DerivedBuild;
  onFocus: (focus: SheetFocus) => void;
}): ReactNode {
  const full = derived.fullDps;
  if (full === undefined || full.dps <= 0) {
    return (
      <Detail
        title="Full DPS"
        lead="Nothing is ticked into Full DPS, so there is no rotation to take apart. The checkbox is on each skill's card on the Skills tab."
      />
    );
  }

  const dots = full.ailmentDps - full.ailmentProcDps;

  return (
    <Detail
      title="Full DPS"
      lead={`Every skill ticked into Full DPS, cast once each per pass. One pass is ${num(full.rotationSeconds, 2)}s, paced by the casts themselves and by the longest cooldown among them.`}
    >
      <div className="steps">
        <Term
          label="Casts"
          value={smart(full.skillDps)}
          hint="The ticked skills' own hits, over the length of one pass."
        />
        {full.procDps > 0 && (
          <Term
            label="Procs"
            value={smart(full.procDps)}
            hint="Merged across the whole pass against one shared set of `proc_cooldown_ticks`, not added up per skill."
          />
        )}
        {dots > 0.005 && (
          <Term
            label="Ailments"
            value={smart(dots)}
            onSelect={() => onFocus({ kind: "figure", id: "ailment-dps" })}
          />
        )}
        {full.ailmentProcDps > 0 && (
          <Term
            label="Shatter / Shock"
            value={smart(full.ailmentProcDps)}
            onSelect={() => onFocus({ kind: "figure", id: "ailment-proc-dps" })}
          />
        )}
        <Term label="Full DPS" value={smart(full.dps + full.ailmentDps)} strong />
      </div>
      <div className="faint text-sm mt-4 prose">
        Your pets and the weapon swing are not in this. They are on clocks of their own and run
        whether or not you press anything, so they belong to the topbar&apos;s{" "}
        <span className="link-ish" onClick={() => onFocus({ kind: "figure", id: "total-dps" })}>
          Total DPS
        </span>{" "}
        rather than to what the rotation is worth. The Damage tab&apos;s Full DPS card lists the
        pass skill by skill.
      </div>
    </Detail>
  );
}

function TotalDpsDetail({
  derived,
  onFocus,
}: {
  derived: DerivedBuild;
  onFocus: (focus: SheetFocus) => void;
}): ReactNode {
  const rates = damageRates({
    dps: derived.dps,
    fullDps: derived.fullDps,
    basicDps: derived.basic?.dps ?? 0,
  });

  return (
    <Detail
      title="Total DPS"
      lead={
        rates.inRotation
          ? "Everything that lands while you play this build: the whole ticked rotation, its procs and ailments, your pets, and the weapon swing."
          : "Everything that lands while you press one button: your main skill, what it sets off, your pets, and the weapon swing. Tick more skills into Full DPS on the Skills tab to make this a rotation."
      }
    >
      <div className="steps">
        <Term
          label={rates.inRotation ? "Rotation" : "Main skill"}
          value={smart(rates.primaryDps)}
          hint={
            rates.inRotation
              ? "Every skill ticked into Full DPS, paced by the global cooldowns they arm. Its own procs are already inside it."
              : "The single skill the damage figures are about."
          }
          onSelect={() => onFocus({ kind: "figure", id: "hit-dps" })}
        />
        {!rates.inRotation && rates.procDps > 0 && (
          <Term
            label="Procs"
            value={smart(rates.procDps)}
            hint="Spells your gear casts for you while you press that button."
          />
        )}
        {rates.inRotation && rates.procDps > 0 && (
          <Term
            label="Procs — already counted"
            value={smart(rates.procDps)}
            hint="Inside the rotation figure above, not added to it. Shown so the sum below adds up on screen."
          />
        )}
        {rates.ailmentDps > 0 && (
          <Term
            label="Ailments"
            value={smart(rates.ailmentDps)}
            onSelect={() => onFocus({ kind: "figure", id: "ailment-dps" })}
          />
        )}
        {rates.summonDps > 0 && (
          <Term
            label="Summons"
            value={smart(rates.summonDps)}
            hint="Always the main skill's pets: the rotation figure has no summon term to read."
          />
        )}
        <Term
          label="Weapon swing"
          value={smart(rates.basicDps)}
          hint="Its own clock, and in this figure whether or not you ever press a skill. The Skills tab's basic attack is where its two inputs live."
        />
        <Term label="Total DPS" value={smart(rates.total)} strong />
      </div>
      <div className="faint text-sm mt-4 prose">
        The Damage tab takes the single skill apart layer by layer, and its Full DPS card lists
        the rotation skill by skill.
      </div>
    </Detail>
  );
}

/**
 * The mod's own damage log for the non-crit branch, one level deep.
 *
 * Deliberately not the Damage tab's expandable trace: that panel is lazily loaded and opening
 * the sidebar must not pull it in. What survives the shortening is the part that answers the
 * question — which layers touched the hit and by how much — and the tab is one click away for
 * the sources under each layer.
 */
function HitTrace({ derived }: { derived: DerivedBuild }): ReactNode {
  const { snapshot } = useWorld();
  const trace = derived.damage?.hit.trace;
  if (trace === undefined) return <div className="faint text-sm">No trace was recorded.</div>;

  return (
    <>
      <div className="steps">
        <StepRow label={<span className="muted">Base damage</span>} value={smart(trace.baseNumber)} />
        {trace.steps.map((step, index) => (
          <StepRow
            key={`${step.layerId}-${step.side}-${index}`}
            label={
              <>
                <span className="faint">[{step.side}] </span>
                {layerLabel(snapshot, step, trace.element)}
              </>
            }
            value={formatStep(step)}
          />
        ))}
        {trace.moreMultis.map((more, index) => (
          <StepRow
            key={`${more.statId}-${index}`}
            label={statName(snapshot, more.statId)}
            value={`x${num(more.multi, 3)}`}
            tone="warn"
          />
        ))}
        <StepRow label={<strong>Final</strong>} value={smart(trace.finalNumber)} />
      </div>
      <div className="faint text-sm mt-3 prose">
        These are the rows the mod&apos;s own damage log prints. The Damage tab opens each one
        into the stats that fed it, and each of those into the item, perk, gem or aura behind it.
      </div>
    </>
  );
}
