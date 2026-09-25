/**
 * The Stats drill-down's two wordings, for the hints that had something technical in them.
 *
 * Only the leaking ones are here. `SheetDetail` has around fifty hints and most of them already
 * say what the number is — "Armed by this cast and shared with every other skill", "The share of
 * the damage above that never lands" — so they stay inline as bare strings. A hint earns an entry
 * in this table by naming a stat id, a Java method or a pack field in the middle of a sentence.
 *
 * `tech` is the sentence that was in the tree before this table existed, moved across word for
 * word. Nothing in it is new writing, and nothing in it should become new writing: it is the
 * wording you want when you are checking a figure against the game, and it is worth exactly as
 * much as it is accurate.
 */

import type { CopyTable } from "./hint.js";

export const STATS_COPY = {
  castTime: {
    plain: "The spell's own cast time, sped up by your cast or attack speed.",
    tech: "cast_time_ticks, divided by your cast or attack speed.",
  },

  timesToCast: {
    plain: "One press fires the spell more than once.",
    tech: "times_to_cast: one press fires the spell more than once.",
  },

  chargeRate: {
    plain: "A charge spell's rate is how fast a charge comes back, not its cooldown.",
    tech:
      "A charge spell's rate is how fast a charge comes back, not its cooldown. The game " +
      "force-writes cooldown_ticks to 3 when charges are declared.",
  },

  castSpeedBound: {
    plain:
      "Limited by your cast speed, not the cooldown. You wait for whichever is longer.",
    tech:
      "Bound by cast speed rather than by the spell's own cooldown: getEffectiveCooldownTicks " +
      "is max(cooldown_ticks, cast_speed_ticks).",
  },

  ownCooldown: {
    plain: "The spell's own cooldown, reduced by your cooldown recovery.",
    tech: "The spell's own cooldown, reduced by cdr.",
  },

  critMultiLead: {
    plain:
      "What a crit is really worth on this skill: crit damage divided by non-crit damage. It " +
      "includes double damage and conversions, so it can be higher than your crit damage stat.",
    tech:
      "What a crit is actually worth on this skill, measured rather than read off a stat: the " +
      "crit branch divided by the non-crit one. Double damage and the conversion children are " +
      "inside it, which is why it is not simply 1 + critical_damage.",
  },

  hitChanceLead: {
    plain:
      "How many of this skill's hits the target doesn't dodge. Every damage number already " +
      "averages this in.",
    tech:
      "The share of this skill's hits the target does not dodge (damage_block's multiplier). It " +
      "is already folded into every damage figure, as expectation rather than as a roll, so this " +
      "says how much of the number above is the miss.",
  },

  ailmentAlsoLands: {
    plain: "The original hit still lands. The release is a separate hit.",
    tech:
      "It lands as well. The two are separate events: `shatterAccumulated` fires an " +
      "`EventBuilder.ofDamage` of its own.",
  },

  selfDamageTaken: {
    plain:
      "Your armour and resists apply. Your damage and crit bonuses don't.",
    tech:
      "Your armour, your resists and your dmg_received. Increases to damage and crit do not " +
      "apply (no_attacker_stats_on_selfdmg switches the attacker half of the sweep off), but " +
      "mitigation does.",
  },

  selfDamageShield: {
    plain:
      "Magic shield absorbs before health. With no magic shield, shield regeneration does nothing here.",
    tech:
      "First, because the shield absorbs before health does. A build with no magic shield pays " +
      "nothing from here, however much magic_shield_regen its gear rolls.",
  },

  costBase: {
    plain: "The spell's cost, multiplied by every linked support gem.",
    tech: "mana_cost or ene_cost on the spell, times the product of the gems' manaMulti.",
  },

  inCombat: {
    plain:
      "You stay in combat for ten seconds after every hit, so out-of-combat bonuses do nothing " +
      "during a rotation.",
    tech:
      "in_combat is a ten-second cooldown that every hit re-stamps, so a rotation never leaves " +
      "it. Anything gated on being out of combat is worth nothing here.",
  },

  procShared: {
    plain:
      "Counted once across the rotation with one shared proc cooldown, not per skill.",
    tech:
      "Merged across the whole pass against one shared set of `proc_cooldown_ticks`, not added " +
      "up per skill.",
  },
} satisfies CopyTable;
