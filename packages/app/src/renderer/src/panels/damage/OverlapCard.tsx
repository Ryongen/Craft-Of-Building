import { damageWithin, type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";

/**
 * What is in the air at once, and how long the headline number takes to become true.
 *
 * The question this answers is "I keep casting while the last ones are still spinning — is that
 * in the number?". It is: `dps` is a steady-state figure, so a cast's whole output is amortised
 * over the cast interval no matter how long it takes to arrive. What the steady-state figure
 * cannot say is that it is not true yet at second one, which is the difference between a boss
 * and a pack that dies before the pipeline fills.
 */
export function OverlapCard({ dps }: { dps: DpsResult }): ReactNode {
  const { overlap } = dps;
  if (!overlap.overlapping) return null;

  const windows = [1, 2, 3, 5, 10];

  return (
    <div className="card">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        <Figure
          label="Casts overlapping"
          value={num(overlap.concurrentCasts, 1)}
          hint="How many casts are still dealing damage at once, once you have been casting steadily"
        />
        {overlap.projectilesAlive > 0 && (
          <Figure
            label="Projectiles alive"
            value={num(overlap.projectilesAlive, 0)}
            hint="Carriers in the world at the same time — overlapping casts times the projectiles each throws"
          />
        )}
        <Figure
          label="Ramp"
          value={`${num(overlap.rampSeconds, 1)}s`}
          hint="Sustained casting reaches the full DPS only after this long; before it, damage is still filling up"
        />
      </div>

      <table className="grid mt-5">
        <thead>
          <tr>
            <th>After</th>
            {windows.map((t) => (
              <th key={t} className="num">
                {t}s
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="faint">Dealt</td>
            {windows.map((t) => (
              <td key={t} className="num">
                {smart(damageWithin(dps, t))}
              </td>
            ))}
          </tr>
          <tr>
            <td className="faint">Of steady rate</td>
            {windows.map((t) => {
              const share = dps.dps > 0 ? damageWithin(dps, t) / (dps.dps * t) : 0;
              return (
                <td key={t} className="num">
                  {num(share * 100, 0)}%
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>

      <div className="faint text-sm mt-3 prose">
        Casting again before the last carriers expire does <strong>not</strong> multiply the DPS
        above &mdash; that figure already amortises each cast&apos;s whole output over the cast
        interval, so overlap is in it by construction. What overlap costs you is the{" "}
        <em>start</em> of a fight: the row above is what a target has actually taken after that
        long, and it only reaches the headline rate once the pipeline is full.
      </div>
    </div>
  );
}

/**
 * Every `damage` act one cast produces, and how much of each one reaches the target.
 *
 * This is the table the old single-hit model could not draw. A cast of `raging_dragon` is two
 * rows: a slam that lands once, and a pulse that fires 135 times across nine projectiles, of
 * which the target catches whatever the flight simulation says it catches.
 */
