/**
 * Turning registry ids into text a person can read.
 *
 * Nothing else in this project touches `snapshot.lang`, and almost nothing in the registries
 * carries a display name — `mmorpg_spells.loc_name` is the only exception. Every other name
 * lives in one of the 5,564 lang keys, under a per-category prefix that has to be known
 * rather than derived. That mapping is what this file is.
 *
 * It sits in `@cte2/schema` rather than in the app for the same reason `queries.ts` does:
 * reading a snapshot on the UI's behalf is this package's job, and keeping it here means it
 * is covered by `node --test` instead of by a browser.
 *
 * ## Two things the data does that a naive reader gets wrong
 *
 * **Names are Minecraft-formatted strings, not plain text.** They carry `§`-prefixed colour
 * and style codes, and rendering them raw puts literal `§a` on screen. {@link stripFormatting}
 * and {@link parseFormatting} are the two ways out.
 *
 * **Some stat names are templates, not labels.** The 117 `one_to_other` and 33 `more_x_per_y`
 * stats have names like `"§a[VAL1] §b★ Accuracy§7 per 10 §b★ Dexterity§7"` — the whole line is
 * the modifier, with the number spliced in. A caller that renders "+4 [VAL1] Accuracy per 10
 * Dexterity" has misread the shape. {@link modifierLine} handles both forms.
 *
 * ## The fallback rule
 *
 * A missing key returns the humanised id (`crit_damage` -> "Crit Damage"), never a blank and
 * never the raw id. This is deliberate coverage-dependent territory rather than a data bug:
 * only 364 of 1,064 perks and 225 of 489 affixes are named at all, because the game renders
 * the unnamed ones from their stat lines instead. Callers that want to know whether a name was
 * real can ask {@link hasText} with the key from {@link LANG_KEY}.
 */

import type { Snapshot } from "@cte2/extractor";

import { CATEGORY, entry } from "./queries.js";

// ---------------------------------------------------------------------------
// Lang access
// ---------------------------------------------------------------------------

/** The lang key prefix each registry category's display name lives under. */
export const LANG_KEY = {
  stat: (id: string) => `mmorpg.stat.${id}`,
  statDesc: (id: string) => `mmorpg.stat_desc.${id}`,
  perk: (id: string) => `mmorpg.talent.${id}`,
  spell: (id: string) => `mmorpg.spell.${id}`,
  spellDesc: (id: string) => `spell.desc.${id}`,
  affix: (id: string) => `mmorpg.affix.${id}`,
  /** Note the `.name` suffix — uniques are the only category that has one. */
  unique: (id: string) => `mmorpg.unique_gear.${id}.name`,
  supportGem: (id: string) => `mmorpg.support_gem.${id}`,
  gearType: (id: string) => `mmorpg.gear_type.${id}`,
  gearSlot: (id: string) => `mmorpg.gearslot.${id}`,
  aura: (id: string) => `mmorpg.aura.${id}`,
  exileEffect: (id: string) => `mmorpg.effect.${id}`,
  runeword: (id: string) => `mmorpg.runeword.${id}`,
  /** `GemItem.GemType`, the colour half of a gem's name. */
  gemType: (id: string) => `mmorpg.gem_type.${id}`,
  /** `GemItem.GemRank`, the quality half — keyed by the rank's lowercased display name. */
  gemRank: (id: string) => `mmorpg.gem_rank.${id}`,
  /** A rune is a plain item, so its name is the item's. */
  rune: (id: string) => `item.mmorpg.runes.${id}`,
  statLayer: (id: string) => `mmorpg.stat_layer.${id}`,
  word: (id: string) => `mmorpg.word.${id}`,
} as const;

/**
 * Enlighten glossary markup: `[Display Text](term_id)` reduced to its display text.
 *
 * Craft to Exile 2 writes this straight into lang values — 1,673 of them, stat names included
 * (`mmorpg.stat.gear_defense` is `"[Gear's Defense](defences)"`). In game it is a hoverable
 * glossary term, and everything that draws text outside a tooltip runs it through
 * `EnlightenMarkup.strip` first (EnlightenMarkup.java:32-37); rendering it raw would put
 * literal brackets on screen.
 *
 * `[VAL1]`-style placeholders are deliberately safe: the pattern only matches a bracket group
 * immediately followed by `(...)`, and a placeholder never is.
 */
