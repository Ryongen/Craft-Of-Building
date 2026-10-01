import { procChain } from "@cte2/engine";
import { spellName } from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";

/**
 * Procs of procs: what the chain this skill starts settles at, simulated tick by tick.
 *
 * The Procs card above counts what this skill's own hits trigger and stops there. A proc build
 * does not — the spells it casts proc more spells, and the pets it summons bite and proc again —
 * so that card is a floor. This is the chain, run on the game's clock: hits that land on the same
 * tick race for one proc cooldown, a summon's procs can never summon, and the pressed skill only
 * starts it.
 *
 * Rendered only inside an open card, because it runs a simulation (a tenth of a second or so on a
 * large build) and most readers never open it.
 */
export function ProcChainCard(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const world = useWorld();
  const chain = useMemo(() => {
    try {
      return procChain(doc, world.snapshot);
    } catch {
      return undefined;
    }
  }, [doc, world.snapshot]);

  if (chain === undefined) {
    return (
      <div className="card faint text-sm">
        Nothing this skill procs goes on to proc anything else, so the Procs card is the whole story.
      </div>
    );
  }

  const lost = chain.spells.reduce((sum, s) => sum + s.blockedPerSecond, 0);
  return (
    <div className="card">
      <div className="row wrap gap-7" style={{ alignItems: "baseline" }}>
        <Figure
          label="Chain DPS"
          value={smart(chain.dps)}
          hint="Everything the chain casts once it has built up, pets included; this skill's own hits are not in it. Averaged over five simulated minutes."
        />
        {chain.rampSeconds !== undefined && (
          <Figure
            label="Builds up in"
            value={`${chain.rampSeconds}s`}
            hint="From the first press until two seconds in a row average 90% of the chain DPS."
          />
        )}
        {chain.petsAlive > 0 && (
          <Figure label="Pets alive" value={num(chain.petsAlive, 1)} hint="On average, once it has built up." />
        )}
        <Figure
          label="Lost to cooldowns"
          value={`${num(lost, 1)}/s`}
          hint="Procs that rolled successfully but found their spell still on its proc cooldown, usually because something else got there first on the same tick or just before."
        />
      </div>

      <table className="grid mt-4">
        <thead>
          <tr>
            <th>Spell</th>
            <th className="num">Casts/s</th>
            <th className="num" title="20 / proc_cooldown_ticks: the most it can fire">
              Cap
            </th>
            <th className="num" title="Rolls that succeeded while the spell was on its proc cooldown">
              Lost/s
            </th>
            <th className="num" title="Share of its casts a pet's hit started. A pet's procs can never summon.">
              From pets
            </th>
            <th className="num">DPS</th>
          </tr>
        </thead>
        <tbody>
          {chain.spells.map((s) => (
            <tr key={s.spellId}>
              <td>{spellName(world.snapshot, s.spellId)}</td>
              <td className="num">{num(s.castsPerSecond, 2)}</td>
              <td className="num">{num(s.capPerSecond, 1)}</td>
              <td className="num">{num(s.blockedPerSecond, 2)}</td>
              <td className="num">{num(s.fromSummons * 100, 0)}%</td>
              <td className="num">{smart(s.dps)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="faint text-xs mt-4">
        First seconds after the first press:{" "}
        {chain.rampDps.map((d) => smart(d)).join(" → ")}
      </div>
      <div className="faint text-xs mt-4">
        Not modelled: procs spend mana or energy, and a chain that outruns your pool stops. Kill and
        when-hit procs are left out, as on the Procs card.
      </div>
    </div>
  );
}
