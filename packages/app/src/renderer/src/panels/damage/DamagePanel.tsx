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

import { sourceLabel, type DpsResult } from "@cte2/engine";
import { ELEMENTS } from "@cte2/schema";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { Panel, setAllPanels } from "../../ui/Panel.js";
import { DockedPane, useDetailPane } from "../stats/DetailPane.js";
import type { SheetFocus } from "../stats/SheetDetail.js";
import { TraceStatList, traceStats } from "../stats/TraceStats.js";
import { num, smart } from "../../ui/fields.js";
import { spellName } from "@cte2/schema";

import {
  AilmentButtons,
  AilmentSummary,
  AilmentTrace,
  inflicted,
  shownAilment,
} from "./AilmentBreakdown.js";
import { OverlapCard } from "./OverlapCard.js";
import { SourceTable } from "./SourceTable.js";
import { EffectsCard } from "./EffectsCard.js";
import { ModelGaps } from "./ModelGaps.js";
import { SummonTable } from "./SummonTable.js";
import { ProcTable } from "./ProcTable.js";
import { BasicAttackDamage } from "./BasicAttackDamage.js";
import { TargetCard } from "./TargetCard.js";
import { FullDpsCard } from "./FullDpsCard.js";
import { SustainCard, sustainVerdict } from "./SustainCard.js";
import { SelfDamageCard } from "./SelfDamageCard.js";
import { ComboCard } from "./ComboCard.js";
import { RateCard } from "./RateCard.js";
import { TraceBlock } from "./Trace.js";
import { Outcome } from "./Outcome.js";
import { DAMAGE_COPY } from "../../ui/copy/damage.js";
import { useTechnical } from "../../ui/detail-mode.js";
import { resolveHint } from "../../ui/copy/hint.js";

/**
 * The tab, choosing between the two things a main figure can be.
 *
 * Two components rather than a branch inside one: the skill view holds a dozen hooks and the
 * swing view a few, and switching between them inside one component would change the hook count
 * between renders.
 */
export function DamagePanel(): ReactNode {
  const swingIsMain = useBuild((s) => s.doc.config?.mainIsBasicAttack === true);
  return swingIsMain ? <BasicAttackDamage header={<MainSelect />} /> : <SkillDamagePanel />;
}

/**
 * Which figure the tab is about: one of the Skills, or the weapon swing.
 *
 * The swing is listed after the Skills because it is not one — it is not on the hotbar and has
 * no `SkillSetup` — but it is chosen from the same place, since "what am I judged on" is one
 * question whichever the answer is.
 */
function MainSelect(): ReactNode {
  const world = useWorld();
  const skills = useBuild((s) => s.doc.skills ?? []);
  const swingIsMain = useBuild((s) => s.doc.config?.mainIsBasicAttack === true);
  const setMainSkill = useBuild((s) => s.setMainSkill);
  const setMainBasicAttack = useBuild((s) => s.setMainBasicAttack);
  const derived = useDerived();

  const mainIndex = Math.max(
    0,
    skills.findIndex((s) => s.main === true),
  );
  const BASIC = -1;

  return (
    <div className="row wrap mb-5">
      <label className="muted">Skill</label>
      <select
        value={swingIsMain ? BASIC : mainIndex}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (value === BASIC) setMainBasicAttack(true);
          else setMainSkill(value);
        }}
      >
        {skills.map((skill, index) => (
          <option key={`${skill.spellId}-${index}`} value={index}>
            {spellName(world.snapshot, skill.spellId)}
          </option>
        ))}
        <option value={BASIC} disabled={derived.basic === undefined}>
          Basic attack
        </option>
      </select>
      <span className="badge mono">{swingIsMain ? "basic attack" : (derived.dps?.spellId ?? "")}</span>
      <div className="grow" />
      <button onClick={() => setAllPanels(DAMAGE_PANELS, false)}>Collapse all</button>
      <button onClick={() => setAllPanels(DAMAGE_PANELS, true)}>Expand all</button>
    </div>
  );
}