const GLOSSARY_MARKUP = /\[([^\]]+)\]\(([^)]+)\)/g;

export function stripGlossaryMarkup(value: string): string {
  // The `](` pre-check is the same cheap bail the mod does before touching the regex.
  return value.includes("](") ? value.replace(GLOSSARY_MARKUP, "$1") : value;
}

export function text(snapshot: Snapshot, key: string): string | undefined {
  const value = snapshot.lang[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  const stripped = stripGlossaryMarkup(value);
  return stripped.length > 0 ? stripped : undefined;
}

export function hasText(snapshot: Snapshot, key: string): boolean {
  return text(snapshot, key) !== undefined;
}

/**
 * `crit_damage` -> "Crit Damage".
 *
 * The last-resort fallback for every name below. Not a translation — a legible stand-in that
 * makes an unnamed entry identifiable rather than invisible.
 */
export function humanise(id: string): string {
  return id
    .split(/[_:./]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Minecraft text formatting
// ---------------------------------------------------------------------------

/** The sixteen `§0`-`§f` colours, by code character. */
export const MC_COLOURS: Record<string, string> = {
  "0": "#000000",
  "1": "#0000AA",
  "2": "#00AA00",
  "3": "#00AAAA",
  "4": "#AA0000",
  "5": "#AA00AA",
  "6": "#FFAA00",
  "7": "#AAAAAA",
  "8": "#555555",
  "9": "#5555FF",
  a: "#55FF55",
  b: "#55FFFF",
  c: "#FF5555",
  d: "#FF55FF",
  e: "#FFFF55",
  f: "#FFFFFF",
};

/**
 * The same sixteen colours by name, which is the form `mmorpg_stat.format` uses.
 *
 * 572 stats declare `aqua`, 26 `red`, 10 `green`, 9 `yellow`, 2 `blue`.
 */
export const MC_COLOUR_NAMES: Record<string, string> = {
  black: MC_COLOURS["0"]!,
  dark_blue: MC_COLOURS["1"]!,
  dark_green: MC_COLOURS["2"]!,
  dark_aqua: MC_COLOURS["3"]!,
  dark_red: MC_COLOURS["4"]!,
  dark_purple: MC_COLOURS["5"]!,
  gold: MC_COLOURS["6"]!,
  gray: MC_COLOURS["7"]!,
  grey: MC_COLOURS["7"]!,
  dark_gray: MC_COLOURS["8"]!,
  dark_grey: MC_COLOURS["8"]!,
  blue: MC_COLOURS["9"]!,
  green: MC_COLOURS.a!,
  aqua: MC_COLOURS.b!,
  red: MC_COLOURS.c!,
  light_purple: MC_COLOURS.d!,
  yellow: MC_COLOURS.e!,
  white: MC_COLOURS.f!,
};

/** A run of text sharing one style. `colour` is a hex string, ready for CSS. */
export type Span = {
  text: string;
  colour?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

/**
 * Splits a `§`-formatted string into styled runs.
 *
 * Follows Minecraft's own rules: a colour code resets every style, a style code adds to what
 * is active, and `§r` clears everything. `§k` (obfuscated) is parsed and dropped — it is a
 * rendering effect with no static equivalent.
 */
export function parseFormatting(raw: string): Span[] {
  const spans: Span[] = [];
  let style: Omit<Span, "text"> = {};
  let buffer = "";

  const flush = (): void => {
    if (buffer.length > 0) spans.push({ text: buffer, ...style });
    buffer = "";
  };

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char !== "§" || i + 1 >= raw.length) {
      buffer += char;
      continue;
    }
    const code = raw[i + 1]!.toLowerCase();
    i++;

    if (code in MC_COLOURS) {
      flush();
      // A colour code resets styling, it does not merge with it.
      style = { colour: MC_COLOURS[code]! };
    } else if (code === "r") {
      flush();
      style = {};
    } else if (code === "l" || code === "m" || code === "n" || code === "o") {
      flush();
      const key = ({ l: "bold", m: "strike", n: "underline", o: "italic" } as const)[code];
      style = { ...style, [key]: true };
    } else if (code === "k") {
      // Obfuscated: no static rendering. Drop the code, keep the text.
      flush();
    } else {
      // Not a formatting code at all — a literal section sign.
      buffer += char + raw[i]!;
    }
  }
  flush();
  return spans;
}

/** The same string with every `§` code removed. */
export function stripFormatting(raw: string): string {
  return parseFormatting(raw)
    .map((span) => span.text)
    .join("");
}

/**
 * Fills the `[VAL1]`, `[VAL2]`, ... placeholders a templated stat name carries.
 *
 * Placeholders are 1-based. One with no matching value is left in place rather than blanked,
 * so a template the caller under-supplied is visible instead of silently wrong.
 */
export function fillTemplate(raw: string, values: readonly (string | number)[]): string {
  return raw.replace(/\[VAL(\d+)\]/g, (match, digits: string) => {
    const value = values[Number(digits) - 1];
    return value === undefined ? match : formatNumber(value);
  });
}

/** Whether a string carries at least one `[VALn]` placeholder. */
export function isTemplate(raw: string): boolean {
  return /\[VAL\d+\]/.test(raw);
}

/** Trims trailing zeros: 12 -> "12", 12.5 -> "12.5", 12.505 -> "12.51". */
export function formatNumber(value: string | number): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function named(snapshot: Snapshot, key: string, id: string): string {
  const raw = text(snapshot, key);
  return raw === undefined ? humanise(id) : stripFormatting(raw);
}

export function statName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.stat(id), id);
}

