/**
 * What one item is worth, resolved once and read from three places.
 *
 * The gear panel already answered "what does this piece contribute" for its editor preview, by
 * running the engine's own `collectGear` over a one-item list and summing the contexts. Two more
 * callers now want the same answer — the hover tooltip over a gear row, and the diff that prices
 * a swap against what is already worn — and three copies of that summation would be three
 * opinions about what an item grants.
 *
 * `collectGear` rather than a walk over the document's own fields, for the reason the preview
 * gave originally: it applies the item-level scaling and the roll interpolation exactly as the
 * character sheet does, so nothing shown here can disagree with the sidebar. The rules that fall
 * out for free are the ones people trip over — an item above the character's level contributes
 * nothing at all, and quality lands on the base roll and nowhere else.
 *
 * ## Why the three modifier types stay apart
 *
 * `FLAT`, `PERCENT` and `MORE` are not addable. +40 Armor and +40% Armor are different claims
 * about the same stat, and a sum of the two is a number that appears nowhere. So a total is a
 * triple per stat, a *line* is drawn per non-zero member of that triple, and a diff compares
 * members pairwise.
 */

import type { Snapshot } from "@cte2/extractor";
import { balance, collectGear, makeEnv, statIndex } from "@cte2/engine";
import { statDisplay, statName, type Item } from "@cte2/schema";

import { signed, smart } from "./format.js";

/** The three modifier kinds, kept apart because they do not add. */
export type ModKind = "flat" | "percent" | "more";

export const MOD_KINDS: readonly ModKind[] = ["flat", "percent", "more"];

/** One stat's contribution from one item, split by modifier kind. */
export type StatTotal = { flat: number; percent: number; more: number };

/**
 * Every stat an item grants, keyed by stat id.
 *
 * Insertion-ordered by first appearance, which is the order `collectGear` emits the contexts in
 * — base stats, then implicits, affixes, sockets. That is the order the game's own tooltip
 * prints an item in, so a list built straight off this map already reads the right way round.
 */
export function itemTotals(
  snapshot: Snapshot,
  item: Item,
  characterLevel: number,
): Map<string, StatTotal> {
  const env = makeEnv(snapshot, statIndex(snapshot), balance(snapshot), characterLevel);
  const contexts = collectGear(env, [item]);

  const totals = new Map<string, StatTotal>();
  for (const context of contexts) {
    for (const mod of context.stats) {
      let bucket = totals.get(mod.statId);
      if (bucket === undefined) {
        bucket = { flat: 0, percent: 0, more: 0 };
        totals.set(mod.statId, bucket);
      }
      if (mod.type === "FLAT") bucket.flat += mod.value;
      else if (mod.type === "PERCENT") bucket.percent += mod.value;
      else bucket.more += mod.value;
    }
  }
  return totals;
}

/** One stat's contribution as the game words it: "+40 Armor", "+12% Increased Armor". */
export function totalLines(snapshot: Snapshot, totals: Map<string, StatTotal>): string[] {
  const lines: string[] = [];
  for (const [statId, bucket] of totals) {
    const name = statName(snapshot, statId);
    if (bucket.flat !== 0) lines.push(`${signed(bucket.flat)} ${name}`);
    if (bucket.percent !== 0) lines.push(`${signed(bucket.percent)}% Increased ${name}`);
    if (bucket.more !== 0) {
      lines.push(
        bucket.more < 0 ? `${smart(-bucket.more)}% Less ${name}` : `${smart(bucket.more)}% More ${name}`,
      );
    }
  }
  return lines;
}

/** Everything one item grants, as lines. The old `useItemPreview` body, shared. */
export function itemLines(snapshot: Snapshot, item: Item, characterLevel: number): string[] {
  return totalLines(snapshot, itemTotals(snapshot, item, characterLevel));
}

/**
 * One line of a swap: a stat, which kind of modifier moved, and by how much.
 *
 * `good` is `minus_is_good` applied rather than the sign of `change`. 38 stats in this pack are
 * better when they go down — every aura cost, every `*_dmg_received` — and painting a swap that
 * cuts your mana cost red would be the panel telling the player the opposite of the truth. It is
 * the same rule `DeltaTable` and the stat list already read, so the three agree.
 */
export type ItemDelta = {
  key: string;
  statId: string;
  label: string;
  kind: ModKind;
  /** What the currently equipped item gave, or 0 when the slot is empty. */
  from: number;
  /** What the candidate gives. */
  to: number;
  change: number;
  good: boolean;
};

/**
 * A stat's name, worded for the kind of modifier that moved.
 *
 * The same wording {@link totalLines} uses — "Increased Armor", not "Armor% increased" — so a
 * diff row and the tooltip line it came from name the same thing the same way. Without it the
 * two halves of one comparison read as two different stats.
 */
function kindLabel(kind: ModKind, name: string): string {
  if (kind === "flat") return name;
  return `${kind === "percent" ? "Increased" : "More"} ${name}`;
}

/**
 * What changes when `to` replaces `from`.
 *
 * `from` is `undefined` for an empty slot, which is the easy case the whole diff also covers:
 * every stat the candidate has is a gain, because there is nothing coming off.
 *
 * Ranked by the size of the change within a kind, biggest first, so the reason to take the swap
 * or leave it is in the first few rows. Stats both items grant equally are dropped — a row
 * reading "no change" is a row that costs a reader attention and pays nothing back.
 */
export function diffItems(
  snapshot: Snapshot,
  from: Item | undefined,
  to: Item | undefined,
  characterLevel: number,
): ItemDelta[] {
  const before = from === undefined ? new Map<string, StatTotal>() : itemTotals(snapshot, from, characterLevel);
  const after = to === undefined ? new Map<string, StatTotal>() : itemTotals(snapshot, to, characterLevel);

  const statIds = [...new Set([...after.keys(), ...before.keys()])];
  const deltas: ItemDelta[] = [];

  for (const statId of statIds) {
    const a = before.get(statId) ?? { flat: 0, percent: 0, more: 0 };
    const b = after.get(statId) ?? { flat: 0, percent: 0, more: 0 };
    const display = statDisplay(snapshot, statId);
    const name = statName(snapshot, statId);

    for (const kind of MOD_KINDS) {
      const change = b[kind] - a[kind];
      if (change === 0) continue;
      deltas.push({
        key: `${statId}:${kind}`,
        statId,
        label: kindLabel(kind, name),
        kind,
        from: a[kind],
        to: b[kind],
        change,
        good: display.minusIsGood ? change < 0 : change > 0,
      });
    }
  }

  // Biggest mover first. Percentages and flats are not comparable in magnitude, so the sort is
  // over the absolute change within the list as it stands rather than over a normalised score —
  // it is a reading order, not a ranking of which stat matters more.
  return deltas.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
}

/** A diff row's number, worded the way the item lines above are. */
export function deltaText(delta: ItemDelta): string {
  return `${signed(delta.change)}${delta.kind === "flat" ? "" : "%"}`;
}
