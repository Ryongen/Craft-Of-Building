import { type FullDpsResult, type FullDpsSkill } from "@cte2/engine";
import { type SkillSetup } from "@cte2/schema";
import { type ReactNode } from "react";

import { useWorld } from "../../state/snapshot.js";
import { Figure } from "../../ui/Figure.js";
import { num, smart } from "../../ui/fields.js";
import { spellName } from "@cte2/schema";

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
export function FullDpsCard({
  full,
  skills,
  onToggle,
}: {
  full: FullDpsResult | undefined;
  skills: SkillSetup[];
  onToggle: (index: number, include: boolean) => void;
}): ReactNode {
  const world = useWorld();
  if (full === undefined) return null;

  const upkeep = full.skills.filter((entry) => entry.role === "upkeep");

  return (
    <div className="card">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        {/* Ailments are in the headline, not beside it. They were a figure further along this
            row, which made "Full DPS" a number that left out a rotation's whole cold output for
            a build whose damage is Shatter — and made this card and the sidebar print two
            different numbers under one name. The terms are all still here, to its right. */}
        <Figure
          label="Full DPS"
          value={full.skills.length === 0 ? "—" : smart(full.dps + full.ailmentDps)}
          hint="One pass through every ticked skill, everything it procs and everything it leaves burning, divided by how long that pass takes. Pets and the weapon swing are not in it — the topbar's Total DPS has those."
        />
        {full.skills.length > 0 && (
          <>
            <Figure
              label="Skills"
              value={smart(full.skillDps)}
              hint="The casts themselves, without what they set off"
            />
            {full.procDps > 0 && (
              <Figure
                label="Procs"
                value={smart(full.procDps)}
                hint="Spells your gear casts while you press these buttons — part of the Full DPS above"
              />
            )}
            <Figure
              label="Rotation"
              value={`${num(full.rotationSeconds, 2)}s`}
              hint="Casts plus the shared global cooldowns they arm. A buff is charged its upkeep, not a cast."
            />
            <Figure
              label="Per rotation"
              value={smart(full.damagePerRotation)}
              hint="Damage one pass puts on the target, from the casts"
            />
            {full.ailmentDps - full.ailmentProcDps > 0.005 && (
              <Figure
                label="Ailment DPS"
                value={smart(full.ailmentDps - full.ailmentProcDps)}
                hint="Bleed, ignite and poison, summed across the rotation — part of the Full DPS above"
              />
            )}
            {full.ailmentProcDps > 0 && (
              <Figure
                label="Ailment hit DPS"
                value={smart(full.ailmentProcDps)}
                hint="Shatter and Shock releasing what the rotation's freezes and electrifies accumulated — part of the Full DPS above"
              />
            )}
          </>
        )}
      </div>

      <div className="row wrap gap-6 mt-5">
        {skills.map((skill, index) => {
          const entry = full.skills.find((e) => e.skill === skill);
          return (
            <label
              key={`${skill.spellId}-${index}`}
              className="row gap-3 text-sm"
            >
              <input
                type="checkbox"
                checked={skill.includeInFullDps === true}
                onChange={(event) => onToggle(index, event.target.checked)}
              />
              <span>{spellName(world.snapshot, skill.spellId)}</span>
              {entry?.role === "upkeep" ? (
                <span className="badge" title={upkeepTitle(entry)}>
                  {upkeepBadge(entry)}
                </span>
              ) : (
                entry && (
                  <span className="faint">
                    {num(entry.rotationSeconds, 2)}s {"·"} {smart(entry.result.damagePerCast)}
                  </span>
                )
              )}
            </label>
          );
        })}
      </div>

      {upkeep.length > 0 && (
        <table className="grid mt-5">
          <thead>
            <tr>
              <th>Buff</th>
              <th>Keeps up</th>
              <th className="num">Press every</th>
              {/* Two right-aligned columns of prose run into each other without this. */}
              <th className="num" style={{ paddingLeft: 22 }}>
                Costs the pass
              </th>
            </tr>
          </thead>
          <tbody>
            {upkeep.map((entry, i) => {
              // The one case where the two numbers disagree, and the only one worth two columns:
              // a cooldown longer than the effect means the buff is genuinely down part of the
              // time, and every figure on this screen assumes it is not.
              const lasts = entry.upkeepDurationSeconds ?? 0;
              const short = entry.upkeepSeconds !== undefined && entry.upkeepSeconds > lasts;
              return (
                <tr key={`${entry.skill.spellId}-${i}`} className={short ? "highlight" : undefined}>
                  <td>{spellName(world.snapshot, entry.skill.spellId)}</td>
                  <td className="mono text-sm">
                    {entry.upkeepEffectId}
                  </td>
                  <td
                    className="num"
                    title={
                      short
                        ? `It lasts ${num(lasts, 1)}s but cannot be re-cast for ` +
                          `${num(entry.upkeepSeconds ?? 0, 1)}s, so it is down for ` +
                          `${num((entry.upkeepSeconds ?? 0) - lasts, 1)}s of every cycle — and the ` +
                          "stats under every figure here assume it is up throughout."
                        : entry.upkeepSeconds === Infinity
                          ? "potion_dur: -1 — the sentinel the game reads as never expiring."
                          : undefined
                    }
                    style={short ? { color: "var(--warn)" } : undefined}
                  >
                    {entry.upkeepSeconds === Infinity
                      ? "never — a toggle"
                      : short
                        ? `${num(entry.upkeepSeconds ?? 0, 1)}s · lasts ${num(lasts, 1)}s`
                        : `${num(entry.upkeepSeconds ?? 0, 1)}s`}
                  </td>
                  <td className="num" style={{ paddingLeft: 22 }}>
                    {upkeepCost(entry.rotationSeconds)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="faint text-sm mt-3 prose">
        Tick the skills you actually press. Casting an <em>attack</em> arms one shared global
        cooldown, so a combo extender you cast to enable a finisher costs the finisher real time
        &mdash; which is why this reads lower than the finisher on its own, and why that is the
        honest number. A <strong>buff</strong> costs the pass only its upkeep: a toggle such as
        Banishing Blade is pressed once and charged nothing, so ticking it adds what it does and
        takes nothing away. Its stats are on your sheet whether or not it is ticked here &mdash;
        availability comes from the skill bar, and the <strong>enabled</strong> box on the Skills
        tab is the only thing that takes a buff off it.
      </div>
    </div>
  );
}

/**
 * What a buff's upkeep costs the pass, in words rather than in three decimal places.
 *
 * A toggle costs exactly zero and a ten-minute buff costs a third of a millisecond, and printing
 * "0.000s" for the second one reads as a rounding failure rather than as the answer.
 */

/**
 * What a buff's upkeep costs the pass, in words rather than in three decimal places.
 *
 * A toggle costs exactly zero and a ten-minute buff costs a third of a millisecond, and printing
 * "0.000s" for the second one reads as a rounding failure rather than as the answer.
 */
function upkeepCost(seconds: number): string {
  if (seconds <= 0) return "nothing";
  if (seconds < 0.005) return "under 0.01s";
  return `${num(seconds, 2)}s`;
}

/** The chip beside a ticked buff: what it costs the pass, at a glance. */

/** The chip beside a ticked buff: what it costs the pass, at a glance. */
function upkeepBadge(entry: FullDpsSkill): string {
  if (entry.upkeepSeconds === Infinity) return "upkeep · free";
  return `upkeep · ${upkeepCost(entry.rotationSeconds)}`;
}

/** What that chip means, spelled out for the hover. */

/** What that chip means, spelled out for the hover. */
function upkeepTitle(entry: FullDpsSkill): string {
  const press = `One press costs ${num(entry.pressSeconds, 2)}s`;
  if (entry.upkeepSeconds === Infinity) {
    return (
      `${press}, and ${entry.upkeepEffectId} never expires — it is a toggle, so you press it once ` +
      `and the rotation is charged nothing for it.`
    );
  }
  return (
    `${press}, and ${entry.upkeepEffectId} has to be re-cast every ` +
    `${num(entry.upkeepSeconds ?? 0, 1)}s — ${num(entry.pressesPerRotation ?? 0, 3)} presses per ` +
    `pass, so ${upkeepCost(entry.rotationSeconds)} of it.`
  );
}

/**
 * Whether the pools keep up, and what happens when they do not.
 *
 * Three incomes and one spend, and the game meters two of the three. Regeneration is a restore
 * event once a second with `<r>_regen`, `<r>_per_sec` and every `on_restore_resource` percent
 * feeding it; leech is banked and paid out at `<r>_leech_cap`% of the pool per second — base 5,
 * so a build that leeches hard is usually throwing most of it away and the number worth improving
 * is the pool, not the leech. The spend is this cast at this rate.
 *
 * `in_combat` is a ten-second cooldown re-stamped by every hit you land or take, so the column
 * used here is the in-combat one. Anything gated on `is_in_combat_is_false` — `out_of_combat_regen`
 * — is worth nothing during a rotation, however good it looks on the Defence tab.
 */
