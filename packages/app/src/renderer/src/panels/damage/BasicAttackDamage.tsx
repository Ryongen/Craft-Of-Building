/**
 * The Damage tab when the weapon swing is the main figure.
 *
 * A swing is the same `DamageEvent` a spell's hit is — the same layers, the same sweep, with
 * `is_basic_atk` set — so its breakdown is the same breakdown and the ailment column beside it
 * works unchanged. What it does not have is everything a *cast* has: a model of carriers, a
 * cooldown, a cost, a placement to sweep. So this is its own, shorter view rather than the skill
 * view with half its cards reading zero.
 *
 * The procs are the reason anyone picks this. For a Cryolancer the swing is a trigger for
 * Cryogenic Rupture and Whiteout Sovereign's storms, and those are most of what it is worth.
 */

import type { BasicAttack } from "@cte2/engine";
import { ELEMENTS } from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { Panel } from "../../ui/Panel.js";
import { num, smart } from "../../ui/fields.js";
import { Figure } from "../../ui/Figure.js";

import { AilmentButtons, AilmentSummary, AilmentTrace, inflicted, shownAilment } from "./AilmentBreakdown.js";
import { FullDpsCard } from "./FullDpsCard.js";
import { Outcome } from "./Outcome.js";
import { ProcTable } from "./ProcTable.js";
import { TraceBlock } from "./Trace.js";

type Branch = "hit" | "crit" | "average";

const BRANCHES: readonly (readonly [Branch, string])[] = [
  ["hit", "Hit"],
  ["crit", "Crit"],
  ["average", "Average"],
];

