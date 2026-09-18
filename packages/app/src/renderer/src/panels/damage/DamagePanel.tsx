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
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { Panel, setAllPanels } from "../../ui/Panel.js";
import { useDetailPane } from "../stats/DetailPane.js";
import { TraceStatList, traceStats } from "../stats/TraceStats.js";
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
import { SustainCard, sustainVerdict } from "./SustainCard.js";
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
  const detail = useDetailPane(340);

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
  const sustain = sustainVerdict(dps);
  const rotating = derived.fullDps !== undefined && derived.fullDps.skills.length > 0;

  /**
   * Every stat that measurably touched this hit, off the trace the recorder already wrote.
   *
   * Read from the *hit* branch rather than whichever branch the buttons are showing: the crit
   * branch adds `critical_damage` and `double_damage` and is otherwise the same list, and a
   * panel of stats that reshuffled when you pressed Crit would read as two different answers.
   */
  const hitStats = useMemo(
    () => (damage.hit.trace === undefined ? [] : traceStats(damage.hit.trace, "Source")),
    [damage.hit.trace],
  );

  return (
    <div className="panel damage-panel">
      <div className="calcs-body">
        <div className="row wrap mb-5">
          <label className="muted">Skill</label>
          <select value={mainIndex} onChange={(event) => setMainSkill(Number(event.target.value))}>
            {skills.map((skill, index) => (
              <option key={`${skill.spellId}-${index}`} value={index}>
                {spellName(world.snapshot, skill.spellId)}
              </option>
            ))}
          </select>
          <span className="badge mono">{damage.spellId}</span>
          <div className="grow" />
          <button onClick={() => setAllPanels(DAMAGE_PANELS, false)}>Collapse all</button>
          <button onClick={() => setAllPanels(DAMAGE_PANELS, true)}>Expand all</button>
        </div>

        {/*
          The hit itself, full width and above the columns.

          It is the answer the tab is about, so it does not fold and does not share a column with
          a card you might have collapsed — everything below it is working.
        */}
        <div className="card mb-4">
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

          <div className="dmg-columns mt-5">
            <Outcome title="Hit" outcome={damage.hit} accent="var(--text)" />
            <Outcome title="Crit" outcome={damage.crit} accent="var(--warn)" />
            <Outcome
              title="Average"
              outcome={damage.average}
              accent="var(--accent)"
              note={`Weighted by ${num(damage.critChance * 100)}% crit chance`}
            />
          </div>
        </div>

        {/*
          Everything else, two columns of cards that fold.

          The tab used to be fourteen always-open cards in one column on a screen twice as wide as
          it needed, so reading the sustain table meant scrolling past the rate card and reading
          the trace meant scrolling past all of it. Each card now says its answer on its head and
          keeps the working inside.
        */}
        <div className="card-columns">
          <Panel id="damage.rate" title="Rate" summary={`${num(dps.rate.cycleSeconds, 2)}s cycle · ${smart(dps.dps)} DPS`}>
            <RateCard dps={dps} />
          </Panel>

          {dps.combo !== undefined && (
            <Panel
              id="damage.combo"
              title="Combo"
              summary={`${dps.combo.steps.length} presses to fire`}
              defaultOpen={false}
            >
              <ComboCard dps={dps} />
            </Panel>
          )}

          <Panel
            id="damage.sustain"
            title="Sustain"
            tone={sustain.bad ? "warn" : undefined}
            summary={
              <>
                {sustain.blood && (
                  <span className="badge warn" title="`blood_user`: every mana and energy cost is paid from blood">
                    blood magic
                  </span>
                )}
                <span className={sustain.bad ? "badge warn" : "badge"}>{sustain.text}</span>
              </>
            }
          >
            <SustainCard dps={dps} />
          </Panel>

          {dps.selfDamage !== undefined && (
            <Panel id="damage.self" title="Self-damage" summary={`${smart(dps.selfDamage.perSecond)}/s to yourself`}>
              <SelfDamageCard dps={dps} />
            </Panel>
          )}

          {dps.overlap.overlapping && (
            <Panel
              id="damage.overlap"
              title="Overlap"
              summary={`${num(dps.overlap.concurrentCasts, 1)} casts at once · ${num(dps.overlap.rampSeconds, 1)}s ramp`}
              defaultOpen={false}
            >
              <OverlapCard dps={dps} />
            </Panel>
          )}

          <Panel
            id="damage.target"
            title="Target position"
            summary={`${num(dps.placement.distance, 1)} blocks · pack of ${doc.config?.packSize ?? 1}`}
            defaultOpen={false}
          >
            <TargetCard
              placement={dps.placement}
              packSize={doc.config?.packSize ?? 1}
              packDps={dps.packDps}
              reach={dps.reachDistance}
              onPlacement={setTargetPlacement}
              onPackSize={setPackSize}
            />
          </Panel>

          <Panel
            id="damage.effects"
            title="Effects assumed up"
            summary={`${assumedCount(derived)} up`}
            defaultOpen={false}
          >
            <EffectsCard dps={dps} />
          </Panel>

          <Panel id="damage.gaps" title="Not in this figure" defaultOpen={false}>
            <ModelGaps model={dps.model} />
          </Panel>

          <Panel
            id="damage.sources"
            title="Damage sources"
            summary={`${dps.sources.length} source${dps.sources.length === 1 ? "" : "s"} per cast`}
          >
            <SourceTable dps={dps} />
          </Panel>

          {dps.summons.length > 0 && (
            <Panel id="damage.summons" title="Summons" summary={`${smart(dps.summonDps)}/s`} defaultOpen={false}>
              <SummonTable summons={dps.summons} total={dps.summonDps} />
            </Panel>
          )}

          {dps.procs.length > 0 && (
            <Panel id="damage.procs" title="Procs" summary={`${smart(dps.procDps)}/s`} defaultOpen={false}>
              <ProcTable
                procs={dps.procs}
                total={dps.procDps}
                hint="While this skill is the only one you press. Not part of the DPS above — the Full DPS card below does count them."
              />
            </Panel>
          )}

          <Panel
            id="damage.full"
            title="Full DPS"
            summary={
              rotating
                ? `${smart(derived.fullDps?.dps ?? 0)}/s across ${derived.fullDps?.skills.length} skills`
                : "nothing ticked into the rotation"
            }
            defaultOpen={rotating}
          >
            <FullDpsCard full={derived.fullDps} skills={skills} onToggle={setIncludeInFullDps} />
          </Panel>

          {rotating && (
            <Panel
              id="damage.rotation-procs"
              title="Procs across the rotation"
              summary={`${smart(derived.fullDps?.procDps ?? 0)}/s`}
              defaultOpen={false}
            >
              <ProcTable
                procs={derived.fullDps?.procs ?? []}
                total={derived.fullDps?.procDps ?? 0}
                hint="Already inside the Full DPS above. Every ticked skill's triggers against one shared proc cooldown."
              />
            </Panel>
          )}

          {/*
            The stats behind the number, on the screen the number is on.

            Read off the trace rather than curated, so it is exactly the stats that measurably
            touched this hit — and against the **spell's** stat unit, which is the sheet the
            pipeline read and the only one the support gems are in.
          */}
          <Panel
            id="damage.stats"
            title="Stats behind this hit"
            summary={`${hitStats.length} stats`}
          >
            <TraceStatList
              statIds={hitStats}
              scope="skill"
              selected={detail.focus}
              onSelect={detail.open}
              empty="Nothing modified this hit, so no stat fed a layer."
            />
          </Panel>
        </div>

        <div className="section-title">
          Damage breakdown
          <span className="muted text-sm" style={{ fontWeight: 400, marginLeft: 8 }}>
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
          <span className="muted text-sm">
            Average has no rows of its own — it is the weighted mean of these two, and a layer
            averaged between them is a multiplier the game never applies.
          </span>
        </div>

        {trace === undefined ? (
          <div className="notice">No trace was recorded for this branch.</div>
        ) : (
          <TraceBlock trace={trace} target={damage.target} />
        )}
      </div>

      {detail.pane}
    </div>
  );
}

