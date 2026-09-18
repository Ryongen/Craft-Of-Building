import { type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

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
  if (combo === undefined) return null;

  return (
    <div className="card">
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
            hint="One pass: every step pressed once, each costing its cast plus the global cooldown it arms"
          />
        )}
        {dps.comboDps !== undefined && (
          <Figure
            label="Combo DPS"
            value={smart(dps.comboDps)}
            hint="This skill at the chain's rate rather than its own. The other presses do damage too — tick them into Full DPS for the rotation's total"
          />
        )}
        {combo.resources.length > 0 && (
          <Figure
            label="Fires holding"
            value={combo.holds.length === 0 ? "nothing" : combo.holds.join(" + ")}
            hint={
              `This skill spends ${combo.resources.join(", ")}, and branches on which of them ` +
              `are up — the pack writes one branch per combination, each with its own damage. ` +
              `The figures above are the branch this rotation actually reaches` +
              (combo.holds.length === combo.resources.length
                ? "."
                : `; the rest of the table is what you are not getting.`)
            }
          />
        )}
      </div>

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
    </div>
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
