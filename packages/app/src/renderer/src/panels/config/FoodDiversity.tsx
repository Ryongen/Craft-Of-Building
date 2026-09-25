/**
 * Solonion's food-diversity count.
 *
 * It is worth surfacing at all because it is invisible everywhere else: eating distinct foods
 * grants vanilla attributes, `mmorpg_stat_compat` converts those into real stats, and the result
 * is health, magic shield, dodge and weapon damage a player cannot account for by looking at
 * their gear.
 *
 * It sits on the Config tab because that is where the rest of the character's *declared* state
 * lives — the things a document asserts about a character that nothing in the build itself
 * implies. It had a tab of its own before, with the stat points and the two weapon fields, and
 * every one of those belonged somewhere else.
 *
 * ## It is editable on a capture, and that is the fix rather than the bug
 *
 * The field used to be disabled whenever `character.attributes` was present, on the reasoning
 * that a capture already includes food diversity. That is true of
 * `minecraft:generic.max_health` and false of everything else the benefits grant: the `kubejs:`
 * attributes are server-derived and the in-game exporter reads them client-side, so they come
 * back **0**. On the reference capture that is `weapon_damage`, `armor`, `magic_shield`, `dodge`
 * and `all_attributes` — all missing, with a warning on screen saying they had been counted
 * already.
 *
 * `collectStatCompat` now merges the two per attribute: the capture wins wherever it actually
 * recorded a value, and the stated diversity fills the rest. So the box does something on an
 * imported build, and nothing is counted twice.
 */

import type { ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField } from "../../ui/fields.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

export function FoodDiversity(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setFoodDiversity = useBuild((s) => s.setFoodDiversity);
  const derived = useDerived();

  const config = snapshot.externalConfig?.foodDiversity;
  if (!config || config.benefits.length === 0) return null;

  const captured = doc.character.attributes !== undefined;
  const count = doc.character.foodDiversity ?? 0;

  // The next threshold worth eating toward, so the number means something.
  const thresholds = [...new Set(config.benefits.map((b) => b.threshold))].sort((a, b) => a - b);
  const next = thresholds.find((t) => t > count);
  const active = config.benefits.filter((b) => b.threshold <= count);

  // What the merge actually did, read back off the engine rather than predicted here.
  const filled = derived.diagnostics.find((d) => d.code === "food-diversity-filled-gaps");

  return (
    <>
      <div className="section-title">Food diversity</div>
      <div className="card">
        <div className="row wrap">
          <NumberField
            value={count}
            min={0}
            max={config.trackCount}
            width={64}
            onChange={(value) => setFoodDiversity(value)}
          />
          <span className="faint text-sm">
            distinct foods eaten (max {config.trackCount})
          </span>
          <span className="badge">
            {active.length} of {config.benefits.length} benefits
          </span>
          {next !== undefined && (
            <span className="faint text-sm">next at {next} foods</span>
          )}
        </div>

        {captured && (
          <div className="notice mt-3">
            <Plain>
              This build has attributes captured from the game, and those take priority, so a
              captured maximum health isn't counted twice.{" "}
            </Plain>
            <Tech>
              This build carries <code>character.attributes</code> captured from the game. Those win
              wherever the game actually reported a value, so a captured{" "}
              <code>max_health</code> keeps its number and is not counted twice.{" "}
            </Tech>
            {filled === undefined ? (
              <>
                Nothing here needed filling in: every attribute these benefits grant was already
                in the capture.
              </>
            ) : (
              <>{filled.message.replace(/`/g, "")}</>
            )}
          </div>
        )}

        <>
        <Plain>
          <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
            These grant vanilla attributes that the game turns into health, magic shield, dodge and weapon damage. The exporter can't read them, so set them here even on imported builds. {config.resetOnDeath ? " Diversity resets on death in this pack." : ""}
          </div>
        </Plain>
        <Tech>
          <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
            These grant vanilla attributes, which <code>mmorpg_stat_compat</code> converts into real
            stats (health, magic shield, dodge and weapon damage among them). Nothing about your gear
            reveals them, and the in-game exporter reads the <code>kubejs:</code> ones as zero, which
            is why this box still matters on an imported build.
            {config.resetOnDeath ? " Diversity resets on death in this pack." : ""}
          </div>
        </Tech>
        </>
      </div>
    </>
  );
}
