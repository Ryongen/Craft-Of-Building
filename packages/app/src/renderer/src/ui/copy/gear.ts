/**
 * The Items tab's two wordings — gear, jewels and omens.
 *
 * Same rule as the other tables here: an entry exists only because the wording named an
 * internal symbol a player has no use for. `tech` is the sentence that was in the tree,
 * moved across unchanged.
 */

import type { CopyTable } from "./hint.js";

export const GEAR_COPY = {
  omenAffixRarity: {
    plain:
      "An omen's affix shares the rarity of the omen itself.",
    tech:
      "AffixData.rar — an omen's affix takes the omen's rarity",
  },

  omenAffixRoll: {
    plain:
      "Uses the same roll percentage as the omen's own stats.",
    tech:
      "AffixData.p — the same derived percent as the omen's own mods",
  },

  overSocketCount: {
    plain:
      "Exceeds your jewel socket limit — the game unequips it.",
    tech:
      "Past the jewel_socket count — the game unequips it",
  },

  sharedSockets: {
    plain:
      "Gems and runes share the same sockets, so socketing either reduces the remaining open slots.",
    tech:
      "GearSocketsData.so holds gems and runes in one list; getEmptySockets() subtracts the " +
      "whole list.",
  },

  vanillaAttribute: {
    plain:
      "Vanilla Minecraft attribute, converted into modded stats.",
    tech:
      "Minecraft's own, converted by mmorpg_stat_compat",
  },
} satisfies CopyTable;