export function BasicAttackDamage({ header }: { header: ReactNode }): ReactNode {
  const derived = useDerived();
  const doc = useBuild((s) => s.doc);
  const setIncludeInFullDps = useBuild((s) => s.setIncludeInFullDps);
  const [branch, setBranch] = useState<Branch>("hit");
  const [ailmentId, setAilmentId] = useState<string | null>(null);

  const basic = derived.basic;
  if (basic === undefined) {
    return (
      <div className="panel">
        <div className="calcs-body">
          {header}
          <div className="notice">
            Nothing to swing: this character holds no weapon. Pick a Skill above, or set the
            weapon&apos;s speed and damage on the Skills tab&apos;s Basic attack card.
          </div>
        </div>
      </div>
    );
  }

  const hit = basic.hit;
  const outcome = branch === "hit" ? hit.hit : branch === "crit" ? hit.crit : hit.average;
  const trace = branch === "crit" ? hit.crit.trace : hit.hit.trace;
  const ailment = shownAilment(outcome.ailments, ailmentId);
  const ailments = inflicted(hit.average.ailments);
  const rotating = derived.fullDps !== undefined && derived.fullDps.skills.length > 0;

  return (
    <div className="panel damage-panel">
      <div className="calcs-body">
        {header}

        <div className="row wrap gap-7 mb-5">
          <Figure label="Swing DPS" value={smart(basic.dps)} hint="One full-strength hit times swings per second." />
          <Figure
            label="Proc DPS"
            value={smart(basic.procDps)}
            hint="What your swings cast. Already in Total DPS beside the swing itself."
          />
          {basic.ailmentDps > 0 && <Figure label="Ailments" value={smart(basic.ailmentDps)} />}
          <Figure
            label="Swings"
            value={basic.swingsPerSecond === undefined ? "—" : `${num(basic.swingsPerSecond, 2)}/s`}
            hint={rateHint(basic)}
          />
        </div>

        <Panel
          id="damage.breakdown"
          title="Damage breakdown"
          summary={
            <>
              <span className="muted">
                {ELEMENTS[hit.element]?.displayName || hit.element} damage
              </span>
              {ailments.length > 0 && (
                <span className="badge" title="Ailments this hit can inflict">
                  inflicts {ailments.map((a) => a.ailment).join(" · ")}
                </span>
              )}
              <span title="Average damage per swing, with crits weighted in">
                <span className="muted">average hit </span>
                <span className="mono">{smart(hit.average.total)}</span>
              </span>
            </>
          }
        >
          <div className="breakdown-grid">
            <div className="bd-cell bd-left bd-band-1 section-title mt-0">The swing</div>
            <div className="bd-cell bd-left bd-band-2">
              <div className="row wrap">
                {BRANCHES.map(([id, label]) => (
                  <button key={id} className={branch === id ? "primary" : ""} onClick={() => setBranch(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bd-cell bd-left bd-band-3">
              <Outcome
                outcome={outcome}
                accent={branch === "hit" ? "var(--text)" : branch === "crit" ? "var(--warn)" : "var(--accent)"}
                note={
                  <>
                    {`weapon damage ${smart(basic.weaponDamage)}`}
                    {` · ${num(hit.hitChance * 100)}% chance to hit`}
                    {branch === "average"
                      ? ` · weighted by ${num(hit.critChance * 100)}% crit chance`
                      : ` · ${num(hit.critChance * 100)}% crit`}
                  </>
                }
              />
            </div>
            <div className="bd-cell bd-left bd-band-4">
              {branch === "average" ? (
                <div className="notice">
                  Average has no rows of its own: it is{" "}
                  <strong>{num((1 - hit.critChance) * 100)}%</strong> of the Hit branch&apos;s{" "}
                  {smart(hit.hit.total)} and <strong>{num(hit.critChance * 100)}%</strong> of the
                  Crit branch&apos;s {smart(hit.crit.total)}.
                </div>
              ) : trace === undefined ? (
                <div className="notice">No trace was recorded for this branch.</div>
              ) : (
                <TraceBlock trace={trace} target={hit.target} />
              )}
            </div>
            <div className="bd-cell bd-right bd-band-1 section-title mt-0">What it inflicts</div>
            <div className="bd-cell bd-right bd-band-2">
              <AilmentButtons ailments={outcome.ailments} shown={ailment} onSelect={setAilmentId} />
            </div>
            <div className="bd-cell bd-right bd-band-3">
              <AilmentSummary ailment={ailment} stacks={basic.ailmentStacks} />
            </div>
            <div className="bd-cell bd-right bd-band-4">
              <AilmentTrace ailment={ailment} target={hit.target} />
            </div>
          </div>
        </Panel>

        <div className="card-columns">
          <Panel id="damage.procs" title="What your swings cast" summary={`${smart(basic.procDps)}/s`}>
            <ProcTable
              procs={basic.procs}
              total={basic.procDps}
              hint="Gear procs and the ones a buff hands you. A proc that spends a debuff fires no faster than your skills put it back, and the row says which skill that is."
            />
          </Panel>

          <Panel
            id="damage.full"
            title="Full DPS"
            summary={
              rotating
                ? `${smart((derived.fullDps?.dps ?? 0) + (derived.fullDps?.ailmentDps ?? 0))}/s across ${derived.fullDps?.skills.length} skills`
                : "nothing ticked into the rotation"
            }
            defaultOpen={rotating}
          >
            <div className="faint text-sm mb-3">
              What you press between swings. Ticking the skills that re-apply a debuff is what
              tells a debuff-spending proc how often it is really fed.
            </div>
            <FullDpsCard full={derived.fullDps} skills={doc.skills ?? []} onToggle={setIncludeInFullDps} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function rateHint(basic: BasicAttack): string {
  if (basic.untimed) {
    return "No attack-speed attribute, so there is no rate. Set the weapon's speed on the Skills tab's Basic attack card.";
  }
  if (basic.frozen) {
    return "The captured attribute, which already includes your attack speed and will not move when you change gear. Split it on the Skills tab's Basic attack card.";
  }
  return `The weapon's own speed times ${num(basic.attackSpeedPercent, 1)}% attack speed.`;
}
