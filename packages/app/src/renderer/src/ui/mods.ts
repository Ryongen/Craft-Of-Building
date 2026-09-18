/**
 * A registry entry's modifiers, as text a picker row can carry.
 *
 * Two questions a searchable list has to answer before you click anything, and the id answers
 * neither: *what does this give me*, and *is this the one that does the thing I am looking for*.
 *
 * The second is the one that was missing entirely. A player hunting for the Augment that helps
 * their bleed build searches "bleed" and finds nothing, because the Augment is called Decree of
 * Pain and its id is `physical_ailment` — the word they searched for is in neither. It is in the
 * *stats*: `bleed_chance`, "Bleed Chance". So the search corpus is the mods, and the hover is
 * the same mods written out the way the game writes them.
 */

import type { Snapshot } from "@cte2/extractor";
import { modifierLine, statName } from "@cte2/schema";

import type { PickerOption } from "./Picker.js";
import { resolveValue } from "./StatLines.js";

/** The modifier objects on a registry entry's `stats` array, whatever shape they arrived in. */
export function modsOf(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object");
}

/**
 * One line per modifier, at a stated roll.
 *
 * The roll defaults to the **top** of the band rather than the bottom. This is preview text for
 * something not yet chosen, so the useful reading is what it is worth when it is good — the
 * floor is what every unrolled affix in the editor already shows, and a list of zeroes tells
 * nobody which of two affixes is the bigger one.
 */
export function modLines(snapshot: Snapshot, raw: unknown, rollPercent = 100): string[] {
  return modsOf(raw).map((mod) => modifierLine(snapshot, mod, rollPercent));
}

/**
 * Everything about these modifiers a search should match on.
 *
 * Both the id and the display name of every stat, because either can be the word someone
 * reaches for: `bleed_chance` catches "bleed", "Bleed Chance" catches "chance". Joined into one
 * string because that is what {@link PickerOption}'s `keywords` is matched against.
 */
export function modKeywords(snapshot: Snapshot, raw: unknown): string {
  const words = new Set<string>();
  for (const mod of modsOf(raw)) {
    const statId = typeof mod["stat"] === "string" ? mod["stat"] : undefined;
    if (statId === undefined) continue;
    // Underscores are not word breaks to `includes`, so the id goes in whole *and* split:
    // searching "ailment" should reach `physical_ailment_damage`, and it does either way, but
    // splitting also makes a two-word query like "bleed chance" match.
    words.add(statId);
    for (const part of statId.split("_")) words.add(part);
    words.add(statName(snapshot, statId));
  }
  return [...words].join(" ");
}

/** {@link modLines} as one hover-ready block, or `undefined` when there is nothing to say. */
export function modDetail(snapshot: Snapshot, raw: unknown, rollPercent = 100): string | undefined {
  const lines = modLines(snapshot, raw, rollPercent);
  return lines.length === 0 ? undefined : lines.join("\n");
}

/**
 * The same lines, with every value **resolved through the engine** at a stated roll and level.
 *
 * {@link modLines} is preview text for something not yet chosen: it words the modifier and
 * interpolates the band, but it does not level-scale, because a registry entry nobody owns has no
 * level to scale to. That is wrong for anything the character actually holds. `SupportGem
 * .GetAllStats` and `AuraGem.GetAllStats` scale their flats to the **player's** level, so a 2..6
 * band of `flat_water_added_damage` is 124.8 on a level 100 character and `modLines` prints 2.
 *
 * `resolveValue` is `rollToExact` — the call the collectors make — so a line from here cannot
 * disagree with the character sheet. The resolved number goes back through `modifierLine` as a
 * fixed `v1`, which keeps the wording (templates, "More"/"Increased", the percent suffix) and
 * swaps in the number.
 */
export function exactModLines(
  snapshot: Snapshot,
  raw: unknown,
  rollPercent: number,
  level: number,
): string[] {
  return modsOf(raw).map((mod) => {
    const value = resolveValue(snapshot, mod, rollPercent, level);
    const statId = typeof mod["stat"] === "string" ? mod["stat"] : undefined;
    if (value === undefined || statId === undefined) return modifierLine(snapshot, mod, rollPercent);
    return modifierLine(snapshot, { stat: statId, type: mod["type"], v1: value });
  });
}

/**
 * {@link exactModLines} as one short line, for a collapsed row.
 *
 * Joined with a middot rather than newlines: this goes in a row that is already only one line
 * tall, and the point of it is to tell two collapsed jewels apart without opening either.
 */
export function exactModSummary(
  snapshot: Snapshot,
  raw: unknown,
  rollPercent: number,
  level: number,
): string {
  return exactModLines(snapshot, raw, rollPercent, level).join(" · ");
}