/** The raw, still-formatted stat name — templates included. {@link modifierLine} needs this. */
export function statNameRaw(snapshot: Snapshot, id: string): string | undefined {
  return text(snapshot, LANG_KEY.stat(id));
}

export function statDesc(snapshot: Snapshot, id: string): string | undefined {
  const raw = text(snapshot, LANG_KEY.statDesc(id));
  return raw === undefined ? undefined : stripFormatting(raw);
}

/**
 * A perk's name.
 *
 * Only 364 of 1,064 perks have a lang key — the named ones are the `SPECIAL` and `MAJOR`
 * nodes. A plain `STAT` node is rendered in game from its stat lines, so the fallback here is
 * the name of the stat it grants rather than the humanised id, which would produce
 * "Accuracy Percent" where the game shows "Accuracy".
 */
export function perkName(snapshot: Snapshot, id: string): string {
  const raw = text(snapshot, LANG_KEY.perk(id));
  if (raw !== undefined) return stripFormatting(raw);

  const stats = perkStats(snapshot, id);
  const first = stats[0];
  if (first !== undefined) {
    const statId = typeof first["stat"] === "string" ? first["stat"] : undefined;
    if (statId !== undefined) {
      const name = statNameRaw(snapshot, statId);
      // A templated stat name is a whole sentence; the id reads better as a node label.
      if (name !== undefined && !isTemplate(name)) return stripFormatting(name);
    }
  }
  return humanise(id);
}

function perkStats(snapshot: Snapshot, id: string): Record<string, unknown>[] {
  const data = entry(snapshot, CATEGORY.perk, id)?.data;
  const stats = data?.["stats"];
  if (!Array.isArray(stats)) return [];
  return stats.filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
  );
}

/**
 * A spell's name. Lang first, then the registry's own `loc_name`.
 *
 * Spells are the one category carrying an in-registry name, which makes the precedence look
 * like a toss-up. It is not: 271 of the 372 spells have both, and where they disagree
 * `loc_name` is the stale one. `lightning_golem_basic` declares `loc_name: "Fire Golem
 * Attack"` — a copy-paste bug — against a lang value of "Lightning Golem Attack", and the
 * pack renames `boomerang` to "Axe Throw" and `lightning_nova` to "Charged Bomb" in lang while
 * leaving `loc_name` at the jar's wording. Lang is what `resources.zip` overrides, so it is
 * what the player sees. `loc_name` covers the 101 spells with no lang key.
 */
export function spellName(snapshot: Snapshot, id: string): string {
  const raw = text(snapshot, LANG_KEY.spell(id));
  if (raw !== undefined) return stripFormatting(raw);

  const loc = entry(snapshot, CATEGORY.spell, id)?.data?.["loc_name"];
  if (typeof loc === "string" && loc.length > 0) return loc;
  return humanise(id);
}

export function spellDesc(snapshot: Snapshot, id: string): string | undefined {
  const raw = text(snapshot, LANG_KEY.spellDesc(id));
  return raw === undefined ? undefined : stripFormatting(raw);
}

