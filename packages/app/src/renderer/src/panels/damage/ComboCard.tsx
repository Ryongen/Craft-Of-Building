import { type ComboChain, type ComboRotation, type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";

/**
 * What you have to press before this skill will fire.
 *
 * A finisher's cycle is how often the button comes back, not how often it does anything.
 * `raging_dragon` spends `combo_extender`, which only `spirit_offensive` grants, which spends
 * `combo_linker`, which `elemental_assault` grants, which spends `combo_starter` — and that comes
 * off a basic attack. Four presses to see one dragon, and only the last of them is the 0.5s the
 * rate card shows.
 */
export function ComboCard({ dps }: { dps: DpsResult }): ReactNode {
  const combo = dps.combo;
  if (combo === undefined && dps.rotations === undefined) return null;

  return (
    <div className="card">
      {combo !== undefined && <Chain dps={dps} combo={combo} />}
      {dps.rotations !== undefined && <Rotations spellId={dps.spellId} rotations={dps.rotations} />}
    </div>
  );
}

function Chain({ dps, combo }: { dps: DpsResult; combo: ComboChain }): ReactNode {
  const setEffect = useBuild((s) => s.setEffect);
  return (
    <>
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        {combo.castsPerSecond !== undefined && (
          <Figure
            label="Casts/s"
            value={num(combo.castsPerSecond, 2)}
            hint="How often the last step actually lands, once you have paid for the presses before it"
          />
        )}
        {combo.secondsPerCast !== undefined && (
          <Figure
            label="Per combo"
            value={`${num(combo.secondsPerCast, 2)}s`}
            hint="One pass: each step costs its cast plus the global cooldown it arms, and a skill whose own cooldown is not back by the time you return to it makes the pass wait (marked cd)"
          />
        )}
        {dps.comboDps !== undefined && (
          <Figure
            label="Combo DPS"
            value={smart(dps.comboDps)}
            hint="This skill's DPS at the combo's pace. The other presses deal damage too; tick them in Full DPS to get the rotation's total"
          />
        )}
        {combo.resources.length > 0 && (
          <Figure
            label="Fires holding"
            value={combo.holds.length === 0 ? "nothing" : combo.holds.join(" + ")}
            hint={
              `This skill spends ${combo.resources.join(", ")}, and branches on which of them ` +
              `are up. Each combination has its own damage. ` +
              `The numbers above are for the one this rotation reaches` +
              (combo.holds.length === combo.resources.length
                ? "."
                : `; the rest of the table is what you're missing.`)
            }
          />
        )}
      </div>

      {combo.fixed.length > 0 && (
        <div className="faint text-sm mt-4">
          <strong>Set by hand in Effects:</strong>{" "}
          {combo.fixed
            .map((id) => `${id} ${combo.holds.includes(id) ? "on" : "off"}`)
            .join(", ")}
          . The rotation takes {combo.fixed.length === 1 ? "it" : "them"} as given and only
          chooses the rest.{" "}
          <button
            className="text-xs"
            style={{ padding: "0 6px" }}
            onClick={() => {
              for (const id of combo.fixed) setEffect(id, undefined);
            }}
          >
            Let the rotation choose
          </button>
        </div>
      )}

      <table className="grid mt-4">
        <thead>
          <tr>
            <th>Press</th>
            <th>Needs</th>
            <th>Gives</th>
            <th>Spends</th>
            <th className="num">Cast</th>
            <th className="num">Global CD</th>
            <th className="num">Costs</th>
          </tr>
        </thead>
        <tbody>
          {combo.steps.map((step, i) => (
            <tr key={`${step.spellId ?? "basic"}-${i}`}>
              <td title={step.note}>
                {step.kind === "basic-attack" ? (
                  <em>basic attack</em>
                ) : (
                  <code>{step.spellId}</code>
                )}
              </td>
              <td className="faint">{step.needs.join(", ") || "—"}</td>
              <td className="faint">{step.grants.join(", ") || "—"}</td>
              <td className="faint">{step.spends.join(", ") || "—"}</td>
              <td className="num">
                {step.castSeconds === undefined ? "—" : `${num(step.castSeconds, 2)}s`}
              </td>
              <td className="num">
                {step.globalCooldownSeconds === undefined
                  ? "—"
                  : `${num(step.globalCooldownSeconds, 2)}s`}
              </td>
              <td className="num">
                {step.seconds === undefined ? "?" : `${num(step.seconds, 2)}s`}
                {step.cooldownBound === true && (
                  <span className="badge warn text-xs" style={{ marginLeft: 4 }}>
                    cd
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {combo.broken.map((link) => (
        <div key={link.effectId} className="faint text-sm mt-4">
          <strong>Chain broken:</strong> {link.note} Equip something that grants it, or tick it on
          in Effects to see the number anyway.
        </div>
      ))}

      {combo.broken.length === 0 && combo.secondsPerCast === undefined && (
        <div className="faint text-sm mt-4">
          One step could not be timed, so there is no rate.{" "}
          {combo.steps.find((step) => step.seconds === undefined)?.note}
        </div>
      )}
    </>
  );
}

/**
 * Every charge state the bar can reach, priced, so the choice the figures rest on is visible.
 *
 * `phase_dive` holding all three charges is three extra presses away; holding two is one. The
 * engine keeps whichever lands more damage per second unless the build pins one: a pass played
 * for its heal or its mana — Parallel Convergence holding alpha and beta deals nothing — is a
 * choice the DPS cannot make, so each row can be pinned, and the pin is saved on the skill.
 */
function Rotations({ spellId, rotations }: { spellId: string; rotations: ComboRotation[] }): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setComboHolds = useBuild((s) => s.setComboHolds);
  const index = (doc.skills ?? []).findIndex((skill) => skill.spellId === spellId);
  const pinned = rotations.some((r) => r.pinned);
  const heals = rotations.some((r) => r.restoresPerSecond.some((x) => x.amount > 0));
  return (
    <>
      <div className="faint text-sm mt-4">
        Rotations compared. The numbers above are for the highlighted one. Each counts only this
        skill&apos;s damage, not the presses before it.{" "}
        {pinned
          ? "You picked it; "
          : "The highest DPS is used unless you pick one, for a pass you play for its heal or mana. "}
        {pinned && index >= 0 && (
          <button className="link" onClick={() => setComboHolds(index, undefined)}>
            go back to the highest DPS
          </button>
        )}
      </div>
      <table className="grid mt-4">
        <thead>
          <tr>
            <th>Fires holding</th>
            <th>Presses</th>
            <th className="num">Per pass</th>
            <th className="num">DPS</th>
            {heals && <th className="num">Restores</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rotations.map((rotation, i) => (
            <tr key={i} style={rotation.chosen ? { fontWeight: 600 } : undefined}>
              <td>
                {rotation.holds.length === 0 ? "nothing" : rotation.holds.join(" + ")}
                {rotation.chosen && (
                  <span className="badge text-xs" style={{ marginLeft: 4 }}>
                    {rotation.pinned ? "picked" : "used"}
                  </span>
                )}
              </td>
              <td className="faint">
                {rotation.presses.map((id) => id ?? "basic attack").join(" → ")}
              </td>
              <td className="num">
                {rotation.secondsPerCast === undefined ? "—" : `${num(rotation.secondsPerCast, 2)}s`}
              </td>
              <td className="num">
                {rotation.broken ? (
                  <span className="badge warn text-xs">broken</span>
                ) : rotation.dps === undefined ? (
                  "?"
                ) : (
                  smart(rotation.dps)
                )}
              </td>
              {heals && (
                <td className="num" title="What this skill's own restore effects give back per second on this pass">
                  {rotation.restoresPerSecond.filter((x) => x.amount > 0).length === 0
                    ? "—"
                    : rotation.restoresPerSecond
                        .filter((x) => x.amount > 0)
                        .map((x) => `${smart(x.amount)} ${x.resource.replace(/_/g, " ")}/s`)
                        .join(", ")}
                </td>
              )}
              <td>
                {!rotation.broken && !rotation.chosen && index >= 0 && (
                  <button
                    className="link text-sm"
                    title="Play this pass instead, and use it for every figure"
                    onClick={() => setComboHolds(index, rotation.holds)}
                  >
                    use
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The rate.
 *
 * Every number here is portable from the mod, and since 6.4.13 most of it comes from
 * `cast_speed_ticks` rather than the spell's declared cooldown — a spell can say
 * `cooldown_ticks: 0` and still only go off every 15 ticks, because casting it arms the shared
 * global cooldown for its cast speed. What a cast *produces* is the table below this.
 */
