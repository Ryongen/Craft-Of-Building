import { type Proc } from "@cte2/engine";
import { type ReactNode } from "react";

import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { spellName } from "@cte2/schema";

/**
 * Spells the build casts for you while you press the buttons you press anyway.
 *
 * The rate is the hit rate of whatever is triggering it times the chance the proc's conditions
 * left it at, capped by the procced spell's `proc_cooldown_ticks` — so the same gear reads
 * differently under a channel than under a slow slam, which is the point. A proc that cannot fire
 * is still listed, with what stopped it.
 *
 * Shared by the single skill and the rotation. They differ in one way that matters and it is in
 * the engine rather than here: the rotation merges every skill's triggers against **one** proc
 * cooldown, because the cooldown is a ceiling over the build and not one per skill.
 */
export function ProcTable({
  procs,
  total,
  title,
  hint,
}: {
  procs: readonly Proc[];
  total: number;
  title: string;
  hint: string;
}): ReactNode {
  const world = useWorld();
  if (procs.length === 0) return null;

  return (
    <div className="card">
      <div className="row wrap gap-7" style={{ alignItems: "baseline" }}>
        <span className="faint text-sm" style={{ fontWeight: 600 }}>
          {title}
        </span>
        <Figure label="Proc DPS" value={smart(total)} hint={hint} />
      </div>

      <table className="grid mt-4">
        <thead>
          <tr>
            <th>Casts</th>
            <th>From</th>
            <th className="num">Chance</th>
            <th className="num">Per second</th>
            <th className="num">Per proc</th>
            <th className="num">DPS</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((proc) => (
            <tr
              key={`${proc.statId}:${proc.spellId}`}
              style={proc.limit === undefined ? undefined : { opacity: 0.6 }}
            >
              <td>
                {spellName(world.snapshot, proc.spellId)}
                <div className="faint text-xs">
                  {proc.cooldownTicks / 20}s proc cooldown
                </div>
              </td>
              <td className="mono text-sm">
                {proc.statId}
                {proc.limit !== undefined && (
                  <div className="faint text-xs">
                    {procReason(proc)}
                  </div>
                )}
              </td>
              <td className="num">{num(proc.chance * 100, 1)}%</td>
              <td className="num">{num(proc.perSecond, 2)}</td>
              <td className="num">{smart(proc.damagePerProc)}</td>
              <td className="num">{smart(proc.dps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why a proc contributes nothing, in the words a player would use. */

/** Why a proc contributes nothing, in the words a player would use. */
function procReason(proc: Proc): string {
  switch (proc.limit) {
    case "disabled":
      return "the skill it casts is switched off on the Skills tab";
    case "when-hit":
      return "fires when you are hit, blocked or dodged";
    case "on-kill":
      return "fires on a kill — no rate a single-target figure can give it";
    case "basic-attack":
      return "only a basic attack triggers it";
    case "wrong-skill":
      return `only ${proc.needsTag ?? "another"} skills trigger it`;
    case "no-damage":
      return "the spell it casts deals no damage this figure covers";
    default:
      return "its conditions did not hold for this hit";
  }
}

/**
 * Where the target stands, which is the one input the flight simulation cannot derive.
 *
 * Only the geometry lives here. The resistance profile is the enemy block on the Config tab,
 * because that is a property of what you are fighting rather than of how you are fighting it.
 */