function SkillDamagePanel(): ReactNode {
  const [technical] = useTechnical();
  const derived = useDerived();
  const doc = useBuild((s) => s.doc);
  const setIncludeInFullDps = useBuild((s) => s.setIncludeInFullDps);
  const setTargetPlacement = useBuild((s) => s.setTargetPlacement);
  const setPackSize = useBuild((s) => s.setPackSize);
  const [branch, setBranch] = useState<Branch>("hit");
  /**
   * Which damage act the breakdown below is about, or null for "whichever is the headline".
   *
   * Null rather than a remembered act so that the choice survives editing the build: a skill
   * whose sources are renumbered by a support gem, or swapped out entirely by changing the main
   * skill, would otherwise leave a stale selection and silently fall back anyway.
   *
   * An **index**, not `DamageSource.id`, and that is load-bearing: the id is
   * `${group}#${partIndex}`, so one part declaring a physical act and a cold one produces two
   * sources under the same id. `tailwind_sweep` is exactly that, and keying the picker by id
   * meant its cold act — the one carrying the freeze, and the larger of the two — could not be
   * selected at all: both options carried the same value and both resolved to the first.
   */
  const [sourceIndex, setSourceIndex] = useState<number | null>(null);
  /**
   * Which ailment the right-hand column is about, or null for the first one inflicted.
   *
   * Lifted out of the ailment column because its buttons, its summary and its trace are three
   * separate cells of the breakdown grid now — they have to line up with the hit column's three,
   * so they cannot share a component, and therefore cannot share its state.
   */
  const [ailmentId, setAilmentId] = useState<string | null>(null);
  const detail = useDetailPane(340);
  /**
   * The Effects assumed up, docked where the detail pane goes.
   *
   * One or the other rather than both stacked: two splitters at the bottom of a tab leave
   * neither pane room to read. Opening either closes the other.
   */
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [effectsHeight, setEffectsHeight] = useState(340);
  const toggleEffects = (): void => {
    if (!effectsOpen) detail.close();
    setEffectsOpen(!effectsOpen);
  };
  const openDetail = (focus: SheetFocus): void => {
    setEffectsOpen(false);
    detail.open(focus);
  };

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

  /**
   * The source the breakdown is showing.
   *
   * `meteor_arrow` is why this is a choice at all: one press is an arrow that hits for physical
   * and a meteor that lands for fire, with different value calculations, different elements and
   * therefore different layers. A single trace describes one of them, and which one was never
   * something the reader could pick — it was whichever `DpsResult.hit` had settled on.
   */
  const headlineIndex = Math.max(
    0,
    // By identity: `dps.hit` *is* one of these entries' hits, and `headlineSourceId` cannot tell
    // two acts of one part apart.
    dps.sources.findIndex((s) => s.hit === dps.hit),
  );
  const shown = dps.sources[sourceIndex ?? headlineIndex] ?? dps.sources[headlineIndex];
  const shownHit = shown?.hit ?? damage;
  const trace = branch === "crit" ? shownHit.crit.trace : shownHit.hit.trace;
  const branchOutcome =
    branch === "hit" ? shownHit.hit : branch === "crit" ? shownHit.crit : shownHit.average;
  const branchAilments = branchOutcome.ailments;
  const ailment = shownAilment(branchAilments, ailmentId);
  /**
   * Which ailments this act can inflict, for the folded card's head.
   *
   * Off the average branch rather than the shown one so the chip does not appear and disappear
   * as you press Crit: whether a build bleeds is a fact about the build, not about the branch.
   */
  const ailments = inflicted(shownHit.average.ailments);
  /**
   * The other acts of this cast that do inflict something, when the shown one does not.
   *
   * One part can declare a physical act and a cold one, and only the cold one freezes — so the
   * ailment column being empty is a fact about the act on the left, not about the build.
   */
  const elsewhere =
    ailments.length > 0
      ? []
      : dps.sources
          .filter((s) => s !== shown && inflicted(s.hit.average.ailments).length > 0)
          .map((s) => sourceChoice(s));
  const sustain = sustainVerdict(dps);
  /**
   * Procs this skill cannot fire that the ticked rotation can, for the folded Procs card's head.
   *
   * A `spell_has_tag` gate makes the same stat a live proc on one skill and a dead one on
   * another, so a build that ticks the skill the gate names really does fire it — and the folded
   * card, which is all most readers see, said nothing about that at all.
   */
  const rotationOnly = dps.procs.filter(
    (proc) =>
      proc.limit !== undefined &&
      (derived.fullDps?.procs ?? []).some(
        (r) => r.statId === proc.statId && r.spellId === proc.spellId && r.limit === undefined,
      ),
  ).length;
  const rotating = derived.fullDps !== undefined && derived.fullDps.skills.length > 0;
  // The same test `EffectsCard` renders nothing on, so the button never opens an empty pane.
  const hasEffects = dps.effects.options.length > 0 || dps.model.blockedBy.length > 0;

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
        <MainSelect />

        {/*
          The breakdown, first, because it is what the tab is for.

          It used to be the last thing on the screen, below fourteen cards and below a full-width
          card that printed each of Hit, Crit and Average with its element split and its ailments.
          Two thirds of that card was answering a question nobody had asked yet: only one branch
          can be traced at a time, so the other two totals were there to be compared against
          nothing. The branch is a choice now, the chosen one prints its own total and split above
          its rows, and the ailments have the column to the right of it.

          Two columns because it is *two* events: the hit's own layer stack on the left, and on
          the right the second `DamageEvent` an ailment runs with its own base and its own
          multipliers. Side by side is the only arrangement in which you can see which of your
          stats crossed from one to the other.
        */}
        <Panel
          id="damage.breakdown"
          title="Damage breakdown"
          summary={
            <>
              <span className="muted">
                {ELEMENTS[shownHit.element]?.displayName || shownHit.element} damage
              </span>
              {ailments.length > 0 && (
                <span className="badge" title="Ailments this hit can inflict">
                  inflicts {ailments.map((a) => a.ailment).join(" · ")}
                </span>
              )}
              <span title="Average damage per hit, with crits weighted in">
                <span className="muted">average hit </span>
                <span className="mono">{smart(shownHit.average.total)}</span>
              </span>
            </>
          }
        >
          {/*
            One act picker for both columns, above them.

            It governs the whole panel — the ailments on the right are the selected act's, not the
            cast's — so it belongs above the split rather than in the left column, where it was
            also the single biggest reason the two columns' headers were different heights.
          */}
          {dps.sources.length > 1 && (
            <div className="row wrap mb-4">
              <label className="muted">Act</label>
              <select
                value={sourceIndex ?? headlineIndex}
                onChange={(event) => setSourceIndex(Number(event.target.value))}
              >
                {dps.sources.map((entry, index) => (
                  <option key={`${entry.source.id}#${index}`} value={index}>
                    {sourceChoice(entry)}
                  </option>
                ))}
              </select>
              <span className="muted text-sm">
                One cast produces {dps.sources.length} damage acts, each with its own value
                calculation and element.
              </span>
            </div>
          )}

          {/*
            One grid, not two stacked columns.

            Each band — title, buttons, summary, trace — is a grid row holding both columns' cells,
            so a row is as tall as its taller half and the two traces start level whatever is above
            them. Stacked independently, the ailment's own event began 120px above the hit's,
            which is the one comparison this layout exists to make.
          */}
          <div className="breakdown-grid">
            <div className="bd-cell bd-left bd-band-1 section-title mt-0">The hit</div>
            <div className="bd-cell bd-left bd-band-2">
              <div className="row wrap">
                {BRANCHES.map(([id, label]) => (
                  <button
                    key={id}
                    className={branch === id ? "primary" : ""}
                    onClick={() => setBranch(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bd-cell bd-left bd-band-3">
              <Outcome
                outcome={branchOutcome}
                accent={
                  branch === "hit"
                    ? "var(--text)"
                    : branch === "crit"
                      ? "var(--warn)"
                      : "var(--accent)"
                }
                /*
                  What this act is, *under* the number rather than over it.

                  Over it, this line pushed the total down by its own height and the ailment's
                  headline opposite — which has no such line — sat twenty pixels higher than the
                  number it is meant to be read against. Both columns now lead with the figure and
                  qualify it underneath, which is the order the ailment column already used.

                  Per act rather than once for the whole cast: `quake` is two acts of 591 base at
                  139% effectiveness and 1182 at 278%, and the card this replaced printed the
                  headline act's pair as though it described both. `baseValue` is not here at all
                  — it is the trace's own first row, identical on every fixture, and printing it
                  twice invited the two to disagree.
                */
                note={
                  <>
                    {ELEMENTS[shownHit.element]?.displayName || shownHit.element}
                    <span title={resolveHint(DAMAGE_COPY.dmgEffectiveness, technical)}>
                      {" · "}
                      {num(shownHit.dmgEffectiveness * 100, 0)}% effectiveness
                    </span>
                    {/*
                      What fraction of these hits land, beside the element and the crit chance.

                      The ailment column opposite leads with its own Chance and always has, and
                      the hit had no equivalent: dodge is folded into the total as expectation,
                      so a build missing one attack in ten showed a number 10% smaller with
                      nothing saying why. `damage_block` is the layer dodge and magic dodge
                      average onto, and its multiplier is exactly this.
                    */}
                    <span
                      title={
                        "The mob's evasion against your accuracy, as a share of hits that land. " +
                        "Dodge takes every non-magic hit, whatever its element, and magic dodge takes `magic` spells; the " +
                        "figure above already has it folded in. Open the layer's row for the " +
                        "subtraction."
                      }
                    >
                      {" · "}
                      {num(shownHit.hitChance * 100)}% chance to hit
                    </span>
                    <span title="What weights the Average branch">
                      {" · "}
                      {branch === "average"
                        ? `weighted by ${num(shownHit.critChance * 100)}% crit chance`
                        : `${num(shownHit.critChance * 100)}% crit`}
                    </span>
                  </>
                }
              />
            </div>
            <div className="bd-cell bd-left bd-band-4">
              {/*
                Average is a real branch to select and the only one with nothing to trace, so it
                says what it is instead of printing rows the game never produces.
                `critical_damage` gates a multiplicative layer and `double_damage` is clamped to
                exactly x2, so a layer averaged between the two outcomes is a multiplier no hit
                ever applies.
              */}
              {branch === "average" ? (
                <div className="notice">
                  Average has no rows of its own: it is{" "}
                  <strong>{num((1 - shownHit.critChance) * 100)}%</strong> of the Hit branch&apos;s{" "}
                  {smart(shownHit.hit.total)} and{" "}
                  <strong>{num(shownHit.critChance * 100)}%</strong> of the Crit branch&apos;s{" "}
                  {smart(shownHit.crit.total)}. The game never applies an averaged layer, so
                  pick <strong>Hit</strong> or <strong>Crit</strong> to see the rows.
                </div>
              ) : trace === undefined ? (
                <div className="notice">No trace was recorded for this branch.</div>
              ) : (
                <TraceBlock trace={trace} target={shownHit.target} />
              )}
            </div>
            <div className="bd-cell bd-right bd-band-1 section-title mt-0">
              What it inflicts
              <span className="muted text-sm" style={{ fontWeight: 400, marginLeft: 8 }}>
                each ailment&apos;s own event, on the {BRANCH_WORD[branch]} branch beside it
              </span>
            </div>

            <div className="bd-cell bd-right bd-band-2">
              <AilmentButtons
                ailments={branchAilments}
                shown={ailment}
                onSelect={setAilmentId}
              />
            </div>

            <div className="bd-cell bd-right bd-band-3">
              <AilmentSummary ailment={ailment} elsewhere={elsewhere} stacks={dps.ailmentStacks} />
            </div>

            <div className="bd-cell bd-right bd-band-4">
              <AilmentTrace ailment={ailment} target={shownHit.target} />
            </div>
          </div>

          {hasEffects && (
            <div className="row mt-5">
              <button className={effectsOpen ? "primary" : ""} onClick={toggleEffects}>
                Effects assumed up <span className="faint">· {assumedCount(derived)} up</span>
              </button>
            </div>
          )}
        </Panel>

        {/*
          Everything else, two columns of cards that fold.

          The tab used to be fourteen always-open cards in one column on a screen twice as wide as
          it needed, so reading the sustain table meant scrolling past the rate card and reading
          the trace meant scrolling past all of it. Each card now says its answer on its head and
          keeps the working inside.

          **The order is read in pairs**, which is why `.card-columns` is a grid and not CSS
          columns: a row here is two cards side by side, and the first three rows are the three
          questions only answerable together. Full DPS beside the Rate the figure is divided by;
          the Damage sources beside the Sustain, because what a cast produces and what it costs
          are the same trade. Everything conditional comes after them, so a build with no combo
          and no summons does not push the pairs out of step.

          The Effects assumed up are not a card here: they open from a button under the
          breakdown, docked to the bottom of the tab, so ticking one shows the breakdown move.
        */}
        <div className="card-columns">
          <Panel
            id="damage.full"
            title="Full DPS"
            summary={
              rotating
                ? // The card's own headline and the topbar both print `dps + ailmentDps`, and a
                  // folded card printing a third, smaller number under the same name reads as a
                  // disagreement rather than as a different question.
                  `${smart((derived.fullDps?.dps ?? 0) + (derived.fullDps?.ailmentDps ?? 0))}/s across ` +
                  `${derived.fullDps?.skills.length} skills`
                : "nothing ticked into the rotation"
            }
            defaultOpen={rotating}
          >
            <FullDpsCard
              full={derived.fullDps}
              skills={skills}
              onToggle={setIncludeInFullDps}
              swingProcDps={derived.basic?.procDps ?? 0}
            />
          </Panel>

          <Panel id="damage.rate" title="Rate" summary={`${num(dps.rate.cycleSeconds, 2)}s cycle · ${smart(dps.dps)} DPS`}>
            <RateCard dps={dps} />
          </Panel>

          <Panel
            id="damage.sources"
            title="Damage sources"
            summary={`${dps.sources.length} source${dps.sources.length === 1 ? "" : "s"} per cast`}
          >
            <SourceTable dps={dps} />
          </Panel>

          <Panel
            id="damage.sustain"
            title="Sustain"
            tone={sustain.bad ? "warn" : undefined}
            summary={
              <>
                {sustain.blood && (
                  <span className="badge warn" title={resolveHint(DAMAGE_COPY.bloodUser, technical)}>
                    blood magic
                  </span>
                )}
                <span className={sustain.bad ? "badge warn" : "badge"}>{sustain.text}</span>
              </>
            }
          >
            <SustainCard dps={dps} />
          </Panel>

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

          {dps.procs.length > 0 && (
            <Panel
              id="damage.procs"
              title="Procs"
              summary={
                <>
                  {rotationOnly > 0 && (
                    <span
                      className="badge"
                      title={resolveHint(DAMAGE_COPY.triggeredBySkill, technical)}
                    >
                      +{rotationOnly} from the rotation
                    </span>
                  )}
                  <span>{smart(dps.procDps)}/s</span>
                </>
              }
              defaultOpen={false}
            >
              <ProcTable
                procs={dps.procs}
                total={dps.procDps}
                hint="If this is the only skill you press. Not in the DPS above, but Full DPS counts them."
                rotation={derived.fullDps?.procs}
              />
            </Panel>
          )}

          {/*
            What this skill's own buff casts for you, on whichever clock fires it.

            Ice-Tipped Blade's whole value is here — its DPS above is 0 and correctly so — and
            Whiteout Sovereign's storms are half of its. Open by default for exactly that reason:
            a buff whose card said "0 DPS" and hid the number that describes it was the complaint.
          */}
          {dps.granted.length > 0 && (
            <Panel
              id="damage.granted"
              title="Granted by this skill"
              summary={`${smart(dps.grantedDps)}/s`}
              defaultOpen={dps.dps <= 0}
            >
              <ProcTable
                procs={dps.granted}
                total={dps.grantedDps}
                hint="Spells this skill's buff casts for you, mostly on your swings. Already in Total DPS; shown here because it's what this skill is for and what its support gems are ranked by."
              />
            </Panel>
          )}

          {rotating && (
            <Panel
              id="damage.rotation-procs"
              title="Procs across the rotation"
              summary={`${smart((derived.fullDps?.procDps ?? 0) + (derived.basic?.procDps ?? 0))}/s`}
              defaultOpen={false}
            >
              <ProcTable
                procs={derived.fullDps?.procs ?? []}
                total={derived.fullDps?.procDps ?? 0}
                hint="Already inside the Full DPS above. Every ticked skill's triggers against one shared proc cooldown."
              />
              {(derived.basic?.procs.length ?? 0) > 0 && (
                <>
                  <div className="section-title">From your basic attacks</div>
                  <ProcTable
                    procs={derived.basic!.procs}
                    total={derived.basic!.procDps}
                    hint="Spells your swings cast during the rotation, at your swing rate, including those granted by buffs like Whiteout Sovereign and Ice-Tipped Blade. Included in Full DPS."
                  />
                </>
              )}
            </Panel>
          )}

          {/*
            What the button costs you, on the head of the card rather than inside it.

            An aura that charges 646/s is not a detail you go looking for — it is the finding —
            and the summary is the only part of a folded card that is read. The verdict comes with
            it for the same reason: "646/s to yourself" is a number, "646/s, covered" is an answer.
          */}
          {dps.selfDamage !== undefined && (
            <Panel
              id="damage.self"
              title="Self-damage"
              tone={derived.selfSustain?.sustainable === false ? "warn" : undefined}
              summary={
                `${smart(dps.selfDamage.perSecond)}/s to yourself` +
                (derived.selfSustain === undefined
                  ? ""
                  : derived.selfSustain.sustainable
                    ? " · covered"
                    : ` · ${smart(derived.selfSustain.netLossPerSecond)}/s uncovered`)
              }
            >
              <SelfDamageCard dps={dps} />
            </Panel>
          )}

          {(dps.combo !== undefined || dps.rotations !== undefined) && (
            <Panel
              id="damage.combo"
              title="Combo"
              summary={
                dps.combo === undefined
                  ? "best fired on its own"
                  : `${dps.combo.steps.length} presses to fire`
              }
              defaultOpen={false}
            >
              <ComboCard dps={dps} />
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

          {dps.summons.length > 0 && (
            <Panel id="damage.summons" title="Summons" summary={`${smart(dps.summonDps)}/s`} defaultOpen={false}>
              <SummonTable summons={dps.summons} total={dps.summonDps} />
            </Panel>
          )}

          <Panel id="damage.gaps" title="Not in this figure" defaultOpen={false}>
            <ModelGaps model={dps.model} />
          </Panel>

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
              onSelect={openDetail}
              empty="Nothing modified this hit, so no stat fed a layer."
            />
          </Panel>
        </div>

      </div>

      {effectsOpen && hasEffects ? (
        <DockedPane
          height={effectsHeight}
          onHeight={setEffectsHeight}
          onClose={() => setEffectsOpen(false)}
        >
          <div className="breakdown">
            <div className="row mb-3">
              <strong className="grow ellipsis">Effects assumed up</strong>
              <span className="badge">{assumedCount(derived)} up</span>
            </div>
            <p className="muted text-sm mt-0 mb-4 prose">
              Tick an effect on or off and the damage breakdown above updates with it. This is the
              same list as the Config tab&apos;s, so a change here changes the build.
            </p>
            <EffectsCard dps={dps} />
          </div>
        </DockedPane>
      ) : (
        detail.pane
      )}
    </div>
  );
}

/**
 * Which reading of the hit the breakdown is showing.
 *
 * Average is a selectable branch rather than a third card beside the other two, and it is the one
 * with nothing to trace: `critical_damage` gates a multiplicative layer and `double_damage` is
 * clamped to exactly x2, so an expected-value crit is a number the game never produces for either
 * outcome. It prints what it is made of instead of rows no hit ever applied.
 */
type Branch = "hit" | "crit" | "average";

const BRANCHES: readonly (readonly [Branch, string])[] = [
  ["hit", "Hit"],
  ["crit", "Crit"],
  ["average", "Average"],
];

/** How the ailment column refers to the branch it is showing, in the reader's words. */
const BRANCH_WORD: Record<Branch, string> = {
  hit: "non-crit",
  crit: "crit",
  average: "crit-weighted",
};

/**
 * One line naming a damage act, for the breakdown's picker.
 *
 * The value calculation is the name a player would recognise from the spell tooltip, and the
 * carrier is what disambiguates two acts that share one — `meteor_arrow` uses the `meteor` calc
 * for both the arrow and the meteor, so the calc alone would print the same row twice.
 */
function sourceChoice(entry: DpsResult["sources"][number]): string {
  const element = ELEMENTS[entry.source.element]?.displayName ?? entry.source.element;
  const name = entry.source.valueCalcId || entry.source.id;
  const self = entry.source.target?.kind === "self" ? " (to yourself)" : "";
  return `${name} · ${element} · ${sourceLabel(entry.source)}${self}`;
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
  "damage.breakdown",
  "damage.rate",
  "damage.combo",
  "damage.sustain",
  "damage.self",
  "damage.overlap",
  "damage.target",
  "damage.gaps",
  "damage.sources",
  "damage.summons",
  "damage.procs",
  "damage.granted",
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
