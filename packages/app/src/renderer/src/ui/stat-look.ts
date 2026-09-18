/**
 * What a stat looks like: its icon and its colour, in one answer.
 *
 * ## Why the pack cannot be asked
 *
 * `statDisplay` reads presentation off `mmorpg_stat`, and on this pack that registry has almost
 * nothing to say. Of its 832 stats **593 declare `format: aqua` and 191 declare no format at
 * all**, so five stats in six resolve to the same cyan; `icon` is one of five unicode glyphs,
 * with `★` covering everything that does not declare one. Worse, the stats a build is actually
 * read by — `health`, `armor`, `dodge`, every resist — are registered in Java with no JSON, so
 * the extractor never sees them and they take the defaults wholesale. That is why the sheet was
 * a column of identical cyan stars: not a styling choice, an absence of data.
 *
 * The pack does ship ~300 stat **textures**, and it names them after the stat, which is the one
 * piece of the mapping that survives extraction. `stat-icons.generated.ts` is that filename
 * match written down; this file is everything the filename match cannot supply — the aliases for
 * stats whose icon is named after a relative, the colours from `COLOR-CODING.md`, and the rule
 * that gives every remaining stat its element's colour.
 *
 * ## The order the rules run in
 *
 * 1. an explicit entry in {@link STAT_COLOUR} — the twenty-odd stats the guide names outright;
 * 2. the element in the stat's id — `spell_fire_damage` is fire, `phys_to_chaos` is chaos;
 * 3. the pack's own `format`, where it declared one that is not the aqua default;
 * 4. `--text`, which is the honest answer for a stat nothing has an opinion about.
 *
 * Icons run the same way: the generated table, then {@link ICON_ALIAS}, then the pack's glyph.
 * The glyph is deliberately the last step rather than being dropped — it is what the sidebar
 * showed before there were textures, and it still carries more than a blank square does.
 */

import { statDisplay } from "@cte2/schema";
import type { Snapshot } from "@cte2/extractor";

import { ELEMENT, INK, readable } from "./palette.js";
import { STAT_ICONS } from "./stat-icons.generated.js";

/**
 * The stats `COLOR-CODING.md` names, and the handful its rules imply.
 *
 * Attributes and pools first, because those are the ones a player colour-codes by without
 * thinking: strength is red, intelligence is blue, dexterity is green, and a health bar is not
 * the same red as strength. The guide asks for those two reds to be told apart, which is why
 * health is the lighter one — a pool is a thing you watch drain, an attribute is a number you
 * allocate, and the lighter red belongs to the one that moves.
 */
const STAT_COLOUR: Record<string, string> = {
  // -- attributes ---------------------------------------------------------
  strength: INK.red,
  dexterity: INK.green,
  intelligence: INK.aqua,
  vitality: INK.red,
  wisdom: INK.aqua,
  agility: INK.green,
  all_attributes: INK.white,
  // The three "damage per attribute" stats take their attribute's colour rather than damage's,
  // because what a reader is scanning for is which attribute the build scales on.
  str_dmg: INK.red,
  dex_dmg: INK.green,
  int_dmg: INK.aqua,

  // -- pools --------------------------------------------------------------
  health: "#ff9b9b",
  health_regen: "#ff9b9b",
  magic_shield: "#c56cff",
  magic_shield_regen: "#c56cff",
  mana: INK.blue,
  mana_regen: INK.blue,
  mana_cost: INK.blue,
  energy: INK.green,
  energy_regen: INK.green,
  blood: INK.dark_red,
  blood_regen: INK.dark_red,
  blood_user: INK.dark_red,
  spirit_cost: INK.aqua,

  // -- criticals ----------------------------------------------------------
  // "Plain crit chance is gold and plain crit damage is dark red, then it changes with
  // elements" — the element rule below is what does the second half, and it runs after this,
  // so only the two plain stats are named here.
  critical_hit: INK.gold,
  critical_damage: INK.dark_red,
  non_crit_damage: INK.dark_red,

  // -- defences -----------------------------------------------------------
  armor: INK.gold,
  dodge: INK.green,
  spell_dodge: INK.green,
  block_chance: INK.aqua,
  max_block_chance: INK.aqua,
  dmg_reduction: INK.gold,
  dmg_reduction_chance: INK.gold,

  // -- utility ------------------------------------------------------------
  move_speed: INK.white,
  accuracy: INK.white,
  attack_speed: INK.white,
  cast_speed: INK.white,
  skill_speed: INK.white,
  cdr: INK.white,
};

/**
 * Stats whose icon belongs to a relative.
 *
 * Every one of these is a stat the pack ships no texture for and a player would nonetheless
 * expect to be marked — the defences on the sidebar, the damage families on the Stats tab.
 * Pointing at the nearest icon that *is* shipped beats a blank square, and beats inventing one:
 * spell dodge is dodge, a max resist is that resist, and a melee spell is a spell.
 */