/** How many exile effects the pipeline settled on as up, for the card's head. */
function assumedCount(derived: ReturnType<typeof useDerived>): number {
  return derived.effects.options.filter(
    (option) => option.side === "caster" && option.stacks > 0 && option.hasStats,
  ).length;
}

/**
 * Every folding card on this tab, so the two buttons in the header can drive them at once.
 *
 * A literal list rather than something collected at render: "collapse all" has to reach the cards
 * that are not currently on screen — a build with no combo has no combo card, and closing the
 * rest while leaving that one open for the next build is the bug this avoids.
 */
const DAMAGE_PANELS = [
  "damage.rate",
  "damage.combo",
  "damage.sustain",
  "damage.self",
  "damage.overlap",
  "damage.target",
  "damage.effects",
  "damage.gaps",
  "damage.sources",
  "damage.summons",
  "damage.procs",
  "damage.full",
  "damage.rotation-procs",
  "damage.stats",
] as const;

/**
 * What is in the air at once, and how long the headline number takes to become true.
 *
 * The question this answers is "I keep casting while the last ones are still spinning — is that
 * in the number?". It is: `dps` is a steady-state figure, so a cast's whole output is amortised
 * over the cast interval no matter how long it takes to arrive. What the steady-state figure
 * cannot say is that it is not true yet at second one, which is the difference between a boss
 * and a pack that dies before the pipeline fills.
 */
