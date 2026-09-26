import { type FullDpsResult, type FullDpsSkill } from "@cte2/engine";
import { type SkillSetup } from "@cte2/schema";
import { type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
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
 * than from this tick. A **curse** is the same shape with the effect on the other side: you
 * re-cast it when it falls off the pack, not every time its cooldown blinks.
 *
 * An **aura** is a third thing. It is a toggle, so the pass is charged nothing and waits on
 * nothing for it &mdash; but four of them deal damage, and that damage is the effect's own
 * component group ticking on its own `tick_rate`. Holy Fire pulses twice a second whether you
 * are mid-cast, on cooldown or standing still, so it is added here as a **rate** rather than as
 * damage per press, and it is the one term of this figure that does not move when you tick a
 * second skill in beside it.
 *
 * **Procs are in the headline.** Everything the rotation sets off is merged against one shared
 * `proc_cooldown_ticks` ceiling and added, which is the difference between reading a proc-heavy
 * build and reading it as a weak one.
 */
export function FullDpsCard({
  full,
  skills,
  onToggle,
  swingProcDps = 0,
}: {
  full: FullDpsResult | undefined;
  skills: SkillSetup[];
  onToggle: (index: number, include: boolean) => void;
  /**
   * What your weapon swings proc, on the swing's own clock. Shown beside the rotation because
   * the buffs that grant these procs (Whiteout Sovereign, Ice-Tipped Blade) are ticked here, and
   * a rotation that showed nothing for them read as the buffs doing nothing.
   */
  swingProcDps?: number;
}): ReactNode {
  const world = useWorld();
  const setFullDpsAsBuff = useBuild((s) => s.setFullDpsAsBuff);
  if (full === undefined) return null;

  // The toggles and the timed re-presses share one table: both answer "how often do I press this
  // and what does it cost the pass", and splitting them would have put Holy Fire and Banishing
  // Blade on two tables that print the same four columns.
  const upkeep = full.skills.filter((entry) => entry.role !== "rotation");

  return (
    <div className="card">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        {/* Ailments are in the headline, not beside it. They were a figure further along this
            row, which made "Full DPS" a number that left out a rotation's whole cold output for
            a build whose damage is Shatter — and made this card and the sidebar print two
            different numbers under one name. The terms are all still here, to its right. */}
        <Figure
          label="Full DPS"
          value={full.skills.length === 0 ? "—" : smart(full.dps + full.ailmentDps + swingProcDps)}
          hint="All damage from one pass through the ticked skills, including procs, damage over time and what your basic attacks proc, divided by how long it takes. Doesn't include pets or the swings' own hits; Total DPS in the top bar does."
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
                hint="Spells your gear casts during the rotation. Included in Full DPS"
              />
            )}
            {swingProcDps > 0 && (
              <Figure
                label="Swing procs"
                value={smart(swingProcDps)}
                hint="Spells your basic attacks cast while you run this rotation, at your swing rate. Included in Full DPS"
              />
            )}
            {full.auraDps > 0 && (
              <Figure
                label="Auras"
                value={smart(full.auraDps)}
                hint="What the auras you are running pulse for, on their own fixed timing. Part of the Full DPS above, and the one term of it a longer rotation does not dilute."
              />
            )}
            <Figure
              label="Rotation"
              value={`${num(full.rotationSeconds, 2)}s`}
              hint="Casts plus the shared global cooldowns they arm. A buff, a curse and an aura are charged their upkeep, not a cast."
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
                hint="Bleed, ignite and poison across the rotation. Included in Full DPS"
              />
            )}
            {full.ailmentProcDps > 0 && (
              <Figure
                label="Ailment hit DPS"
                value={smart(full.ailmentProcDps)}
                hint="Shatter and Shock releasing the damage built up by freezes and electrifies. Included in Full DPS"
              />
            )}
          </>
        )}
      </div>

      <div className="row wrap gap-6 mt-5">
        {skills.map((skill, index) => {
          const entry = full.skills.find((e) => e.skill === skill);
          // Offered only where it changes something: a skill that hits *and* has an effect to
          // wait on. A pure buff is already upkeep, and a pure hit has nothing to wait for.
          const canBeBuff =
            skill.fullDpsAsBuff === true ||
            (entry !== undefined &&
              entry.role === "rotation" &&
              (entry.result.buff !== undefined || entry.result.debuff !== undefined));
          return (
            <span key={`${skill.spellId}-${index}`} className="row gap-3 text-sm">
              <label className="row gap-3">
                <input
                  type="checkbox"
                  checked={skill.includeInFullDps === true}
                  onChange={(event) => onToggle(index, event.target.checked)}
                />
                <span>{spellName(world.snapshot, skill.spellId)}</span>
                {entry !== undefined && entry.role !== "rotation" ? (
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
              {canBeBuff && (
                <button
                  className={`nudge word${skill.fullDpsAsBuff === true ? " primary" : ""}`}
                  aria-pressed={skill.fullDpsAsBuff === true}
                  title={
                    skill.fullDpsAsBuff === true
                      ? "Pressed only when its buff runs out; its hit counts once per re-cast. Click to put it back in the rotation."
                      : "It deals damage, so it is pressed every pass. Click to press it only when its buff runs out instead."
                  }
                  onClick={() => setFullDpsAsBuff(index, skill.fullDpsAsBuff !== true)}
                >
                  buff only
                </button>
              )}
            </span>
          );
        })}
      </div>

      {upkeep.length > 0 && (
        <table className="grid mt-5">
          <thead>
            <tr>
              <th>Kept up</th>
              <th>Effect</th>
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
                  <td>
                    {spellName(world.snapshot, entry.skill.spellId)}
                    {(entry.auraDps ?? 0) > 0 && (
                      <div className="faint text-xs">pulses for {smart(entry.auraDps ?? 0)}/s</div>
                    )}
                  </td>
                  <td className="mono text-sm">
                    {entry.upkeepEffectId}
                    <div className="faint text-xs">
                      {entry.upkeepHolder === "target" ? "on the pack" : "on you"}
                    </div>
                  </td>
                  <td
                    className="num"
                    title={
                      short
                        ? `It lasts ${num(lasts, 1)}s but cannot be re-cast for ` +
                          `${num(entry.upkeepSeconds ?? 0, 1)}s, so it is down for ` +
                          `${num((entry.upkeepSeconds ?? 0) - lasts, 1)}s of every cycle, but the numbers here ` +
                          "assume it's always up."
                        : entry.upkeepSeconds === Infinity
                          ? "potion_dur: -1, which the game treats as never expiring."
                          : undefined
                    }
                    style={short ? { color: "var(--warn)" } : undefined}
                  >
                    {entry.upkeepSeconds === Infinity
                      ? "never (toggle)"
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
        Tick the skills you actually press. Attacks share a global cooldown, so casting a combo
        starter takes time away from the finisher. That's why this can be lower than the finisher
        alone. A <strong>buff</strong> or <strong>curse</strong> only costs the time to recast it
        when it runs out (never, for a toggle like Banishing Blade). An <strong>aura</strong>{" "}
        costs nothing and adds its own damage. Their stats count whether or not they&apos;re ticked
        here; to remove one, untick <strong>enabled</strong> on the Skills tab.
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
  const kind = entry.role === "aura" ? "aura" : "upkeep";
  if (entry.upkeepSeconds === Infinity) return `${kind} · free`;
  return `${kind} · ${upkeepCost(entry.rotationSeconds)}`;
}

/** What that chip means, spelled out for the hover. */

/** What that chip means, spelled out for the hover. */
function upkeepTitle(entry: FullDpsSkill): string {
  const press = `One press costs ${num(entry.pressSeconds, 2)}s`;
  const pulses =
    (entry.auraDps ?? 0) > 0
      ? ` It pulses for ${smart(entry.auraDps ?? 0)}/s on its own timer while it's up. ` +
        `That's included above.`
      : "";
  if (entry.upkeepSeconds === Infinity) {
    return (
      `${press}, and ${entry.upkeepEffectId} is a toggle that never expires, so it costs the ` +
      `rotation nothing.${pulses}`
    );
  }
  const where = entry.upkeepHolder === "target" ? "falls off the pack" : "runs out";
  return (
    `${press}, and ${entry.upkeepEffectId} ${where} every ` +
    `${num(entry.upkeepSeconds ?? 0, 1)}s, so ${num(entry.pressesPerRotation ?? 0, 3)} presses per ` +
    `pass (${upkeepCost(entry.rotationSeconds)} of it). Its duration sets the pace, not its ` +
    `cooldown.${pulses}`
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
