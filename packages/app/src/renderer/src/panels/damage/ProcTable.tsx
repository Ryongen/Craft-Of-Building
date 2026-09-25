import type { Snapshot } from "@cte2/extractor";
import { type Proc } from "@cte2/engine";
import { type ReactNode } from "react";

import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { exileEffectName, spellName } from "@cte2/schema";

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
 *
 * ## A proc this skill cannot fire but your rotation can
 *
 * `proc_arrow_storm_on_ricochet_shot` is gated on `spell_has_tag_ricochet_shot`, so against any
 * other skill it resolves to zero with "only ricochet_shot skills trigger it" — which is true of
 * the skill you are reading and false of the build, the moment Ricochet Shot is ticked into the
 * rotation. Reading "only ricochet_shot skills trigger it" on a build whose rotation contains
 * Ricochet Shot is the one way this table can be actively misleading, so `rotation` is passed in
 * and a row the pass does fire says so and prints what the pass gets for it.
 */
export function ProcTable({
  procs,
  total,
  hint,
  rotation,
}: {
  procs: readonly Proc[];
  total: number;
  hint: string;
  /**
   * The rotation's merged proc list, when there is one, so a row limited *here* can say that it
   * is live *there*. Omitted on the rotation's own table, which is already that list.
   */
  rotation?: readonly Proc[] | undefined;
}): ReactNode {
  const world = useWorld();
  if (procs.length === 0) return null;

  /** The same proc in the rotation's list, live, keyed the way the engine merges them. */
  const inRotation = (proc: Proc): Proc | undefined =>
    rotation?.find(
      (r) => r.statId === proc.statId && r.spellId === proc.spellId && r.limit === undefined,
    );

  return (
    <div className="card">
      <div className="row wrap gap-7" style={{ alignItems: "baseline" }}>
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
          {procs.map((proc) => {
            const live = proc.limit === undefined ? undefined : inRotation(proc);
            return (
            <tr
              key={`${proc.statId}:${proc.spellId}`}
              style={proc.limit === undefined || live !== undefined ? undefined : { opacity: 0.6 }}
            >
              <td>
                {spellName(world.snapshot, proc.spellId)}
                <div className="faint text-xs">
                  {proc.cooldownTicks / 20}s proc cooldown
                </div>
              </td>
              {/* A stat id is one long unbroken word, and in a half-width card it pushed the DPS
                  column off the edge. */}
              <td className="mono text-sm" style={{ overflowWrap: "anywhere" }}>
                {proc.statId}
                {proc.limit === undefined && paceNote(world.snapshot, proc) !== undefined && (
                  <div className="faint text-xs" style={{ fontFamily: "inherit" }}>
                    {paceNote(world.snapshot, proc)}
                  </div>
                )}
                {proc.limit !== undefined && (
                  <div className="faint text-xs">
                    {live === undefined ? (
                      procReason(proc, world.snapshot)
                    ) : (
                      <>
                        {procReason(proc, world.snapshot)}, but{" "}
                        <strong>your rotation does</strong>, for {smart(live.dps)}/s
                      </>
                    )}
                  </div>
                )}
              </td>
              <td className="num">{num(proc.chance * 100, 1)}%</td>
              <td className="num">{num(proc.perSecond, 2)}</td>
              <td className="num">{smart(proc.damagePerProc)}</td>
              <td className="num">{smart(proc.dps)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Why a proc contributes nothing, in the words a player would use. */
function procReason(proc: Proc, snapshot: Snapshot): string {
  switch (proc.limit) {
    case "disabled":
      return "the skill it casts is switched off on the Skills tab";
    case "when-hit":
      return "fires when you are hit, blocked or dodged";
    case "on-kill":
      return "fires on kill, which single-target DPS can't rate";
    case "basic-attack":
      return "only a basic attack triggers it";
    case "wrong-skill":
      return `only ${proc.needsTag ?? "another"} skills trigger it`;
    case "no-damage":
      return "the spell it casts deals no damage this figure covers";
    case "no-supply":
      return proc.consumes === undefined
        ? "it spends a debuff nothing on your bar applies"
        : `it spends ${exileEffectName(snapshot, proc.consumes.effectId)} and nothing on your bar applies it`;
    default:
      return "its conditions did not hold for this hit";
  }
}

/**
 * What is holding a live proc's rate down, when it is not simply the trigger.
 *
 * Cryogenic Rupture is the reason this exists: it could fire on every swing and fires on far fewer,
 * because each one spends a Snow-Tracked stack that only Tailwind Sweep puts back. A per-second
 * figure well under the swing rate with nothing beside it reads as a bug.
 */
function paceNote(snapshot: Snapshot, proc: Proc): string | undefined {
  if (proc.boundBy === "cooldown") return `held to ${num(20 / proc.cooldownTicks, 2)}/s by its cooldown`;
  if (proc.boundBy !== "supply") return undefined;
  if (proc.consumes !== undefined) {
    const supply = proc.consumes.supply;
    const from = supply.from.map((f) => spellName(snapshot, f.spellId)).join(" + ");
    const basis =
      supply.basis === "rotation"
        ? "your rotation"
        : supply.basis === "main"
          ? "your main skill"
          : "assuming you also cast it at its own rate";
    return (
      `spends ${exileEffectName(snapshot, proc.consumes.effectId)}: ` +
      `${num(supply.stacksPerSecond, 2)}/s from ${from} (${basis})`
    );
  }
  if (proc.competes !== undefined) {
    return (
      `needs ${exileEffectName(snapshot, proc.competes.effectId)}, which ` +
      `${proc.competes.spentBy} uses up, so only swings that still find it can roll`
    );
  }
  return undefined;
}

/**
 * Where the target stands, which is the one input the flight simulation cannot derive.
 *
 * Only the geometry lives here. The resistance profile is the enemy block on the Config tab,
 * because that is a property of what you are fighting rather than of how you are fighting it.
 */
