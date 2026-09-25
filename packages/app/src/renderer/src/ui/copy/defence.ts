/**
 * The Defence tab's two wordings, for the hints that named something internal.
 *
 * Same rule as `stats.ts`: a hint is only here because it had a stat id, a Java method or a pack
 * flag inside a sentence a player reads. The three self-damage badges are the clearest case —
 * "no dodge or block" and "cannot crit" are the facts, and `DamageEvent.canAvoidHit()` is the
 * reason, which is worth showing to whoever is checking the port and to nobody else.
 *
 * `tech` is the existing sentence, moved here unchanged.
 */

import type { CopyTable } from "./hint.js";

export const DEFENCE_COPY = {
  selfDamageUnavoidable: {
    plain: "A hit you deal to yourself has no attacker for you to dodge or block.",
    tech: "DamageEvent.canAvoidHit() is source != target",
  },

  selfDamageCannotCrit: {
    plain: "Self-damage carries none of your offence, so it cannot crit.",
    tech: "no_attacker_stats_on_selfdmg disables the attacker half of the sweep",
  },

  bloodMage: {
    plain: "Blood magic is on: every mana cost is paid from blood",
    tech: "`blood_user` is on: every mana cost is paid from blood",
  },

  magicShield: {
    plain:
      "Absorbs damage before health. Half of chaos damage bypasses it unless your build prevents that",
    tech:
      "Absorbs before health. Half of a chaos hit walks past it unless " +
      "chaos_doesnt_bypass_magic_shield is on",
  },
} satisfies CopyTable;