export function affixName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.affix(id), id);
}

export function uniqueName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.unique(id), id);
}

export function supportGemName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.supportGem(id), id);
}

export function gearTypeName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.gearType(id), id);
}

export function slotName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.gearSlot(id), id);
}

export function auraName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.aura(id), id);
}

export function exileEffectName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.exileEffect(id), id);
}

export function runewordName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.runeword(id), id);
}

export function statLayerName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.statLayer(id), id);
}

/** Rarities have no lang keys at all — humanised ids are all there is. */
export function rarityName(_snapshot: Snapshot, id: string): string {
  return humanise(id);
}

/**
 * `GemItem.GemRank`, by tier. The names are in the enum, not in the data: a `mmorpg_gems`
 * record carries `tier` and nothing that says "Chipped".
 */
const GEM_RANKS = [
  "cracked",
  "chipped",
  "flawed",
  "regular",
  "grand",
  "glorious",
  "divine",
  "pinnacle",
] as const;

/**
 * What a gem is called in game — "Chipped Amethyst", not `amethyst1`.
 *
 * There is no single lang key for it. A `GemItem` is registered per `(GemType, GemRank)` pair
 * and its name is assembled from the two halves at render time, so this assembles the same two:
 * `mmorpg.gem_rank.<rank>` and `mmorpg.gem_type.<type>`. `GemRank.ofTier` falls back to
 * CHIPPED for an unknown tier and so does this.
 */
export function gemName(snapshot: Snapshot, id: string): string {
  const d = entry(snapshot, CATEGORY.gem, id)?.data;
  const type = typeof d?.["gem_type"] === "string" ? (d["gem_type"] as string) : undefined;
  const tier = typeof d?.["tier"] === "number" ? (d["tier"] as number) : undefined;
  if (type === undefined) return humanise(id);
  const rank = GEM_RANKS[tier ?? 1] ?? "chipped";
  const rankName = text(snapshot, LANG_KEY.gemRank(rank)) ?? humanise(rank);
  const typeName = text(snapshot, LANG_KEY.gemType(type)) ?? humanise(type);
  return `${stripGlossaryMarkup(rankName)} ${stripGlossaryMarkup(typeName)}`;
}

/** "Ano Rune" — the rune's item name, which already carries the word. */
export function runeName(snapshot: Snapshot, id: string): string {
  return named(snapshot, LANG_KEY.rune(id), id);
}

/**
 * `StatBuff` is a bare `{ id, mods }` with no `IAutoLocName` on it — the name a player sees
 * belongs to the food item that granted the buff, not to the buff, and the document records
 * the buff. So the id, humanised.
 */
export function statBuffName(_snapshot: Snapshot, id: string): string {
  return humanise(id);
}

// ---------------------------------------------------------------------------
// Stat sheet presentation
// ---------------------------------------------------------------------------

/**
 * How the game's own stat GUI groups and colours a stat.
 *
 * Every field here is read off `mmorpg_stat` rather than invented, so the sheet's shape
 * follows the pack rather than our taxonomy. Two caveats found in the 2.0.2 data:
 *
 *  - `order` is **100 on all 619 stats that declare it**, so it sorts nothing. Fall back to
 *    the name.
 *  - the 181 derived-serializer stats (`one_to_other`, `more_x_per_y`, `core_stat`, ...) nest
 *    everything under `data` and declare none of these fields, so they all take the defaults.
 */
export type StatDisplay = {
  id: string;
  name: string;
  /** `MAIN`, `ELEMENTAL`, `WEAPON`, `RESTORATION`, `Misc`. */
  group: string;
  /** `NONE`, `ELE_DAMAGE`, `ELE_SPELL_DAMAGE`. */
  guiGroup: string;
  order: number;
  /** One of five unicode glyphs (`★ ⚔ ➹ ❁ 🌀`) — not a texture path, unlike perk icons. */
  icon: string;
  /** Hex colour resolved from the stat's `format` colour name. */
  colour: string;
  isPerc: boolean;
  showInGui: boolean;
  /** When true, a negative value is an improvement (cooldowns, costs). */
  minusIsGood: boolean;
  /** The stat's name is a whole templated sentence rather than a label. */
  templated: boolean;
};

const DEFAULT_GROUP = "Misc";

