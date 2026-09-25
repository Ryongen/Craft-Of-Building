/**
 * The sprite the game draws a piece of gear with.
 *
 * One component rather than an `<img>` at each call site, because the resolution rule is not
 * obvious and the fallback is the whole point. A gear base names the Minecraft items it can roll
 * as — `possible_items` is a rarity ladder — and the extractor follows each one's model and
 * parent chain to a texture, so which item id has a sprite is a fact about the pack rather than
 * about the base. `world.gearIcon` is that lookup, memoised per base.
 *
 * It renders **nothing** when nothing resolves, rather than a placeholder. The only gear that
 * fails to resolve is vanilla, whose textures live in the client jar rather than under `mods/`;
 * the extractor reports those as unresolved on purpose (see `item-icons.ts`), and a wrong glyph
 * beside the right name is worse than no glyph. Call sites that need the space held open — the
 * item window's icon frame — draw their own frame and leave it empty.
 *
 * `image-rendering: pixelated` is not a flourish: these are 16px textures from a Minecraft
 * resource pack, and the browser's default smoothing turns them into smears at the size the app
 * draws them.
 */

import { allocatedSchools, baseGearType } from "@cte2/schema";
import type { ReactNode } from "react";

import cryoSpear from "../assets/cryo-spear.png";
import { useBuild } from "../state/build-store.js";
import { useWorld } from "../state/snapshot.js";

/**
 * Pass the item's `rarity` and `runeword`: a runeword spear on a Cryolancer is drawn with its own
 * sprite instead of the base's. An easter egg, not a fact about the pack. The rarity counts on its
 * own, since a fresh runeword-rarity item has no runeword picked yet.
 */
export function GearIcon({
  baseId,
  rarity,
  runeword,
  size = 20,
}: {
  baseId: string;
  rarity?: string | undefined;
  runeword?: string | undefined;
  size?: number;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((state) => state.doc);
  // `character.school` is only set by an import; points spent in the app land in `schools`.
  const cryoEgg =
    (runeword !== undefined || rarity?.toLowerCase() === "runeword") &&
    baseGearType(world.snapshot, baseId)?.weaponType === "spear" &&
    (doc.character.school === "cryolancer" ||
      allocatedSchools(world.snapshot, doc).includes("cryolancer"));
  return <Sprite url={cryoEgg ? cryoSpear : world.gearIcon(baseId)} size={size} />;
}

/**
 * The same sprite, for an item that has no gear base to be found through.
 *
 * A jewel is the case: it is one of four `SlashItems` chosen by play style, not a
 * `mmorpg_base_gear_types` entry, so `jewelItemId` names the item directly and this draws it.
 * Everything else — the fallback to nothing, the pixelated scaling — is `GearIcon`'s.
 */
export function ItemIcon({ itemId, size = 20 }: { itemId: string; size?: number }): ReactNode {
  return <Sprite url={useWorld().itemIcon(itemId)} size={size} />;
}

/** The `<img>` both of the above are, once the URL is resolved. */
function Sprite({ url, size }: { url: string | null; size: number }): ReactNode {
  if (url === null) return null;
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ imageRendering: "pixelated", flex: "0 0 auto" }}
    />
  );
}
