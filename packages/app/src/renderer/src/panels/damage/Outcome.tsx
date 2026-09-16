import { type HitOutcome } from "@cte2/engine";
import { ELEMENTS, type ElementName } from "@cte2/schema";
import { type ReactNode } from "react";

import { num, smart } from "../../ui/fields.js";

import { COLOURS } from "./colours.js";

export function Outcome({
  title,
  outcome,
  accent,
  note,
}: {
  title: string;
  outcome: HitOutcome;
  accent: string;
  note?: string;
}): ReactNode {
  const elements = [...outcome.byElement.entries()]
    .filter(([, value]) => value !== 0)
    .sort((a, b) => b[1] - a[1]);

  const ailments = outcome.ailments.filter(
    (a) => a.chance > 0 && (a.totalDamage > 0 || a.accumulated > 0),
  );

  return (
    <div className="card">
      <div className="section-title mt-0">
        {title}
      </div>
      <div className="dmg-total" style={{ color: accent }}>
        {smart(outcome.total)}
      </div>
      {note !== undefined && (
        <div className="faint text-sm mb-3">
          {note}
        </div>
      )}

      <div className="mt-4">
        {elements.length === 0 && <div className="faint">No damage.</div>}
        {elements.map(([element, value]) => (
          <div key={element} className="ele-row">
            <span style={{ color: COLOURS[element] ?? "var(--text)" }}>
              {ELEMENTS[element as ElementName]?.displayName || element}
            </span>
            <span className="num">{smart(value)}</span>
          </div>
        ))}
      </div>

      {ailments.length > 0 && (
        <>
          <div className="section-title">Ailments</div>
          {ailments.map((ailment) => (
            <div key={ailment.ailment} style={{ marginBottom: 5 }}>
              <div className="ele-row">
                <span style={{ color: COLOURS[ailment.element] ?? "var(--text)" }}>
                  {ailment.ailment}
                </span>
                <span className="badge">{num(ailment.chance * 100, 0)}%</span>
              </div>
              <div className="faint text-sm">
                {ailment.damagePerSecond > 0 ? (
                  <>
                    {smart(ailment.damagePerSecond)}/s for {num(ailment.durationSeconds, 1)}s ={" "}
                    {smart(ailment.totalDamage)}
                  </>
                ) : (
                  <>accumulates {smart(ailment.accumulated)}</>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
