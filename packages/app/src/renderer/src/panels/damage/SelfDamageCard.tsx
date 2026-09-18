import { type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { num, smart } from "../../ui/fields.js";
import { TraceBlock } from "./Trace.js";

/**
 * What pressing the button costs you, for the ten spells that charge for themselves.
 *
 * `asura` takes 50% of your health plus 50% of your magic shield every cast, and that is a real
 * damage event rather than a resource cost with a nicer name: it goes through your `dmg_received`,
 * your armour and your resists, and the game's own log prints it as a block of `[Target]` lines.
 * It is not netted off the DPS above and never will be — what you deal and what you pay are
 * different questions, and one number mixing them would answer neither.
 *
 * Two of its rules surprise people and both are worth stating on screen rather than in a comment:
 * you take **none of your own offence** (`no_attacker_stats_on_selfdmg` switches off the attacker
 * half of the sweep, so `attack_damage` and crit never touch it), and you **cannot dodge or block
 * it** (`DamageEvent.canAvoidHit()` is `source != target`). Mitigation is the only defence that
 * applies, which is exactly why the mitigated share is the headline here.
 */
export function SelfDamageCard({ dps }: { dps: DpsResult }): ReactNode {
  const self = dps.selfDamage;
  if (!self) return null;

  // Both pools, because `asura_self` scales off both and a hit spends magic shield before health.
  const health = dps.cost.budget.find((row) => row.resource === "health");
  const shield = dps.cost.budget.find((row) => row.resource === "magic_shield");
  const pool = (health?.max ?? 0) + (shield?.max ?? 0);
  const share = pool > 0 ? self.perCast / pool : 0;

  // What the pools are already doing, before this drain is set against them. A cast you cannot
  // out-heal is the finding; how far under is the detail.
  const income = (health?.netPerSecond ?? 0) + (shield?.netPerSecond ?? 0);
  const net = income - self.perSecond;
  const castsToEmpty = self.perCast > 0 ? pool / self.perCast : Infinity;

  return (
    <div className="card">
      <div className="row wrap gap-7 mb-4" style={{ alignItems: "baseline" }}>
        <span className={net >= 0 ? "badge" : "badge warn"}>
          {net >= 0
            ? `regen covers it, +${smart(Math.round(net))}/s spare`
            : `${smart(Math.round(-net))}/s more than you regenerate`}
        </span>
        {share > 0 && (
          <span
            className={share >= 0.5 ? "badge warn" : "badge"}
            title="One cast against your health plus magic shield"
          >
            {num(share * 100, 1)}% of your pool per cast
          </span>
        )}
        <span className="badge mono" title="You cannot dodge or block a hit you inflicted on yourself">
          no dodge or block
        </span>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Per cast</th>
            <th className="num">Raw</th>
            <th className="num">Mitigated</th>
            <th className="num">You take</th>
            <th className="num">Per second</th>
            <th className="num">Casts to empty</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="faint">
              {self.sources.length === 1
                ? self.sources[0]!.hit.spellId
                : `${self.sources.length} self-damage acts`}
            </td>
            <td className="num">{smart(Math.round(self.rawPerCast))}</td>
            <td className="num">{num(self.mitigated * 100, 1)}%</td>
            <td className="num">{smart(Math.round(self.perCast))}</td>
            <td className="num">{smart(Math.round(self.perSecond))}</td>
            <td className="num">
              {Number.isFinite(castsToEmpty) ? num(castsToEmpty, 1) : "—"}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        Resolved against <strong>your</strong> sheet, not the enemy&apos;s: the layers below are
        your <code>dmg_received</code>, your armour and your resists. You take none of your own
        offence — <code>no_attacker_stats_on_selfdmg</code> turns the attacker half of the hit off,
        which is why there is no crit and no <code>[Source]</code> row — and avoidance is skipped
        entirely, so dodge and block do nothing here. &quot;Casts to empty&quot; ignores
        regeneration and leech; the badge above is the one that accounts for them.
      </div>

      {self.sources.map((source) =>
        source.hit.hit.trace === undefined ? null : (
          <div key={source.source.id} className="mt-4">
            <div className="faint text-sm mb-2 mono">{source.source.valueCalcId}</div>
            {/* No `target`: on a self-hit the target sheet *is* the character's, so there is
                no enemy provenance to resolve against and `origins` is empty by construction. */}
            <TraceBlock trace={source.hit.hit.trace} />
          </div>
        ),
      )}
    </div>
  );
}
