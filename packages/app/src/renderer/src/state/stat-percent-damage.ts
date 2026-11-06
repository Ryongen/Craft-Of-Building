/**
 * Stats that add a percent of another stat as flat damage on hit: `archmage` (6% of mana, on
 * Mind of the Council) and `imbuement` (energy).
 *
 * They land in the same `flat_damage` layer as `flat_<element>_added_damage` and go through the
 * same `SPELL_DAMAGE_EFFECTIVENESS_MULTI`, so to a player they are added damage of that element.
 * But they never touch a sheet stat: the game adds them inside the damage event. Every place that
 * talks about added damage has to count them by hand, or the sheet says 48 while the hit gets 481.
 *
 * Read from the pack rather than listed: an `on_damage` effect that ADDs to `flat_damage` from a
 * `STAT_PERCENT` provider. The `_cost` twins use the same layer on `on_spend_resource`, where the
 * number is the cost, and are left out by the event.
 */

import type { Snapshot } from "@cte2/extractor";
import type { EngineStat } from "@cte2/engine";
import { CATEGORY, entry, fillTemplate, statDisplay, statNameRaw, stripFormatting } from "@cte2/schema";

export type StatPercentDamage = {
  statId: string;
  /** The stat whose value the percent is taken of — `mana` for `archmage`. */
  fromStatId: string;
  /** The sheet stat this is added damage alongside — `flat_physical_added_damage`. */
  flatStatId: string;
  /** `spell_has_tag_weapon_skill` gates it: attacks only. */
  attacksOnly: boolean;
  label: (snapshot: Snapshot) => string;
};

const CACHE = new WeakMap<Snapshot, StatPercentDamage[]>();

export function statPercentDamage(snapshot: Snapshot): StatPercentDamage[] {
  const cached = CACHE.get(snapshot);
  if (cached !== undefined) return cached;
  const out: StatPercentDamage[] = [];
  const stats = snapshot.registries[CATEGORY.stat] ?? {};
  for (const [statId, stat] of Object.entries(stats)) {
    const data = stat.data as { effect?: unknown; ele?: unknown };
    if (!Array.isArray(data.effect)) continue;
    const element = typeof data.ele === "string" ? data.ele.toLowerCase() : "physical";
    for (const block of data.effect as { effects?: unknown; events?: unknown; ifs?: unknown }[]) {
      if (!Array.isArray(block.events) || !block.events.includes("on_damage")) continue;
      for (const effectId of Array.isArray(block.effects) ? (block.effects as string[]) : []) {
        const effect = entry(snapshot, CATEGORY.statEffect, effectId)?.data as
          | { layer?: string; modification?: string; number_provider?: { type?: string; calc?: string } }
          | undefined;
        const from = effect?.number_provider?.calc;
        if (effect?.layer !== "flat_damage" || effect.modification !== "ADD") continue;
        if (effect.number_provider?.type !== "STAT_PERCENT" || from === undefined) continue;
        out.push({
          statId,
          fromStatId: from,
          flatStatId: `flat_${element}_added_damage`,
          attacksOnly: Array.isArray(block.ifs) && block.ifs.includes("spell_has_tag_weapon_skill"),
          label: (s) => `Added Damage from ${statDisplay(s, from).name}`,
        });
      }
    }
  }
  CACHE.set(snapshot, out);
  return out;
}

/**
 * A stat's name with `[VAL1]` filled in. Both stats this module is about are templated sentences
 * ("Gain [VAL1]% of your Mana as Added Physical Damage"), and a source row printing the template
 * names nothing.
 */
export function filledStatName(snapshot: Snapshot, statId: string, value: number): string {
  const display = statDisplay(snapshot, statId);
  if (!display.templated) return display.name;
  const raw = statNameRaw(snapshot, statId);
  return raw === undefined ? display.name : stripFormatting(fillTemplate(raw, [Math.round(value * 100) / 100]));
}

/** What one of these stats adds per hit on a sheet, before damage effectiveness. */
export function statPercentAmount(
  added: StatPercentDamage,
  stats: ReadonlyMap<string, Pick<EngineStat, "value">>,
): number {
  return ((stats.get(added.statId)?.value ?? 0) / 100) * (stats.get(added.fromStatId)?.value ?? 0);
}

/** Every stat-percent adder feeding one flat added damage stat, with what it adds on this sheet. */
export function onHitAddersOf(
  snapshot: Snapshot,
  flatStatId: string,
  stats: ReadonlyMap<string, Pick<EngineStat, "value">>,
): { added: StatPercentDamage; amount: number }[] {
  return statPercentDamage(snapshot)
    .filter((a) => a.flatStatId === flatStatId)
    .map((added) => ({ added, amount: statPercentAmount(added, stats) }))
    .filter((a) => a.amount !== 0);
}
