import { type TargetPlacement } from "@cte2/schema";
import { type ReactNode } from "react";

import { Figure } from "../../ui/Figure.js";
import { NumberField } from "../../ui/fields.js";
import { num, smart } from "../../ui/fields.js";

/**
 * Where the target stands, which is the one input the flight simulation cannot derive.
 *
 * Only the geometry lives here. The resistance profile is the enemy block on the Config tab,
 * because that is a property of what you are fighting rather than of how you are fighting it.
 */
export function TargetCard({
  placement,
  packSize,
  packDps,
  reach,
  onPlacement,
  onPackSize,
}: {
  placement: TargetPlacement;
  packSize: number;
  packDps: number;
  /** Set only when the skill reaches nothing where the target is — how far it does reach. */
  reach: number | undefined;
  onPlacement: (placement: TargetPlacement | undefined) => void;
  onPackSize: (size: number | undefined) => void;
}): ReactNode {
  const set = (patch: Partial<TargetPlacement>): void => onPlacement({ ...placement, ...patch });

  return (
    <div className="card">
      <div className="row wrap gap-7">
        <label className="faint text-sm">
          Distance
        </label>
        <NumberField
          value={placement.distance}
          min={0}
          width={56}
          onChange={(value) => set({ distance: value ?? 0 })}
        />
        <label className="faint text-sm">
          Hitbox radius
        </label>
        <NumberField
          value={placement.radius}
          min={0}
          width={56}
          onChange={(value) => set({ radius: value ?? 0 })}
        />
        <label className="faint text-sm">
          Bearing&deg;
        </label>
        <NumberField
          value={placement.bearing}
          width={56}
          onChange={(value) => set({ bearing: value ?? 0 })}
        />
        <label className="faint text-sm">
          Pack size
        </label>
        <NumberField value={packSize} min={1} width={56} onChange={(value) => onPackSize(value)} />
        {reach !== undefined && (
          <button className="badge" type="button" onClick={() => set({ distance: reach })}>
            reaches {num(reach, 1)}, move the target closer
          </button>
        )}
        {packSize > 1 && (
          <Figure
            label="Pack DPS"
            value={smart(packDps)}
            hint="Single-target DPS against every enemy in the pack, each placed like the one above"
          />
        )}
        <button onClick={() => onPlacement(undefined)}>Reset</button>
      </div>
      <div className="faint text-sm mt-3 prose">
        Distance to the target in blocks, its half-width, and its angle from where you&apos;re
        facing. Moving it changes how many hits land; watch the Lands column.
      </div>
    </div>
  );
}

/**
 * Full DPS &mdash; the rotation, not a sum.
 *
 * Ticking two attacks does not double the number: both arm the same `GLOBAL_COOLDOWN`, so a pass
 * that casts each of them once takes as long as both casts plus both arms. That is the whole
 * point for this pack, where a `finisher` cannot be cast at all until an `extender` has been.
 *
 * A **buff** is not a pass step, and this is where that shows. A toggle such as Banishing Blade
 * is pressed once and stays up; charging the pass for it every time round both added its cast
 * and stretched the pass to its cooldown, so ticking one free buff could halve the number. Here
 * it is charged its upkeep instead &mdash; nothing at all for a toggle &mdash; and the effect it
 * puts on the sheet is counted either way, because availability comes from the skill bar rather
 * than from this tick.
 *
 * **Procs are in the headline.** Everything the rotation sets off is merged against one shared
 * `proc_cooldown_ticks` ceiling and added, which is the difference between reading a proc-heavy
 * build and reading it as a weak one.
 */
