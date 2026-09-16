/**
 * One hit, the rate around it, and how both were arrived at.
 *
 * The breakdown mirrors the mod's own damage log — `DamageEvent.getInfoHoverMessage`, which a
 * player sees by turning on the `damage_messages` config — row for row: base damage, then each
 * layer in priority order with its side, then the named MORE multipliers, then the final
 * number, then a nested block per bonus element. Matching it is deliberate: it makes a screen
 * here directly comparable to a hover in game, which is the cheapest ground truth this project
 * has.
 *
 * It goes one level further than the log does. `StatLayerData` in the game is a bare
 * accumulator, so "Additive Damage: x2.35" never says which of your stats made it 2.35; the
 * engine records the writes, so every layer row opens into the stats that fed it and each of
 * those into the item, perk, gem or aura it came from.
 *
 * Crit is a branch, not an average: `critical_damage` gates a multiplicative layer and
 * `double_damage` is clamped to exactly x2, so an expected-value crit is a number the game
 * never produces for either outcome. Hit and Crit each have a trace; Average is the weighted
 * mean of the two totals and says so.
 */

import { ELEMENTS } from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { spellName } from "@cte2/schema";

import { OverlapCard } from "./OverlapCard.js";
import { SourceTable } from "./SourceTable.js";
import { EffectsCard } from "./EffectsCard.js";
import { ModelGaps } from "./ModelGaps.js";
import { SummonTable } from "./SummonTable.js";
import { ProcTable } from "./ProcTable.js";
import { TargetCard } from "./TargetCard.js";
import { FullDpsCard } from "./FullDpsCard.js";
import { SustainCard } from "./SustainCard.js";
import { SelfDamageCard } from "./SelfDamageCard.js";
import { ComboCard } from "./ComboCard.js";
import { RateCard } from "./RateCard.js";
import { TraceBlock } from "./Trace.js";
import { Outcome } from "./Outcome.js";

export function DamagePanel(): ReactNode {
  const world = useWorld();
  const derived = useDerived();
  const doc = useBuild((s) => s.doc);
  const setMainSkill = useBuild((s) => s.setMainSkill);
  const setIncludeInFullDps = useBuild((s) => s.setIncludeInFullDps);
  const setTargetPlacement = useBuild((s) => s.setTargetPlacement);
  const setPackSize = useBuild((s) => s.setPackSize);
  const [branch, setBranch] = useState<"hit" | "crit">("hit");

  const skills = doc.skills ?? [];

  if (skills.length === 0) {
    return (
      <div className="panel">
        <div className="empty">Add a skill on the Skills tab to see a damage number.</div>
      </div>
    );
  }

  const dps = derived.dps;
  const damage = derived.damage;
  if (dps === undefined || damage === undefined) {
    return (
      <div className="panel">
        <div className="notice">
          The damage pipeline produced nothing for this skill. The Diagnostics tab says why.
        </div>
      </div>
    );
  }

  const mainIndex = Math.max(
    0,
    skills.findIndex((s) => s.main === true),
  );
  const trace = branch === "hit" ? damage.hit.trace : damage.crit.trace;

  return (
    <div className="panel">
      <div className="row wrap mb-5">
        <label className="faint">Skill</label>
        <select value={mainIndex} onChange={(event) => setMainSkill(Number(event.target.value))}>
          {skills.map((skill, index) => (
            <option key={`${skill.spellId}-${index}`} value={index}>
              {spellName(world.snapshot, skill.spellId)}
            </option>
          ))}
        </select>
        <span className="badge mono">{damage.spellId}</span>
      </div>

      <RateCard dps={dps} />

      <ComboCard dps={dps} />

      <SustainCard dps={dps} />

      <SelfDamageCard dps={dps} />

      <OverlapCard dps={dps} />

      <TargetCard
        placement={dps.placement}
        packSize={doc.config?.packSize ?? 1}
        packDps={dps.packDps}
        reach={dps.reachDistance}
        onPlacement={setTargetPlacement}
        onPackSize={setPackSize}
      />

      <EffectsCard dps={dps} />

      <ModelGaps model={dps.model} />

      <SourceTable dps={dps} />

      <SummonTable summons={dps.summons} total={dps.summonDps} />

      <ProcTable
        procs={dps.procs}
        total={dps.procDps}
        title="Procs"
        hint="While this skill is the only one you press. Not part of the DPS above — the Full DPS card below does count them."
      />

      <FullDpsCard
        full={derived.fullDps}
        skills={skills}
        onToggle={setIncludeInFullDps}
      />

      {derived.fullDps !== undefined && derived.fullDps.skills.length > 0 && (
        <ProcTable
          procs={derived.fullDps.procs}
          total={derived.fullDps.procDps}
          title="Procs across the rotation"
          hint="Already inside the Full DPS above. Every ticked skill's triggers against one shared proc cooldown."
        />
      )}

      <div className="card">
        <div className="row wrap" style={{ gap: 18 }}>
          <Figure
            label="Base value"
            value={smart(damage.baseValue)}
            hint="What the in-game spell tooltip prints, before the damage event touches it"
          />
          <Figure
            label="Effectiveness"
            value={`${num(damage.dmgEffectiveness * 100, 0)}%`}
            hint="dmg_effectiveness — how much of your added damage this skill carries"
          />
          <Figure
            label="Element"
            value={ELEMENTS[damage.element]?.displayName || damage.element}
            hint={`Enum name ${damage.element}`}
          />
          <Figure
            label="Crit chance"
            value={`${num(damage.critChance * 100)}%`}
            hint="Used to weight the Average column"
          />
        </div>
      </div>

      <div className="dmg-columns">
        <Outcome title="Hit" outcome={damage.hit} accent="var(--text)" />
        <Outcome title="Crit" outcome={damage.crit} accent="var(--warn)" />
        <Outcome
          title="Average"
          outcome={damage.average}
          accent="var(--accent)"
          note={`Weighted by ${num(damage.critChance * 100)}% crit chance`}
        />
      </div>

      <div className="section-title">
        Damage breakdown
        <span className="faint text-sm" style={{ fontWeight: 400, marginLeft: 8 }}>
          the same rows the mod&apos;s own damage log prints, expandable into their sources
        </span>
      </div>

      <div className="row mb-4">
        <button className={branch === "hit" ? "primary" : ""} onClick={() => setBranch("hit")}>
          Hit
        </button>
        <button className={branch === "crit" ? "primary" : ""} onClick={() => setBranch("crit")}>
          Crit
        </button>
        <span className="faint text-sm">
          Average has no rows of its own — it is the weighted mean of these two, and a layer
          averaged between them is a multiplier the game never applies.
        </span>
      </div>

      {trace === undefined ? (
        <div className="notice">No trace was recorded for this branch.</div>
      ) : (
        <TraceBlock trace={trace} />
      )}
    </div>
  );
}

/**
 * What is in the air at once, and how long the headline number takes to become true.
 *
 * The question this answers is "I keep casting while the last ones are still spinning — is that
 * in the number?". It is: `dps` is a steady-state figure, so a cast's whole output is amortised
 * over the cast interval no matter how long it takes to arrive. What the steady-state figure
 * cannot say is that it is not true yet at second one, which is the difference between a boss
 * and a pack that dies before the pipeline fills.
 */
