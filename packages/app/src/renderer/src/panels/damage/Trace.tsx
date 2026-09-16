import { type EventTrace, type LayerStep } from "@cte2/engine";
import { ELEMENTS, statLayerName, statName, type ElementName } from "@cte2/schema";
import { type ReactNode } from "react";

import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { StepRow as SharedStepRow } from "../../ui/StepRow.js";
import { sourceName } from "../stats/StatBreakdown.js";
import { num, smart } from "../../ui/fields.js";

import { COLOURS } from "./colours.js";

/** One event: the hit itself, or a bonus element spawned by conversion. */
export function TraceBlock({ trace, depth = 0 }: { trace: EventTrace; depth?: number }): ReactNode {
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
        <StepRow key={`${step.layerId}-${step.side}-${index}`} step={step} />
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
        <TraceBlock key={`${child.element}-${index}`} trace={child} depth={depth + 1} />
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
function StepRow({ step }: { step: LayerStep }): ReactNode {
  const world = useWorld();
  const derived = useDerived();

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
          <SharedStepRow
            key={`${contribution.statId}-${index}`}
            depth={1}
            label={statName(world.snapshot, contribution.statId)}
            value={`${contribution.value >= 0 ? "+" : ""}${num(contribution.value, 2)}`}
            tone="faint"
          >
            {/*
              The stat sheet already knows which item, perk, gem or aura produced each
              modifier, so a layer row resolves all the way down without any new bookkeeping.

              Passed as a **thunk**, because this is the expensive corner of the panel: without
              one, `breakdown` ran and a row was built for every modifier of every contribution of
              every layer on every render, and then thrown away unopened. See `ui/StepRow`.
            */}
            {() =>
              derived.breakdown(contribution.statId)?.contributions.map((mod, modIndex) => (
              <SharedStepRow
                key={modIndex}
                depth={2}
                label={
                  <>
                    {/* `sourceName` resolves the id the way the stat breakdown does: "Sword"
                        rather than a `GEAR` badge beside `sword_2`. The raw pair stays on the
                        hover, because when a name looks wrong the id is what you need. */}
                    <span title={`${mod.ctxType} ${mod.source}`}>
                      {sourceName(world.snapshot, mod)}
                    </span>
                  </>
                }
                value={`${mod.type === "MORE" ? "x" : mod.value >= 0 ? "+" : ""}${num(mod.value, 2)}${
                  mod.type === "PERCENT" ? "%" : ""
                }`}
                tone="faint"
              />
              ))
            }
          </SharedStepRow>
        ))}
    </SharedStepRow>
  );
}

/** `StatLayer.getTooltip` formats a MULTIPLY layer as `xN`, an ADD as `+N`, conversion as `N%`. */

/** `StatLayer.getTooltip` formats a MULTIPLY layer as `xN`, an ADD as `+N`, conversion as `N%`. */
function formatStep(step: LayerStep): string {
  if (step.action === "MULTIPLY") return `x${num(step.multiplier ?? 1, 3)}`;
  if (step.action === "ADD") return `${step.amount >= 0 ? "+" : ""}${smart(step.amount)}`;
  if (step.conversion.length > 0) {
    return step.conversion.map((c) => `${num(c.percent, 1)}% ${c.element}`).join(", ");
  }
  return `${num(step.amount, 1)}%`;
}
