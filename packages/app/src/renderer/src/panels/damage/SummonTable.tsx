import { type SummonOutput } from "@cte2/engine";
import { type ReactNode } from "react";

import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { spellName } from "@cte2/schema";

/**
 * What your pets do, which for a summoner is the whole of what the button does.
 *
 * A summon skill declares no `damage` act at all, so its own DPS is zero and everything it is
 * worth lives here. The three columns that are not the number are the three things a player will
 * want to argue with: how many pets, how fast each one swings, and why.
 *
 * The swing rate is vanilla's AI and **not** your attack speed — `MeleeAttackGoal` reads no
 * attribute, so a summoner stacking attack speed does not make their zombies bite faster. That is
 * counter-intuitive enough to say on screen rather than leave to a hover.
 */
export function SummonTable({
  summons,
  total,
}: {
  summons: readonly SummonOutput[];
  total: number;
}): ReactNode {
  const world = useWorld();
  if (summons.length === 0) return null;

  return (
    <div className="card">
      <div className="row wrap gap-7" style={{ alignItems: "baseline" }}>
        <span className="faint text-sm" style={{ fontWeight: 600 }}>
          Summons
        </span>
        <Figure
          label="Summon DPS"
          value={smart(total)}
          hint="Your pets, on their own clock. A summon skill declares no damage act of its own, so for those this is the entire output of the button."
        />
      </div>

      <table className="grid mt-4">
        <thead>
          <tr>
            <th>Pet</th>
            <th>Attacks with</th>
            <th className="num">Alive</th>
            <th className="num">Every</th>
            <th className="num">Per hit</th>
            <th className="num">DPS</th>
          </tr>
        </thead>
        <tbody>
          {summons.map((pet) => (
            <tr key={`${pet.petId}:${pet.basicSpellId}`}>
              <td>
                {pet.petId.replace(/^.*:/, "").replace(/_/g, " ")}
                <div className="faint text-xs">
                  {pet.summonType.toLowerCase()}
                  {Number.isFinite(pet.lifeSeconds)
                    ? `, ${num(pet.lifeSeconds, 0)}s each`
                    : ", permanent"}
                </div>
              </td>
              <td>
                {spellName(world.snapshot, pet.basicSpellId)}
                {pet.extraSpells.map((cast) => (
                  <div key={cast.spellIds.join()} className="faint text-xs">
                    + {cast.spellIds.map((id) => spellName(world.snapshot, id)).join(" / ")} at{" "}
                    {num(cast.chance, 0)}% — {num(cast.perSecond, 2)}/s
                  </div>
                ))}
              </td>
              <td className="num" title={pet.countNote}>
                {num(pet.count, 2)}
              </td>
              <td
                className="num"
                title={
                  pet.attackKind === "ranged"
                    ? "A skeleton draws its bow: vanilla's RangedBowAttackGoal waits its interval and then spends 20 more ticks drawing. Your attack speed does not change it."
                    : "Vanilla's MeleeAttackGoal, which resets to 20 ticks. It reads no attribute, so your attack speed does not change it."
                }
              >
                {num(pet.attackSeconds, 2)}s
              </td>
              <td className="num">{smart(pet.damagePerAttack)}</td>
              <td className="num">{smart(pet.dps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
