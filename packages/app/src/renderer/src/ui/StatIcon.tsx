/**
 * A stat's icon: the pack's own texture where there is one, its glyph where there is not.
 *
 * One component rather than an `<img>` at each call site, because the fallback is the whole
 * point. Roughly a quarter of the stats this app can show have no texture — `stat-look.ts`
 * resolves the aliases it can and gives up honestly on the rest — and a row whose icon column
 * is sometimes an image and sometimes empty reads as a rendering bug rather than as a stat the
 * pack never drew. The glyph keeps the column occupied and keeps the label in the same place
 * down the whole list.
 *
 * `image-rendering: pixelated` is not a flourish: these are 16px and 32px textures from a
 * Minecraft resource pack, and the browser's default smoothing turns them into smears at the
 * size the sheet draws them.
 */

import type { ReactNode } from "react";

import { useWorld } from "../state/snapshot.js";
import { statLook } from "./stat-look.js";

export function StatIcon({
  statId,
  size = 14,
  title,
}: {
  statId: string;
  size?: number;
  /** Only where the icon is the row's whole label. A row that names the stat needs no hover. */
  title?: string;
}): ReactNode {
  const world = useWorld();
  const look = statLook(world.snapshot, statId);
  const url = look.iconPath === undefined ? null : world.icon(look.iconPath);

  if (url === null) {
    return (
      <span
        className="stat-icon glyph"
        style={{ width: size, height: size, color: look.colour, fontSize: size - 2 }}
        title={title}
      >
        {look.glyph}
      </span>
    );
  }

  return (
    <img
      className="stat-icon"
      src={url}
      width={size}
      height={size}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

/**
 * Any texture the pack ships, by resource path.
 *
 * For the icons that are not a stat's: the tab strip, a section heading, a spell school. Renders
 * nothing at all when the path did not extract, because these sit beside a word that already
 * says what the thing is — an empty square next to "Damage" is worse than no square.
 */
export function PackIcon({
  path,
  size = 14,
  title,
}: {
  path: string;
  size?: number;
  title?: string;
}): ReactNode {
  const world = useWorld();
  const url = world.icon(path);
  if (url === null) return null;
  return (
    <img
      className="stat-icon"
      src={url}
      width={size}
      height={size}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

/**
 * The colour a stat's own numbers are printed in.
 *
 * Exported beside the icon because the two always travel together — an icon that is fire red
 * over a value that is default grey is worse than either alone.
 */
export function useStatColour(statId: string): string {
  const world = useWorld();
  return statLook(world.snapshot, statId).colour;
}
