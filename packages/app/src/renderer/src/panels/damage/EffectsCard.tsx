import { type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { AddEffect, AssumeSwitch, EffectToggles } from "../../ui/Effects.js";

/**
 * What the build is assumed to have up, and what that switches on.
 *
 * A third of the pack's skills are branch tables keyed on exile effects — which stance you are
 * in, which aura you run, whether you are at four `overheat` stacks — and a branch whose gate
 * fails produces nothing at all. So this is not a cosmetic toggle list: it decides which half of
 * `soul_siphon` exists, and it is the same list, writing to the same place, as the one in the
 * Config tab. Turning a buff off here takes it off the character's sheet too.
 *
 * Only effects the build can actually produce are offered, and each says what would produce it.
 */
export function EffectsCard({ dps }: { dps: DpsResult }): ReactNode {
  const setEffect = useBuild((s) => s.setEffect);
  const blocked = dps.model.blockedBy;

  if (dps.effects.options.length === 0 && blocked.length === 0) return null;

  // A gate that failed is the one case where the toggle list has something specific to say, so it
  // says it next to a switch rather than as a sentence the reader has to translate into an action.
  // A `caster_has_potion` gate is deliberately not in here. It is world state rather than
  // something the build applies, so there is no switch on this card that could answer it and
  // `setEffect` would write a `config.effects` entry naming a vanilla mob effect. The engine
  // reports it as `branch-gated-on-potion` with the `config.conditions` key instead.
  const wanted = new Map<string, { acts: number; negated: boolean; stacks: number }>();
  for (const b of blocked) {
    if (b.requirement.kind !== "exile_effect") continue;
    const found = wanted.get(b.requirement.effectId);
    if (found) found.acts += b.damageActs;
    else
      wanted.set(b.requirement.effectId, {
        acts: b.damageActs,
        negated: b.requirement.negated,
        stacks: b.requirement.minimumStacks,
      });
  }

  return (
    <div className="card">
      <div className="row wrap gap-7 mb-4" style={{ alignItems: "baseline" }}>
        <span className="faint text-sm" style={{ fontWeight: 600 }}>
          Effects assumed up
        </span>
        <span className="faint text-sm">
          only what this build can apply — a skill, a stat or an aura that grants it
        </span>
        <AssumeSwitch effects={dps.effects} />
      </div>

      <EffectToggles effects={dps.effects} />

      {wanted.size > 0 && (
        <div className="mt-5">
          <div className="faint text-sm mb-2">
            Branches switched off — turn one of these on to count them:
          </div>
          <div className="row wrap gap-5">
            {[...wanted].map(([id, need]) => (
              <button
                key={id}
                className="chip text-sm"
                title={
                  need.negated
                    ? `A branch worth ${need.acts} damage act(s) only fires while ${id} is *not* up.`
                    : `A branch worth ${need.acts} damage act(s) needs ${id}` +
                      `${need.stacks > 1 ? ` at ${need.stacks} stacks` : ""}. ` +
                      `Nothing in this build grants it, or it is switched off.`
                }
                onClick={() =>
                  setEffect(id, need.negated ? false : need.stacks > 1 ? need.stacks : true)
                }
              >
                {need.negated ? `without ${id}` : id}
                {need.stacks > 1 && !need.negated ? ` x${need.stacks}` : ""}
                <span className="faint"> ({need.acts})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <AddEffect effects={dps.effects} />
    </div>
  );
}

/**
 * What this skill does that the figure above does not include.
 *
 * `SkillModel` has always recorded these three and they reached only the Diagnostics tab — which
 * is where you look when something is wrong, not where you look while you are choosing a skill.
 * A number with a known hole in it should say so beside the number.
 *
 * The three are different admissions and are worth keeping apart:
 *
 *   - **unreachable groups** — a component group nothing in the tree spawns or invokes. Usually a
 *     branch gated off by an effect you do not have, and the blocked-gate list says which;
 *     sometimes a group with a different driver entirely, which is what every pet basic attack
 *     turned out to be.
 *   - **unmodelled acts** — an act type the walk does not interpret. It may well do nothing to
 *     damage, but the model cannot say that, so it says it does not know.
 *   - **unmodelled summons** — something put in the world that fights for you and is not counted.
 *     Mine and Slash's own pets *are* counted now, so anything left here is a vanilla entity
 *     whose damage is on no stat sheet at all.
 */
/** Ids as `<code>` spans with commas between them — a joined HTML string would render as text. */
