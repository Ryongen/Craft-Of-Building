/**
 * The Augments panel's two wordings.
 *
 * Same rule as the other tables here: an entry exists only because the wording named an
 * internal symbol a player has no use for. `tech` is the sentence that was in the tree,
 * moved across unchanged.
 */

import type { CopyTable } from "./hint.js";

export const AUGMENTS_COPY = {
  overLevel: {
    plain:
      "Exceeds your level limit. If any equipped Augment requires a higher level than your " +
      "character, the game unequips all of them.",
    tech:
      "AuraGem.min_lvl. The game unequips every Augment on the character when one of them is " +
      "above your level, not just this one.",
  },

  rarityBand: {
    plain:
      "The rarity band determining this gem's roll percentage range.",
    tech:
      "SkillGemData.rar — the band this gem's roll was drawn from",
  },
} satisfies CopyTable;
