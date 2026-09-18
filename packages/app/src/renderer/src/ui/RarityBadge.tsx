/**
 * An item's rarity, in the colour the game gives it.
 *
 * `mythic`, `runeword`, `unique` and `epic` all rendered in the same grey as `ilvl 100` and the
 * slot name beside them, so the one property a player sorts their stash by was the one thing on
 * the row with no visual weight. The ladder is in `ui/palette.ts`, authored from
 * `COLOR-CODING.md`, because `GearRarityView` carries the tier and the roll bands but no colour —
 * the mod holds a `ChatFormatting` per rarity in Java and the extractor never sees it.
 *
 * One component rather than a class per rarity, because the set is data: a pack that adds a
 * rarity gets grey here and a line in the palette, not a stylesheet edit.
 */

import type { ReactNode } from "react";

import { RARITY } from "./palette.js";

export function RarityBadge({ rarity, title }: { rarity: string; title?: string }): ReactNode {
  const colour = RARITY[rarity.toLowerCase()];
  return (
    <span
      className="badge rarity"
      title={title}
      style={colour === undefined ? undefined : { color: colour, borderColor: `${colour}55` }}
    >
      {rarity}
    </span>
  );
}