export function statDisplay(snapshot: Snapshot, id: string): StatDisplay {
  const data = entry(snapshot, CATEGORY.stat, id)?.data ?? {};
  const raw = statNameRaw(snapshot, id);
  const format = typeof data["format"] === "string" ? data["format"] : "aqua";
  return {
    id,
    name: raw === undefined ? humanise(id) : stripFormatting(raw),
    group: typeof data["group"] === "string" ? data["group"] : DEFAULT_GROUP,
    guiGroup: typeof data["gui_group"] === "string" ? data["gui_group"] : "NONE",
    order: typeof data["order"] === "number" ? data["order"] : 100,
    icon: typeof data["icon"] === "string" ? data["icon"] : "★",
    colour: MC_COLOUR_NAMES[format] ?? MC_COLOUR_NAMES.aqua!,
    isPerc: data["is_perc"] === true,
    showInGui: data["show_in_gui"] !== false,
    minusIsGood: data["minus_is_good"] === true,
    templated: raw !== undefined && isTemplate(raw),
  };
}

// ---------------------------------------------------------------------------
// The sheet taxonomy
// ---------------------------------------------------------------------------

/**
 * One section of the stat sheet.
 *
 * `stats` is an ordered list and it is the whole point: within a section the reader wants
 * health above health regen above the leech cap, which is neither alphabetical nor anything the
 * pack declares. `patterns` then catch the families — five resists, five regens, five leech
 * caps — so a pack update that adds a sixth element lands somewhere sensible without an edit
 * here.
 */
export type SheetGroup = {
  id: string;
  /** The section heading. */
  name: string;
  /** Explicit members, in display order. Always beats a pattern, in any group. */
  stats: readonly string[];
  /** Families this section claims. Tried in group order, after every explicit list. */
  patterns?: readonly RegExp[];
};

/**
 * Why this lives in the repo rather than coming off the pack.
 *
 * `mmorpg_stat.group` is five buckets, and 536 of the pack's 832 stats declare `Misc` while
 * another 191 declare nothing at all — so 727 of them arrive in one undifferentiated pile.
 * `order` is no help either: every stat that declares it declares 100, which makes the
 * tiebreak the stat's name and the sheet an alphabetical dump. A real character carries 223 of
 * these at once, and finding "block chance" between "bleed chance" and "blood" is not reading,
 * it is searching.
 *
 * So the order below is authored. It is a claim about what a player looks for and in what
 * order, which is a judgement the pack has no way to express and no reason to.
 */
