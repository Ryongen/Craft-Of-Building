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
      "Converts weapon attack damage at half efficiency into total damage.",
    tech:
      "attack_damage_compat converts it at 0.5x into total_damage",
  },

  capturedRate: {
    plain:
      "Your imported data has attack speed pre-calculated into the rate, so the value cannot " +
      "update until base weapon speed and attack speed bonuses are separated.",
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
      "The combined resource multiplier of all linked support gems, applied to both mana and " +
      "energy costs. Disabled gems act as empty sockets and cost nothing.",
    tech:
      "SocketedGem.getManaCostMulti — each linked gem's `manaMulti`, multiplied together and " +
      "applied to both the mana and the energy cost. A gem switched off is an empty socket and " +
      "charges nothing.",
  },

  gemCostMultiOne: {
    plain:
      "The resource multiplier for this support gem alone. The total multiplier above combines " +
      "all linked gems.",
    tech:
      "SocketedGem.getManaCostMulti — this gem alone. The heading above multiplies every " +
      "socketed gem's together.",
  },

  requiredLevel: {
    plain:
      "The required character level to learn or cast this spell.",
    tech:
      "Spell.getRequiredLevel — the character level gate",
  },

  unarmedValue: {
    plain:
      "A weapon is equipped but attack damage is still set to unarmed, leaving total damage at " +
      "zero and making all damage figures artificially low.",
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
