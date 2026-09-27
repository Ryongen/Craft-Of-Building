import type { Snapshot } from "@cte2/extractor";
import { balance, parseSourceMod, sourceToExact, statIndex, type ModType } from "@cte2/engine";
import { modifierLine, statDisplay } from "@cte2/schema";

import { perkData } from "./TreeCanvas.js";

/**
 * A perk's stat lines, at the character's level.
 *
 * Perk stats are the `{ type, stat, v1, scale_to_lvl }` shape, and 40 of this pack's 1,497 set
 * `scale_to_lvl` — the flats the game grows with the holder, which is `energy_on_hit`,
 * `health_regen`, `accuracy`, `blood_on_kill` and the rest of what a player reads as "scales
 * with level". `modifierLine` is documented as the *un-levelled* preview, so the tooltip
 * printed `energy_regen_percent_big` as "+2 Energy Regen" against the much larger number the
 * same node had just put on the sheet.
 *
 * `sourceToExact` is the call `collectPerks` makes, so the line and the delta underneath it
 * come from one number rather than two.
 */
export function perkLines(snapshot: Snapshot, perkId: string, level: number): string[] {
  const index = statIndex(snapshot);
  const curves = balance(snapshot);

  return rawMods(snapshot, perkId).map((mod) => {
    const source = parseSourceMod(mod);
    if (source === undefined) return modifierLine(snapshot, mod);
    const exact = sourceToExact(source, level, index.shapeOf(source.statId), curves);
    // `modifierLine` words the stat; feeding the resolved value back as a fixed `v1` keeps
    // the wording — templates, "More"/"Increased", the percent suffix — and swaps the number.
    return modifierLine(snapshot, { stat: exact.statId, type: exact.type, v1: exact.value });
  });
}

/**
 * Everything a set of perks grants, merged into one line per stat and modifier type.
 *
 * Flat and increased values add, as they do on the sheet; "more" multiplies, as every MORE path
 * in the game does. A mod the parser cannot read is kept as its own line, counted when repeated,
 * rather than dropped — a route list that silently lost a stat would read as the route not
 * granting it.
 *
 * `good` is the stat's own verdict (`minus_is_good`), so a gamechanger's drawback reads as one:
 * "40% Less Elemental Damage" is a cost, and "-10% Mana Cost" is not. `undefined` for a line
 * the parser could not read, which has no direction to judge.
 */
export function mergedPerkLines(
  snapshot: Snapshot,
  perkIds: readonly string[],
  level: number,
): { text: string; good: boolean | undefined }[] {
  const index = statIndex(snapshot);
  const curves = balance(snapshot);
  const merged = new Map<string, { statId: string; type: ModType; value: number }>();
  const unread = new Map<string, number>();

  for (const perkId of perkIds) {
    for (const mod of rawMods(snapshot, perkId)) {
      const source = parseSourceMod(mod);
      if (source === undefined) {
        const line = modifierLine(snapshot, mod);
        unread.set(line, (unread.get(line) ?? 0) + 1);
        continue;
      }
      const exact = sourceToExact(source, level, index.shapeOf(source.statId), curves);
      const key = `${exact.statId}|${exact.type}`;
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, { statId: exact.statId, type: exact.type, value: exact.value });
      } else if (exact.type === "MORE") {
        held.value = ((1 + held.value / 100) * (1 + exact.value / 100) - 1) * 100;
      } else {
        held.value += exact.value;
      }
    }
  }

  const lines: { text: string; good: boolean | undefined }[] = [...merged.values()]
    .filter((m) => Math.abs(m.value) > 1e-9)
    .map((m) => ({
      text: modifierLine(snapshot, { stat: m.statId, type: m.type, v1: m.value }),
      good: statDisplay(snapshot, m.statId).minusIsGood ? m.value < 0 : m.value > 0,
    }));
  for (const [line, count] of unread) {
    lines.push({ text: count > 1 ? `${line} (×${count})` : line, good: undefined });
  }
  // Drawbacks first: on a route through gamechangers they are the part worth reading twice.
  const rank = (good: boolean | undefined): number => (good === false ? 0 : good === true ? 1 : 2);
  return lines.sort((a, b) => rank(a.good) - rank(b.good) || a.text.localeCompare(b.text));
}

function rawMods(snapshot: Snapshot, perkId: string): Record<string, unknown>[] {
  const raw = perkData(snapshot, perkId)?.["stats"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
  );
}
