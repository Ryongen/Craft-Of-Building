import {
  type DamageResult,
  type EventTrace,
  type LayerContribution,
  type LayerStep,
} from "@cte2/engine";
import type { Snapshot } from "@cte2/extractor";
import { ELEMENTS, exileEffectName, statLayerName, statName, type ElementName } from "@cte2/schema";
import { type ReactNode } from "react";

import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { StepRow as SharedStepRow } from "../../ui/StepRow.js";
import { sourceName } from "../stats/StatBreakdown.js";
import { num, smart } from "../../ui/fields.js";
import { formatStep } from "../../ui/trace-format.js";

import { COLOURS } from "./colours.js";

/** One event: the hit itself, or a bonus element spawned by conversion. */
export function TraceBlock({
  trace,
  target,
  depth = 0,
}: {
  trace: EventTrace;
  /**
   * The enemy this hit landed on, so `[Target]` rows can be resolved against it.
   *
   * Threaded from the result that owns the trace rather than read off `useDerived`, because
   * the self-damage card's trace has a different target from the Damage tab's — its own
   * character — and the two must not borrow each other's.
   */
  target?: DamageResult["target"] | undefined;
  depth?: number;
}): ReactNode {
  const world = useWorld();
  const colour = COLOURS[trace.element] ?? "var(--text)";

  return (
    <div className="card" style={depth > 0 ? { marginLeft: 16, borderLeft: `2px solid ${colour}` } : undefined}>
      <div className="row gap-5" style={{ alignItems: "baseline" }}>
        <span className="num" style={{ color: colour, fontSize: 14 }}>
          {ELEMENTS[trace.element]?.displayName || trace.element}
        </span>
        {depth > 0 && <span className="badge">bonus damage</span>}
        {trace.takenAs && (
          <span className="badge" title="A `taken as` child skips the attacker's stat sweep entirely">
            taken as
          </span>
        )}
        {trace.penetration !== 0 && (
          <span className="badge mono">penetration {smart(trace.penetration)}</span>
        )}
      </div>

      <div className="trace-row mt-3">
        <span className="faint">Base damage</span>
        <span className="num">{smart(trace.baseNumber)}</span>
      </div>

      {trace.steps.length === 0 && trace.moreMultis.length === 0 && (
        <div className="faint text-sm mt-2">
          Nothing modified this hit.
        </div>
      )}

      {trace.steps.map((step, index) => (
        <StepRow key={`${step.layerId}-${step.side}-${index}`} step={step} target={target} />
      ))}

      {trace.moreMultis.length > 0 && (
        <>
          <div className="faint text-sm mt-3">
            Multipliers — held out of every layer and applied last
          </div>
          {trace.moreMultis.map((more, index) => (
            <div className="trace-row" key={`${more.statId}-${index}`}>
              <span>{statName(world.snapshot, more.statId)}</span>
              <span className="num">x{num(more.multi, 3)}</span>
            </div>
          ))}
        </>
      )}

      <div className="trace-row mt-3" style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
        <strong>Final damage</strong>
        <span className="num" style={{ color: colour }}>
          {smart(trace.finalNumber)}
        </span>
      </div>

      {trace.children.map((child, index) => (
        <TraceBlock key={`${child.element}-${index}`} trace={child} target={target} depth={depth + 1} />
      ))}
    </div>
  );
}

/**
 * One layer, expandable into the stats that fed it.
 *
 * The disclosure mechanics are `ui/StepRow`, shared with the stat drill-down. This grew the
 * pattern first and the drill-down was rebuilt around it; keeping two copies would have meant
 * two ideas of what an expandable row looks like, drifting apart one small fix at a time.
 * What stays here is the part that is genuinely about damage: a layer prints `x2.72` where a
 * contribution prints `+412`, and only this file knows which.
 */

/**
 * One layer, expandable into the stats that fed it.
 *
 * The disclosure mechanics are `ui/StepRow`, shared with the stat drill-down. This grew the
 * pattern first and the drill-down was rebuilt around it; keeping two copies would have meant
 * two ideas of what an expandable row looks like, drifting apart one small fix at a time.
 * What stays here is the part that is genuinely about damage: a layer prints `x2.72` where a
 * contribution prints `+412`, and only this file knows which.
 */
