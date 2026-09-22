import { carrierSeconds, originLabel, sourceLabel, type DpsResult } from "@cte2/engine";
import { ELEMENTS } from "@cte2/schema";
import { type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { NumberField } from "../../ui/fields.js";
import { num, smart } from "../../ui/fields.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

/**
 * Every `damage` act one cast produces, and how much of each one reaches the target.
 *
 * This is the table the old single-hit model could not draw. A cast of `raging_dragon` is two
 * rows: a slam that lands once, and a pulse that fires 135 times across nine projectiles, of
 * which the target catches whatever the flight simulation says it catches.
 */
export function SourceTable({ dps }: { dps: DpsResult }): ReactNode {
  const setCoverageOverride = useBuild((s) => s.setCoverageOverride);
  const overrides = useBuild((s) => s.doc.config?.coverageOverrides) ?? {};

  if (dps.sources.length === 0) {
    return (
      <div className="notice">
        This skill declares no reachable <code>damage</code> act. Whatever it does is procs,
        ailments or summons, none of which this figure covers.
      </div>
    );
  }

  return (
    <>
      <div className="muted text-sm mb-3 prose">
        What one cast produces, and how much of it lands where the target is standing.
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Source</th>
            <th>Carrier</th>
            <th className="num">Per cast</th>
            <th className="num">Lands</th>
            <th className="num">Hit</th>
            <th className="num">Damage</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dps.sources.map((entry) => {
            const overridden = overrides[entry.source.id] !== undefined;
            const share = dps.damagePerCast > 0 ? entry.damagePerCast / dps.damagePerCast : 0;
            return (
              <tr key={entry.source.id}>
                <td>
                  <div className="mono text-sm">
                    {entry.source.valueCalcId || entry.source.id}
                  </div>
                  <div className="faint text-sm">
                    {ELEMENTS[entry.source.element]?.displayName || entry.source.element}
                    {" · "}
                    {entry.source.path.join(" → ")}
                  </div>
                </td>
                <td className="text-sm">
                  {sourceLabel(entry.source)}
                  {entry.source.carrier.lifeTicks > 0 && (
                    <span className="faint">
                      {" · "}
                      {num(carrierSeconds(entry.source.carrier), 1)}s
                    </span>
                  )}
                  {entry.persistent && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      outlives the cycle
                    </span>
                  )}
                  <div className="faint text-sm">
                    {originLabel(entry.source)}
                  </div>
                </td>
                <td className="num">{num(entry.source.instancesPerCast, 0)}</td>
                <td className="num">
                  <span title={entry.coverage.note ?? `derived by ${entry.coverage.method}`}>
                    {num(entry.coverage.hitsPerCast, 1)}
                  </span>
                  <div className="faint text-xs">
                    {num(entry.coverage.fraction * 100, 0)}%
                    {" · "}
                    {overridden ? "set by you" : entry.coverage.method}
                  </div>
                </td>
                <td className="num">{smart(entry.hit.average.total)}</td>
                <td className="num">
                  {smart(entry.damagePerCast)}
                  <div className="faint text-xs">
                    {num(share * 100, 0)}%
                  </div>
                </td>
                <td>
                  <NumberField
                    value={overridden ? (overrides[entry.source.id] as number) : entry.coverage.hitsPerCast}
                    min={0}
                    width={56}
                    onChange={(value) =>
                      setCoverageOverride(
                        entry.source.id,
                        value === undefined || Math.abs(value - entry.coverage.hitsPerCast) < 1e-9
                          ? undefined
                          : value,
                      )
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <>
      <Plain>
        <div className="faint text-sm mt-3 prose">
          Landing hits are simulated rather than assumed: each projectile is calculated using its speed, acceleration, and arc spread, counting hits that land within the target's area radius. Override this number only when you know something the simulation cannot account for, such as a mob moving out of a ground effect.
        </div>
      </Plain>
      <Tech>
        <div className="faint text-sm mt-3 prose">
          <strong>Lands</strong> is derived, not assumed: each projectile is flown with the
          game&apos;s own integration &mdash; <code>proj_speed</code>, <code>proj_accel</code> and{" "}
          <code>yaw_velocity</code>, spread the way <code>ProjectileCastHelper</code> spreads them
          &mdash; and the pulses that fall inside the area radius of the target are counted. Type
          over it only when you know something the simulation cannot, such as a mob that will not
          stand still in a ground effect.
        </div>
      </Tech>
      </>
    </>
  );
}

/**
 * What the build is assumed to have up, and what that switches on.
 *
 * A third of the pack's skills are branch tables keyed on exile effects — which stance you are
 * in, which aura you run, whether you are at four `overheat` stacks — and a branch whose gate
 * fails produces nothing at all. So this is not a cosmetic toggle list: it decides which half of
 * `soul_siphon` exists, and it is the same list, writing to the same place, as the one in the
 * Config tab. Turning a buff off here takes it off the character's sheet too.
 *
 * Only effects the build can actually produce are offered, and each says what would produce it.
 */
