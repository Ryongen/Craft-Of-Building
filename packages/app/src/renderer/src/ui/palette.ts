/**
 * The pack's colour vocabulary, rendered for a dark UI.
 *
 * Craft to Exile 2 speaks in Minecraft's sixteen chat colours: a rarity, an element, a gem type
 * and a stat's `format` field are all one of those names, and a player has already learned what
 * each one means from the game's own tooltips. Using the same colours here is what makes a
 * mythic read as a mythic and a chaos number read as chaos without a legend. `COLOR-CODING.md`
 * at the repo root is the authored source for the mapping; this file is that document compiled.
 *
 * ## Why there are two tables and not one
 *
 * Minecraft renders its palette over item tooltips on a near-black background at 100% opacity,
 * and five of the sixteen are unreadable in this app's chrome: `DARK_BLUE` (#0000AA) against
 * `--bg-panel` (#181b23) is a contrast ratio of 1.4:1, which is not dim, it is invisible.
 * `BLACK` is worse.
 *
 * So {@link MC} is the literal palette — correct wherever a colour is being *named* rather than
 * read, such as a swatch — and {@link INK} is the same palette with the five dark entries lifted
 * to at least 4.5:1 against `--bg-panel` and everything else left exactly as the game has it.
 * Text takes `INK`. Eleven of the sixteen are identical in both, which is the point: the lift is
 * the exception and it is visible here rather than being a hex somebody eyeballed at a call site.
 */

import { SINGLE_ELEMENTS } from "@cte2/schema";

/** Minecraft's sixteen, exactly as `ChatFormatting` has them. */
export const MC = {
  black: "#000000",
  dark_blue: "#0000AA",
  dark_green: "#00AA00",
  dark_aqua: "#00AAAA",
  dark_red: "#AA0000",
  dark_purple: "#AA00AA",
  gold: "#FFAA00",
  gray: "#AAAAAA",
  dark_gray: "#555555",
  blue: "#5555FF",
  green: "#55FF55",
  aqua: "#55FFFF",
  red: "#FF5555",
  light_purple: "#FF55FF",
  yellow: "#FFFF55",
  white: "#FFFFFF",
} as const;

export type McColour = keyof typeof MC;

/**
 * The same palette as text on `--bg-panel`.
 *
 * The lifted five keep their hue and their relationship to the rest — a dark red still reads as
 * the darker, angrier red beside `red`, and dark purple still reads as the deeper purple beside
 * `light_purple`. What changes is only that you can see them.
 */
export const INK: Record<McColour, string> = {
  ...MC,
  black: "#6b7280",
  dark_blue: "#7c86ff",
  dark_green: "#3faa55",
  dark_red: "#d05555",
  dark_purple: "#c264c2",
  dark_gray: "#7d8799",
};

/** Resolves a `format` colour name, tolerating the `grey`/`gray` spellings the pack mixes. */
export function ink(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const key = name.toLowerCase().replace("grey", "gray") as McColour;
  return INK[key];
}

/**
 * Turns a hex the pack declared into one that can be read here.
 *
 * `statDisplay().colour` comes off `mmorpg_stat.format` and is a raw `MC` value, so it arrives
 * carrying the same five unreadable entries. Mapping by value rather than by name is what lets
 * a colour that has already been resolved to hex — which is every colour crossing a schema
 * boundary — still get the lift.
 */
const LIFT = new Map(
  (Object.keys(MC) as McColour[]).map((name) => [MC[name].toLowerCase(), INK[name]]),
);

export function readable(hex: string): string {
  return LIFT.get(hex.toLowerCase()) ?? hex;
}

/**
 * Item rarity. The ladder every gear, jewel and omen badge is coloured by.
 *
 * `GearRarityView` carries the tier and the roll bands but no colour — the mod's rarities hold
 * a `ChatFormatting` in Java and the extractor sees none of it — so the names are authored in
 * `COLOR-CODING.md` and land here.
 */
export const RARITY: Record<string, string> = {
  common: INK.gray,
  uncommon: INK.green,
  rare: INK.aqua,
  epic: INK.light_purple,
  legendary: INK.gold,
  mythic: INK.dark_purple,
  unique: INK.red,
  runeword: INK.yellow,
  runed: INK.yellow,
  boss: INK.red,
  uber: INK.red,
  pinnacle: INK.dark_red,
  summon: INK.yellow,
};

/**
 * The five elements, by the guid the engine uses.
 *
 * `Nature` is the internal name for Lightning and `water` is Cold — see `elements.ts` in the
 * schema on why both spellings survive. Keyed by guid so a stat id can be matched against it
 * directly.
 */
export const ELEMENT: Record<string, string> = {
  physical: INK.gold,
  fire: INK.red,
  water: INK.aqua,
  cold: INK.aqua,
  lightning: INK.yellow,
  nature: INK.yellow,
  chaos: INK.dark_purple,
  shadow: INK.dark_purple,
  elemental: INK.light_purple,
};

/**
 * One element's colour, by either of its names.
 *
 * The engine calls them `Cold`, `Nature` and `Shadow` and the player sees Cold, Lightning and
 * Chaos; stat ids use a third set of spellings (`water`, `lightning`, `chaos`). {@link ELEMENT}
 * holds every spelling, so a caller never has to know which one it is holding.
 */
export function elementColour(name: string): string {
  return ELEMENT[name.toLowerCase()] ?? "var(--text)";
}

/**
 * One element's name as a player knows it.
 *
 * `Elements` in the mod is an enum whose constants are not what the game prints: `Nature` is
 * Lightning and `Shadow` is Chaos, and `ElementName` is the enum constant because that is what
 * every `EventData.ELEMENT` string in a snapshot holds. Printing it raw puts two words on screen
 * that appear nowhere in the game, and it had leaked onto the Defence tab in four places.
 *
 * Here beside {@link elementColour} because the two are always wanted together and neither is
 * something a panel should be re-deriving — a fifth copy of the lookup is a fifth place for
 * "Nature" to escape from.
 */
export function elementLabel(name: string): string {
  return SINGLE_ELEMENTS.find((element) => element.name === name)?.displayName ?? name;
}

/** Affix tier: the lower the number the better the band it rolled out of. */
export const TIER: Record<number, string> = {
  0: INK.green,
  1: INK.blue,
  2: INK.light_purple,
  3: INK.dark_purple,
};

export function tierColour(tier: number | undefined): string {
  if (tier === undefined) return INK.gray;
  return TIER[Math.min(tier, 3)] ?? INK.gray;
}

/** Gem type, and the element each one is bound to. */
export const GEM: Record<string, string> = {
  amethyst: INK.dark_purple,
  ruby: INK.red,
  emerald: INK.green,
  sapphire: INK.blue,
};
