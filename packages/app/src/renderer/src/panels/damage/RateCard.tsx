import { type DpsResult, type EngineResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { Fact } from "../../ui/Fact.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

/**
 * The rate.
 *
 * Every number here is portable from the mod, and since 6.4.13 most of it comes from
 * `cast_speed_ticks` rather than the spell's declared cooldown — a spell can say
 * `cooldown_ticks: 0` and still only go off every 15 ticks, because casting it arms the shared
 * global cooldown for its cast speed. What a cast *produces* is the table below this.
 */
export function RateCard({ dps }: { dps: DpsResult }): ReactNode {
  const { rate, calc, declared, multiHit, cost } = dps;

  return (
    <div className="card">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        <Figure
          label="DPS"
          value={smart(dps.dps)}
          hint="Every damage source this cast produces, weighted by how much of each reaches the target, divided by the cast cycle"
        />
        <Figure label="Crit DPS" value={smart(dps.critDps)} hint="The same with crit pinned" />
        {/* The DoTs alone, so the label means what the sidebar's label means. Freeze and
            Electrify are on the same clock and are a pool released in one spike rather than a
            tick, which is a different thing to plan around — hence the figure beside it. */}
        {dps.ailmentDps - dps.ailmentProcDps > 0.005 && (
          <Figure
            label="Ailment DPS"
            value={smart(dps.ailmentDps - dps.ailmentProcDps)}
            hint={
              "Bleed, burn and poison at full stacks. Every hit adds a stack with its own duration. " +
              dps.ailmentStacks.map((s) => `${s.ailment}: ${num(s.stacks, 1)} stacks`).join(", ") +
              ". Separate from hit rate because they tick on their own timer."
            }
          />
        )}
        {dps.ailmentProcDps > 0 && (
          <Figure
            label="Ailment hit DPS"
            value={smart(dps.ailmentProcDps)}
            hint={`Shatter and Shock releasing what your freezes and electrifies accumulated: a pool of ${smart(dps.ailmentHit)} per release, at the rate you set it off`}
          />
        )}
        <Figure
          label="Per cast"
          value={smart(dps.damagePerCast)}
          hint="What one cast puts on the target, across every source"
        />
        <Figure
          label="Cycle"
          value={`${num(rate.cycleSeconds, 2)}s`}
          hint="Cast time plus recovery. Recovery starts after the cast finishes"
        />
      </div>

      <div className="row wrap gap-8 mt-5 text-sm">
        <Fact label="Cast" value={`${calc.castTicks}t`} was={declared.castTimeTicks} />
        <Fact
          label={rate.chargeBased ? "Charge regen" : "Recovery"}
          value={`${rate.chargeBased ? calc.chargeCooldownTicks : calc.effectiveCooldownTicks}t`}
          was={rate.chargeBased ? declared.chargeRegenTicks : declared.cooldownTicks}
        />
        {!calc.offGlobalCooldown && (
          <Fact
            label="Cast speed"
            value={`${num(calc.castSpeedTicks, 1)}t`}
            was={declared.castSpeedTicks}
          />
        )}
        <Fact label="Casts per cycle" value={String(rate.castsPerCycle)} />
        {multiHit.projectiles > 0 && (
          <Fact
            label="Projectiles"
            value={String(multiHit.projectiles)}
            was={multiHit.baseProjectiles}
            sources={contributorsTo(dps.hit.sheets.spell, "projectile_count")}
          />
        )}
        {multiHit.chains > 0 && <Fact label="Chains" value={String(multiHit.chains)} />}
        {multiHit.nova && <span className="badge">nova</span>}
        {multiHit.barrage && <span className="badge">barrage</span>}
        {multiHit.pierce && <span className="badge">pierce</span>}
        {calc.offGlobalCooldown ? (
          <span className="badge">off global cooldown</span>
        ) : (
          rate.castSpeedBound && <span className="badge warn">paced by cast speed</span>
        )}
        {dps.persistentDps > 0 && (
          <Fact
            label="Persistent"
            value={`${smart(dps.persistentDps)}/s`}
          />
        )}
      </div>

      {calc.castSpeedPercent !== 0 && (
        <div className="row wrap gap-5 mt-4 text-sm">
          <>
          <Plain>
            <span className="faint" style={{ maxWidth: 680 }}>
              Your cast speed stats total {num(calc.castSpeedPercent, 1)}%, which speeds up both spell casting and global cooldowns by a factor of {num(calc.speedMulti, 3)}. Every school-specific cast speed stat and general skill speed feed into this single value.
            </span>
          </Plain>
          <Tech>
            <span className="faint" style={{ maxWidth: 680 }}>
              Cast speed stats total {num(calc.castSpeedPercent, 1)}%, which divides both the cast
              and the global cooldown arm by {num(calc.speedMulti, 3)}. All 40 of the pack&apos;s
              <code> *_cast_time </code> stats and <code>skill_speed</code> land in the same number.
            </span>
          </Tech>
          </>
        </div>
      )}

      {dps.requires.length > 0 && (
        <div className="row wrap mt-4 text-sm">
          <span className="badge warn">requires {dps.requires.join(", ")}</span>
          <span className="faint" style={{ maxWidth: 620 }}>
            This skill does nothing without that effect. The figure above assumes it is up; tick
            the skill that applies it into Full DPS to pay for the cast that puts it there.
          </span>
        </div>
      )}

      {(cost.manaPerCast > 0 || cost.energyPerCast > 0) && (
        <div className="row wrap gap-8 mt-5 text-sm">
          {cost.manaPerCast > 0 && (
            <Fact
              label={cost.manaSpentAs === "blood" ? "Blood" : "Mana"}
              value={`${smart(cost.manaPerCast)}/cast · ${smart(cost.manaPerSecond)}/s`}
            />
          )}
          {cost.energyPerCast > 0 && (
            <Fact
              label={cost.energySpentAs === "blood" ? "Blood (energy)" : "Energy"}
              value={`${smart(cost.energyPerCast)}/cast · ${smart(cost.energyPerSecond)}/s`}
            />
          )}
          <span className={cost.sustainable ? "badge" : "badge warn"}>
            {cost.sustainable ? "sustainable" : "runs dry, see Sustain below"}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Which items, buffs and perks fed one stat, read off the spell unit's own contexts.
 *
 * Projectile count is the case that needs it: a build gets its extra projectiles from several
 * unrelated places at once — a unique weapon, a self-buff whose own strength is scaled by the
 * capture&apos;s `strMulti` — and "9 projectiles" with nothing behind it looks like a number the
 * engine invented. `calculate` already records every write with its source; this only reads it.
 */

/**
 * Which items, buffs and perks fed one stat, read off the spell unit's own contexts.
 *
 * Projectile count is the case that needs it: a build gets its extra projectiles from several
 * unrelated places at once — a unique weapon, a self-buff whose own strength is scaled by the
 * capture&apos;s `strMulti` — and "9 projectiles" with nothing behind it looks like a number the
 * engine invented. `calculate` already records every write with its source; this only reads it.
 */
function contributorsTo(run: EngineResult | undefined, statId: string): { source: string; value: number }[] {
  const out: { source: string; value: number }[] = [];
  for (const context of run?.contexts ?? []) {
    let total = 0;
    for (const mod of context.stats) {
      if (mod.statId === statId) total += mod.value;
    }
    if (total !== 0) out.push({ source: context.source, value: total });
  }
  return out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/** One event: the hit itself, or a bonus element spawned by conversion. */