export const SHEET_GROUPS: readonly SheetGroup[] = [
  {
    id: "offence",
    name: "Offence",
    stats: [
      "total_damage",
      "weapon_damage",
      "basic_attack_dmg",
      "attack_damage",
      "spell_damage",
      "melee_spell_dmg",
      "ranged_spell_dmg",
      "weapon_skill_spell_dmg",
      "projectile_damage",
      "area_dmg",
      "str_dmg",
      "dex_dmg",
      "int_dmg",
      "elemental_attack_damage",
      "flat_physical_added_damage",
      "critical_hit",
      "critical_damage",
      "non_crit_damage",
      "accuracy",
      "attack_speed",
      "cast_speed",
      "attack_cast_speed",
      "skill_speed",
      "draw_speed",
      "draw_speed_per_attack_speed",
      "cdr",
      "weapon_skill_cdr_per_attack_speed",
      "inc_aoe",
      "area_cast_time",
      "projectile_count",
      "projectile_nova",
      "faster_projectiles",
      "dmg_to_stunned",
      "double_event_chance",
      "combat_talent_melee_hit",
      "combat_talent_ranged_hit",
      "int_dmg_per_perc_strength",
      "projectile_damage_per_perc_strength",
      "phys_damage_per_perc_of_health_on_hit",
      "skill_damage_per_inc_leech",
      "spell_damage_per_perc_of_increase_healing",
    ],
    // `all_<element>_damage` and the weapon-type families, plus conversion and penetration,
    // which are offensive in the only sense that matters: they move the number on the hit.
    //
    // The conversion pattern covers all three shapes the family comes in — `phys_to_fire`,
    // `plus_phys_to_fire` and `ele_to_chaos`, the last of which is what New Sin grants — and
    // `<element>_ignore_ele_res` is penetration by another name: it spends the target's resist
    // rather than the attacker's number.
    patterns: [
      /^all_.+_damage$/,
      /^(plus_)?(phys|ele)_to_.+$/,
      /(^|_)ignore_ele_res$/,
      /_penetration$/,
      /_damage$/,
      /_dmg$/,
    ],
  },
  {
    id: "life",
    name: "Life",
    stats: ["health", "health_regen", "health_leech_cap", "health_on_hit_hit", "health_per_perc_of_armor"],
  },
  {
    id: "magic_shield",
    name: "Magic Shield",
    stats: [
      "magic_shield",
      "magic_shield_regen",
      "magic_shield_leech_cap",
      "magic_shield_on_hit_hit",
      "magic_shield_per_perc_of_armor",
      "magic_shield_regen_per_perc_of_armor",
      "spell_mssteal",
    ],
  },
  {
    id: "energy",
    name: "Energy",
    stats: ["energy", "energy_regen", "energy_leech_cap", "energy_on_hit_hit"],
  },
  {
    id: "mana",
    name: "Mana",
    stats: ["mana", "mana_regen", "mana_cost", "mana_leech_cap", "mana_on_hit_hit"],
  },
  {
    id: "blood",
    name: "Blood",
    stats: ["blood", "blood_regen", "blood_leech_cap", "blood_user", "blood_per_perc_of_health", "hp_resto_to_blood"],
  },
  {
    id: "leech",
    name: "Leech & Recovery",
    stats: [
      "inc_leech",
      "lifesteal",
      "increase_healing",
      "heal_effect_on_self",
      "resource_on_basic_hit",
      "spirit_cost",
      "pants_resource_cost_when_hit",
    ],
    patterns: [/_leech_cap$/, /_on_hit_hit$/],
  },
  {
    id: "resistances",
    name: "Resistances",
    // Each resist sits next to its own cap, because the pair is the reading: 75 against a cap
    // of 75 is a finished resist and 75 against 80 is five points of headroom.
    stats: [
      "fire_resist",
      "max_fire_resist",
      "water_resist",
      "max_water_resist",
      "lightning_resist",
      "max_lightning_resist",
      "cold_resist",
      "max_cold_resist",
      "elemental_resist",
      "chaos_resist",
      "max_chaos_resist",
      "physical_resist",
      "max_physical_resist",
      "chaos_resist_per_perc_water_resist",
    ],
    patterns: [/^max_.+_resist$/, /_resist$/],
  },
  {
    id: "defences",
    name: "Defences",
    stats: [
      "armor",
      "dodge",
      "spell_dodge",
      "block_chance",
      "dmg_reduction",
      "dmg_reduction_chance",
      "physical_hits_dmg_reduction",
      "chaos_dmg_reduction",
      "dmg_received",
      "knockback_resist",
      "armor_per_perc_of_dodge",
      "dodge_per_perc_of_armor",
      "dodge_per_perc_of_energy",
      "spell_dodge_per_perc_of_dodge",
      "dmg_reduction_from_snow_tracked",
      "defensive_eff_dur_u_cast",
      "immobilizing_eff_dur_u_cast",
      "event_focus_penalty",
    ],
  },
  {
    id: "attributes",
    name: "Attributes",
    stats: ["strength", "dexterity", "intelligence"],
  },
  {
    id: "ailments",
    name: "Ailments & Immunities",
    stats: [
      "bleed_chance",
      "freeze_proc_chance",
      "freeze_chance_per_perc_of_bleed_chance",
      "electrify_proc_chance",
      "shred_on_attack_hit",
      "elemental_overload_on_crit",
      "ele_equil_cold_on_fire_hit",
      "ele_equil_fire_on_lightning_hit",
      "ele_equil_lightning_on_cold_hit",
    ],
    patterns: [/_immunity$/],
  },
  {
    id: "charges",
    name: "Charges",
    stats: [
      "max_endurance_charge_charges",
      "max_frenzy_charge_charges",
      "charge_recovery_rate",
      "dmg_per_endurance_charge",
      "dmg_per_frenzy_charge",
      "dodge_er_power_charge",
      "endurance_charge_when_hit",
    ],
    patterns: [/^max_.+_charges$/, /_charge$/, /_charges$/],
  },
  {
    id: "triggers",
    name: "Triggers",
    // Everything whose value is a chance to make something else happen. A player reads these
    // as a list of "and then this fires", which is nothing like reading a damage number.
    stats: ["on_block", "on_dodge", "golem_spell_chance", "snow_tracked_on_dodge", "remove_sanguine_aura_when_very_low"],
    patterns: [/^proc_/, /_on_basic_hit$/, /_on_hit$/, /_on_crit$/, /_when_hit$/, /_on_ricochet_shot$/],
  },
  {
    id: "minions",
    name: "Minions & Summons",
    stats: ["summon_damage", "summon_health", "max_totems", "max_banners", "threat_generated"],
    patterns: [/^max_.+_summons$/],
  },
  {
    id: "buffs",
    name: "Buffs & Auras",
    stats: [
      "aura_effect",
      "inc_effect_of_positive_buff_given",
      "inc_effect_of_negative_buff_given",
      "inc_effect_of_defensive_buff_given",
    ],
    patterns: [/^inc_effect_of_/],
  },
  {
    id: "skills",
    name: "Skills",
    // `learn_<spell>` is a stat like any other — it is how a unique or a runeword grants a
    // spell you never allocated — but 34 of them in the middle of a sheet is a wall. Their own
    // section, after everything that is a number about the character.
    stats: ["jewel_socket"],
    patterns: [/^learn_/, /^plus_lvl_/],
  },
  {
    id: "utility",
    name: "Utility & Find",
    stats: [
      "move_speed",
      "move_speed_per_perc_of_cold_resist",
      "magic_find",
      "currency_find",
      "relic_find",
      "map_find",
      "uber_fragment_find",
      "increased_quantity",
      "stat_roll_quality",
      "bonus_exp",
      "pack_size",
      "map_rarity_bias",
      "mob_modifier_density",
      "additional_boss_chance",
      "boss_loot_quantity",
      "mythic_monster_chance",
      "duplicate_map_chance",
      "extra_drop_from_mythics",
      "harvest_extra_drops",
      "imprisoned_monster_double_spawn",
      "imprisoned_monster_extra_drops",
      "prophecy_coin_find",
      "prophecy_double_curse",
      "prophecy_event_chance",
    ],
    patterns: [/_find$/, /^prophecy_/],
  },
];