const ICON_ALIAS: Record<string, string> = {
  spell_dodge: "dodge",
  max_block_chance: "block_chance",
  dmg_reduction: "armor",
  dmg_reduction_chance: "armor",
  physical_hits_dmg_reduction: "armor",
  chaos_dmg_reduction: "armor",
  dmg_received: "armor",
  dmg_taken_to_mana: "mana",
  damage_absorbed_by_mana: "mana",
  blood: "health",
  blood_regen: "health_regen",
  blood_user: "health",
  hp_resto_to_blood: "health_regen",
  vitality: "health",
  attack_damage: "weapon_damage",
  basic_attack_dmg: "weapon_damage",
  melee_spell_dmg: "spell_damage",
  ranged_spell_dmg: "spell_damage",
  skill_speed: "attack_speed",
  attack_cast_speed: "attack_speed",
  draw_speed_per_attack_speed: "draw_speed",
  weapon_skill_cdr_per_attack_speed: "cdr",
  projectile_count: "projectile_damage",
  health_leech_cap: "lifesteal",
  mana_leech_cap: "manasteal",
  magic_shield_leech_cap: "magic_steal",
  energy_leech_cap: "inc_leech",
  health_per_perc_of_armor: "health",
  magic_shield_per_perc_of_armor: "magic_shield",
  magic_shield_regen_per_perc_of_armor: "magic_shield_regen",
  armor_per_perc_of_dodge: "armor",
  dodge_per_perc_of_armor: "dodge",
  max_totems: "max_totems",
  max_banners: "max_totems",
  threat_generated: "aura_effect",
  max_endurance_charge_charges: "armor",
  max_frenzy_charge_charges: "attack_speed",
  endurance_charge_when_hit: "armor",
  elemental_overload_on_crit: "elemental",
  shred_on_attack_hit: "armor_penetration",
  knockback_resist: "kbr",
  ele_to_chaos: "phys_to_chaos",
  elemental_resist: "elemental_resist",
  max_physical_resist: "max_physical_resist",
};

/**
 * The elements, longest id first.
 *
 * Longest first because `all_physical_damage` contains `physical` and `phys_to_fire` contains
 * both `phys` and `fire`: the match has to be the *most specific* substring, and for a
 * conversion stat the element that matters is the one it converts **to**, which is also the one
 * that appears last. So the scan is right-to-left and takes the last match rather than the
 * first — `phys_to_fire` is a fire stat, which is how the game colours it.
 */
const ELEMENT_WORDS: readonly (readonly [string, string])[] = [
  ["physical", "physical"],
  ["phys", "physical"],
  ["fire", "fire"],
  ["water", "water"],
  ["cold", "water"],
  ["lightning", "lightning"],
  ["nature", "lightning"],
  ["chaos", "chaos"],
  ["shadow", "chaos"],
  ["elemental", "elemental"],
  ["ele", "elemental"],
];

/** The element a stat id names, or undefined. Word-boundary matched, so `melee` is not `ele`. */
export function elementOf(statId: string): string | undefined {
  const parts = statId.split("_");
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const found = ELEMENT_WORDS.find(([word]) => word === parts[at]);
    if (found !== undefined) return found[1];
  }
  return undefined;
}

/** `statDisplay`'s aqua default, which is indistinguishable from a stat that declared aqua. */
const PACK_DEFAULT = "#55FFFF";

export type StatLook = {
  /** The texture path for `world.icon()`, or undefined when the pack ships none. */
  iconPath: string | undefined;
  /** The pack's unicode glyph. Shown when there is no texture, never instead of one. */
  glyph: string;
  /** Readable on `--bg-panel`. */
  colour: string;
};

/**
 * Cached per snapshot, because this is called once per row per render and a geared character
 * puts two hundred rows on the sheet. The map is keyed on the snapshot so opening a different
 * one cannot serve stale glyphs.
 */
const cache = new WeakMap<Snapshot, Map<string, StatLook>>();

export function statLook(snapshot: Snapshot, statId: string): StatLook {
  let forSnapshot = cache.get(snapshot);
  if (forSnapshot === undefined) {
    forSnapshot = new Map();
    cache.set(snapshot, forSnapshot);
  }
  const held = forSnapshot.get(statId);
  if (held !== undefined) return held;

  const display = statDisplay(snapshot, statId);
  const element = elementOf(statId);
  const declared = display.colour === PACK_DEFAULT ? undefined : readable(display.colour);

  const look: StatLook = {
    iconPath: STAT_ICONS[statId] ?? STAT_ICONS[ICON_ALIAS[statId] ?? ""],
    glyph: display.icon,
    colour:
      STAT_COLOUR[statId] ??
      (element === undefined ? undefined : ELEMENT[element]) ??
      declared ??
      "var(--text)",
  };
  forSnapshot.set(statId, look);
  return look;
}