function StepRow({
  step,
  target,
}: {
  step: LayerStep;
  target: DamageResult["target"] | undefined;
}): ReactNode {
  const world = useWorld();

  return (
    <SharedStepRow
      label={
        <>
          <span className="faint">[{step.side}] </span>
          {statLayerName(world.snapshot, step.layerId)}
          {step.additionalTo !== undefined && (
            <span className="faint">
              {" "}
              → {ELEMENTS[step.additionalTo as ElementName]?.displayName ?? step.additionalTo}
            </span>
          )}
        </>
      }
      value={formatStep(step)}
    >
      {step.contributions.length > 0 &&
        step.contributions.map((contribution, index) => (
          <ContributionRow
            key={`${contribution.statId}-${index}`}
            contribution={contribution}
            target={target}
          />
        ))}
    </SharedStepRow>
  );
}

/**
 * One stat that fed a layer, expandable into the things that granted it.
 *
 * **The two sides resolve against different sheets, and that is the whole point.** A `[Source]`
 * contribution is yours, so it drills into the character's stat breakdown — the item, perk, gem
 * or aura behind it. A `[Target]` contribution is the *enemy's*, and resolving one of those
 * against the character filed the mob's armour under the player's chestplate and Augments,
 * which is not a rough version of the truth: none of those stats is in that number.
 *
 * The enemy's own provenance is `target.origins`, and it is usually the answer to the question
 * a mitigation row provokes. A mythic mob declares 30 cold resistance, so `30 − 33.61`
 * penetration ought to read ×1.13 — and the panel says ×1.20, because Banner of the Piercing
 * Gale took 16.8 off the mob first and the layer saw 13.2. Every number in that sentence is
 * now a row you can open.
 */
function ContributionRow({
  contribution,
  target,
}: {
  contribution: LayerContribution;
  /** The enemy this hit landed on. Absent on a self-hit, where the target *is* the character. */
  target: DamageResult["target"] | undefined;
}): ReactNode {
  const world = useWorld();
  const derived = useDerived();
  const fromTarget = contribution.side !== "Source";
  const origin = fromTarget ? target?.origins.get(contribution.statId) : undefined;

  return (
    <SharedStepRow
      depth={1}
      label={statName(world.snapshot, contribution.statId)}
      value={`${contribution.value >= 0 ? "+" : ""}${num(contribution.value, 2)}`}
      tone="faint"
      {...(fromTarget && origin === undefined
        ? {
            title:
              "The target's own stat, straight off the enemy preset — nothing this build does " +
              "modifies it. See the Target card.",
          }
        : {})}
    >
      {/*
        The stat sheet already knows which item, perk, gem or aura produced each modifier, so a
        layer row resolves all the way down without any new bookkeeping.

        Passed as a **thunk**, because this is the expensive corner of the panel: without one,
        `breakdown` ran and a row was built for every modifier of every contribution of every
        layer on every render, and then thrown away unopened. See `ui/StepRow`.
      */}
      {fromTarget
        ? origin === undefined
          ? undefined
          : () => (
              <>
                <SharedStepRow
                  depth={2}
                  label={<span className="faint">the target&apos;s own</span>}
                  value={num(origin.declared, 2)}
                  tone="faint"
                  title="What the enemy preset, or the Target card, says this mob has before anything you do to it"
                />
                {origin.mods.map((mod, i) => (
                  <SharedStepRow
                    key={`${mod.source}-${i}`}
                    depth={2}
                    label={<span title={mod.path}>{effectLabel(world.snapshot, mod.source)}</span>}
                    value={`${mod.type === "MORE" ? "x" : mod.value >= 0 ? "+" : ""}${num(mod.value, 2)}${
                      mod.type === "PERCENT" ? "%" : ""
                    }`}
                    tone="faint"
                    badge={mod.path === "config.enemy.affixes" ? "affix" : "debuff"}
                  />
                ))}
                <SharedStepRow
                  depth={2}
                  label={<strong>what the layer read</strong>}
                  value={num(origin.final, 2)}
                />
              </>
            )
        : () =>
            derived.breakdown(contribution.statId)?.contributions.map((mod, modIndex) => (
              <SharedStepRow
                key={modIndex}
                depth={2}
                label={
                  /* `sourceName` resolves the id the way the stat breakdown does: "Sword"
                     rather than a `GEAR` badge beside `sword_2`. The raw pair stays on the
                     hover, because when a name looks wrong the id is what you need. */
                  <span title={`${mod.ctxType} ${mod.source}`}>
                    {sourceName(world.snapshot, mod)}
                  </span>
                }
                value={`${mod.type === "MORE" ? "x" : mod.value >= 0 ? "+" : ""}${num(mod.value, 2)}${
                  mod.type === "PERCENT" ? "%" : ""
                }`}
                tone="faint"
              />
            ))}
    </SharedStepRow>
  );
}

/** An exile effect's display name, falling back to the raw id. */
function effectLabel(snapshot: Snapshot, id: string): string {
  return exileEffectName(snapshot, id) || id;
}