/**
 * The pack's own five buckets, as a last resort before Uncategorised.
 *
 * Only `MAIN`, `ELEMENTAL` and `WEAPON` say anything — they all mean "offensive" — and
 * `RESTORATION` means recovery. `Misc` is not mapped, because mapping it would put 536 stats in
 * a named group and defeat the audit that catches the ones this file has not placed yet.
 */
const PACK_GROUP_FALLBACK: Record<string, string> = {
  MAIN: "offence",
  ELEMENTAL: "offence",
  WEAPON: "offence",
  RESTORATION: "leech",
};

export const UNCATEGORISED = "uncategorised";

const EXPLICIT: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of SHEET_GROUPS) {
    for (const id of group.stats) {
      if (!map.has(id)) map.set(id, group.id);
    }
  }
  return map;
})();

/**
 * Which section a stat belongs in.
 *
 * Explicit membership wins over every pattern, in any group — without that rule
 * `summon_damage` would be caught by Offence's `_damage$` before Minions ever saw it, and the
 * order of the group list would silently decide the taxonomy.
 */
export function sheetGroupOf(snapshot: Snapshot, id: string): string {
  const explicit = EXPLICIT.get(id);
  if (explicit !== undefined) return explicit;

  for (const group of SHEET_GROUPS) {
    for (const pattern of group.patterns ?? []) {
      if (pattern.test(id)) return group.id;
    }
  }

  const packGroup = statDisplay(snapshot, id).group;
  return PACK_GROUP_FALLBACK[packGroup] ?? UNCATEGORISED;
}

/** Where a section sits in the sheet. Uncategorised sorts last, which is where it belongs. */
export function sheetGroupRank(groupId: string): number {
  const index = SHEET_GROUPS.findIndex((g) => g.id === groupId);
  return index === -1 ? SHEET_GROUPS.length : index;
}

/** The heading to print for a section id. */
export function sheetGroupName(groupId: string): string {
  return SHEET_GROUPS.find((g) => g.id === groupId)?.name ?? "Uncategorised";
}

