/**
 * The rarity and roll of a skill-gem-type item — a support gem or an Augment.
 *
 * One control for both because the game stores both as `SkillGemData`, with the same two
 * fields meaning the same two things:
 *
 *     data.rar  = rar.GUID();
 *     data.perc = rar.stat_percents.random();
 *
 * — SkillGemBlueprint.java:32-40. The rarity grants nothing of its own; it is the band the roll
 * came from, and the bands do not overlap. So the slider is bounded by the rarity rather than
 * running the full 0-100, exactly as an affix's is bounded by its tier — a mythic gem cannot
 * be dragged down to 40%, because no mythic gem in the game rolls there.
 */

import { rarityName, type AuraSetup, type SupportLink } from "@cte2/schema";
import type { ReactNode } from "react";

import { useWorld } from "../state/snapshot.js";
import { RollSlider } from "./fields.js";

/** What a gem's `rollPercent` may be, given its rarity. Unstated rarity means unconstrained. */
export function gemBand(
  world: ReturnType<typeof useWorld>,
  rarityId: string | undefined,
): { min: number; max: number } {
  if (rarityId === undefined) return { min: 0, max: 100 };
  return world.rarity(rarityId)?.statPercents ?? { min: 0, max: 100 };
}

/**
 * The rarities a gem can be: the six-step ladder, in order.
 *
 * Filtered from the data rather than listed. A unique-item rarity is not one anything rolls at,
 * and `runeword` is a gear conversion whose band is the whole range — neither is a gem, and
 * both are recognisable by their band carrying no information.
 */
function gemRarities(world: ReturnType<typeof useWorld>): { id: string; min: number; max: number }[] {
  return world.rarities
    .filter((r) => !r.isUniqueItem && r.statPercents.max - r.statPercents.min < 100)
    .map((r) => ({ id: r.id, min: r.statPercents.min, max: r.statPercents.max }));
}

export function GemRarityRoll({
  gem,
  onChange,
}: {
  gem: SupportLink | AuraSetup;
  // `undefined` is meaningful here — it clears the field rather than leaving it alone — so the
  // properties are explicitly nullable rather than merely optional.
  onChange: (next: { rarity?: string | undefined; rollPercent?: number | undefined }) => void;
}): ReactNode {
  const world = useWorld();
  const band = gemBand(world, gem.rarity);
  const ladder = gemRarities(world);

  return (
    <>
      <select
        className={gem.rarity === undefined ? undefined : `rarity-${gem.rarity}`}
        value={gem.rarity ?? ""}
        title="SkillGemData.rar — the band this gem's roll was drawn from"
        onChange={(event) => {
          const rarity = event.target.value;
          if (rarity === "") {
            onChange({ rarity: undefined });
            return;
          }
          // Moving the rarity moves the roll with it, the way the upgrade currency does
          // (`UpgradeSkillGemRarityItemMod` rescales `perc` into the new band). Clamping rather
          // than rescaling, because the roll here is a stated fact and the nearest legal value
          // is a smaller lie than a recomputed one.
          const next = gemBand(world, rarity);
          const roll = gem.rollPercent;
          onChange({
            rarity,
            ...(roll === undefined ? {} : { rollPercent: Math.min(Math.max(roll, next.min), next.max) }),
          });
        }}
      >
        <option value="">rarity?</option>
        {ladder.map((r) => (
          <option key={r.id} value={r.id}>
            {rarityName(world.snapshot, r.id)}
          </option>
        ))}
      </select>

      <RollSlider
        label="roll"
        value={gem.rollPercent ?? band.min}
        min={band.min}
        max={band.max}
        // Worth printing once a rarity narrows it. Without one the band is the whole range and
        // the label would only ever read "0-100%".
        showBand={gem.rarity !== undefined}
        onChange={(rollPercent) => onChange({ rollPercent })}
      />

      {gem.rollPercent === undefined && (
        <span className="badge warn" title="This gem computes at the bottom of its band">
          unset — {band.min}%
        </span>
      )}
    </>
  );
}
