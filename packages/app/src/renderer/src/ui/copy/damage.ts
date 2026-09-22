/**
 * The Damage tab's two wordings, for the hints that named a stat or a pack field.
 *
 * Same rule as the other tables here: an entry exists only because the wording named an
 * internal symbol a player has no use for. `tech` is the sentence that was in the tree,
 * moved across unchanged.
 */

import type { CopyTable } from "./hint.js";

export const DAMAGE_COPY = {
  bloodUser: {
    plain:
      "Every mana and energy cost is paid from blood instead.",
    tech:
      "`blood_user`: every mana and energy cost is paid from blood",
  },

  dmgEffectiveness: {
    plain:
      "Damage effectiveness — how much of your added damage this attack or spell carries.",
    tech:
      "dmg_effectiveness — how much of your added damage this act carries",
  },

  triggeredBySkill: {
    plain:
      "Triggered automatically by another skill in your rotation. Full DPS includes its damage.",
    tech:
      "Gated off this skill by a `spell_has_tag`, and fired by another skill you ticked into " +
      "the rotation. The Full DPS figure counts them.",
  },
} satisfies CopyTable;
