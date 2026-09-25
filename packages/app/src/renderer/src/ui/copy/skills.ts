/**
 * The Skills tab's two wordings, including the basic attack card and the gem pickers.
 *
 * Same rule as the other tables here: an entry exists only because the wording named an
 * internal symbol a player has no use for. `tech` is the sentence that was in the tree,
 * moved across unchanged.
 */

import type { CopyTable } from "./hint.js";

export const SKILLS_COPY = {
  attackDamageCompat: {
    plain:
      "Weapon attack damage counts as total damage at half value.",
    tech:
      "attack_damage_compat converts it at 0.5x into total_damage",
  },

  capturedRate: {
    plain:
      "The imported rate already includes your attack speed, so it won't change when you edit " +
      "attack speed.",
    tech:
      "Your capture's attribute already has this build's attack_speed baked into it, so the " +
      "rate cannot respond to an edit until the two halves are separated.",
  },

  gemCostMulti: {
    plain:
      "Resource cost multiplier applied by this support gem.",
    tech:
      "SocketedGem.getManaCostMulti",
  },

  gemCostMultiAll: {
    plain:
      "All linked support gems' cost multipliers combined, for both mana and energy. Disabled " +
      "gems cost nothing.",
    tech:
      "SocketedGem.getManaCostMulti: each linked gem's `manaMulti`, multiplied together and " +
      "applied to both the mana and the energy cost. A gem switched off is an empty socket and " +
      "charges nothing.",
  },

  gemCostMultiOne: {
    plain:
      "This gem's cost multiplier on its own. The total above combines all linked gems.",
    tech:
      "SocketedGem.getManaCostMulti for this gem alone. The heading above multiplies every " +
      "socketed gem's together.",
  },

  requiredLevel: {
    plain:
      "Character level needed to use this spell.",
    tech:
      "Spell.getRequiredLevel: the character level gate",
  },

  unarmedValue: {
    plain:
      "A weapon is equipped but attack damage is still the unarmed value, so every damage " +
      "number here is too low.",
    tech:
      "A weapon is equipped but this is still the bare-handed value, so total_damage reads zero " +
      "and every damage number on the page is low.",
  },

  weaponRate: {
    plain:
      "The weapon's base attack rate multiplied by your attack speed.",
    tech:
      "The weapon's own rate times your attack_speed stat",
  },
} satisfies CopyTable;