/**
 * Where a stat sits inside its own section.
 *
 * An explicit member sorts by its position in the list; anything a pattern caught sorts after
 * every explicit member, by name. So the authored order holds where there is one, and a family
 * member the pack adds tomorrow appends rather than shuffling what is already there.
 */
function positionInGroup(groupId: string, id: string): number {
  const group = SHEET_GROUPS.find((g) => g.id === groupId);
  if (group === undefined) return Number.MAX_SAFE_INTEGER;
  const index = group.stats.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Sort comparator for the sheet: section, then the authored order within it, then name.
 *
 * Replaces the old group-then-name rule, which was name alone in practice: every stat that
 * declares `order` declares 100.
 */
export function compareForSheet(snapshot: Snapshot, a: StatDisplay, b: StatDisplay): number {
  const ga = sheetGroupOf(snapshot, a.id);
  const gb = sheetGroupOf(snapshot, b.id);
  if (ga !== gb) return sheetGroupRank(ga) - sheetGroupRank(gb);
  const pa = positionInGroup(ga, a.id);
  const pb = positionInGroup(gb, b.id);
  if (pa !== pb) return pa - pb;
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Modifier lines
// ---------------------------------------------------------------------------

/**
 * One human-readable line for a modifier off an affix, base, unique, perk or gem.
 *
 * Both modifier shapes are accepted: `{ type, stat, min, max }` (a range, resolved by
 * `rollPercent`) and `{ type, stat, v1 }` (a fixed value). The output mirrors how the game
 * renders each modifier type, and a templated stat name takes over the whole line:
 *
 *     { type: "FLAT",    stat: "armor",    min: 4, max: 8 }, 50  ->  "+6 Armor"
 *     { type: "PERCENT", stat: "armor",    v1: 12 }              ->  "+12% Increased Armor"
 *     { type: "MORE",    stat: "armor",    v1: 12 }              ->  "12% More Armor"
 *     { type: "MORE",    stat: "armor",    v1: -20 }             ->  "20% Less Armor"
 *     { type: "FLAT",    stat: "accuracy_per_10_dexterity", v1: 4 }
 *                                          ->  "4 ★ Accuracy per 10 ★ Dexterity"
 *
 * A negative MORE reads as "less" rather than "-20% More", which is both how the genre words
 * it and how the pack means it — `acrobat` trades 20% of your armour and dodge for suppression.
 *
 * `rollPercent` interpolates linearly between `min` and `max`, which is what
 * `StatModifier.GetValue` does. It is ignored for the fixed-value shape. Note this is a
 * *display* helper: the authoritative number comes from `rollToExact` in `@cte2/engine`,
 * which also applies level scaling. Use this for pickers and previews of un-levelled data.
 */
export function modifierLine(
  snapshot: Snapshot,
  mod: Record<string, unknown>,
  rollPercent = 0,
): string {
  const statId = typeof mod["stat"] === "string" ? mod["stat"] : undefined;
  if (statId === undefined) return "(modifier with no stat)";

  const type = String(mod["type"] ?? "FLAT").toUpperCase();
  const value = modifierValue(mod, rollPercent);

  const raw = statNameRaw(snapshot, statId);
  if (raw !== undefined && isTemplate(raw)) {
    return stripFormatting(fillTemplate(raw, [value]));
  }

  const name = raw === undefined ? humanise(statId) : stripFormatting(raw);
  const display = statDisplay(snapshot, statId);
  const suffix = display.isPerc && type === "FLAT" ? "%" : "";
  const shown = formatNumber(value);

  if (type === "PERCENT") return `${signed(value)}% Increased ${name}`;
  if (type === "MORE") {
    return value < 0 ? `${formatNumber(-value)}% Less ${name}` : `${shown}% More ${name}`;
  }
  return `${signed(value)}${suffix} ${name}`;
}

/** The number a modifier resolves to before level scaling: interpolated range, or `v1`. */
export function modifierValue(mod: Record<string, unknown>, rollPercent = 0): number {
  const min = mod["min"];
  const max = mod["max"];
  if (typeof min === "number" && typeof max === "number") {
    return min + ((max - min) * clampPercent(rollPercent)) / 100;
  }
  const v1 = mod["v1"];
  return typeof v1 === "number" ? v1 : 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

function signed(value: number): string {
  return value < 0 ? formatNumber(value) : `+${formatNumber(value)}`;
}
