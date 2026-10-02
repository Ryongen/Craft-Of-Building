/**
 * What one item *contains*, worded the way the game words it.
 *
 * The lines on the card: what this piece grants, resolved through the engine's own `collectGear`
 * over a one-item list. Not a walk over the document's fields, for the reason the gear panel's
 * original preview gave: the collector applies the item-level scaling and the roll interpolation
 * exactly as the character sheet does, so nothing shown here can disagree with the sidebar. The
 * rules that fall out for free are the ones people trip over — an item above the character's
 * level contributes nothing at all, and quality lands on the base roll and nowhere else.
 *
 * ## What this is not
 *
 * It is not what an item is *worth*. That question needs the rest of the character — the tree's
 * increases, the curves, the caps — and is answered by computing the build that has the item,
 * which is `state/compare.ts`'s job and `ItemDiffCard`'s. This module used to carry a `diffItems`
 * that subtracted one item's lines from another's and called the result a swap; it was a true
 * statement about two items and the wrong answer to the question anybody was asking.
 *
 * ## Why the three modifier types stay apart
 *
 * `FLAT`, `PERCENT` and `MORE` are not addable. +40 Armor and +40% Armor are different claims
 * about the same stat, and a sum of the two is a number that appears nowhere. So a total is a
 * triple per stat and a *line* is drawn per non-zero member of that triple.
 */

import type { Snapshot } from "@cte2/extractor";
import { balance, collectGear, collectJewels, makeEnv, statIndex } from "@cte2/engine";
import type { ExactMod } from "@cte2/engine";
import {
  affix,
  fillTemplate,
  statDisplay,
  statNameRaw,
  stripFormatting,
  underAugmentLabel,
  type Item,
  type Jewel,
} from "@cte2/schema";

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
    for (const mod of context.stats) addMod(totals, mod);
  }
  return totals;
}

/** Folds one resolved modifier into a stat-keyed accumulator. */
function addMod(totals: Map<string, StatTotal>, mod: ExactMod): void {
  let bucket = totals.get(mod.statId);
  if (bucket === undefined) {
    bucket = { flat: 0, percent: 0, more: 0 };
    totals.set(mod.statId, bucket);
  }
  if (mod.type === "FLAT") bucket.flat += mod.value;
  else if (mod.type === "PERCENT") bucket.percent += mod.value;
  else bucket.more += mod.value;
}

/**
 * One resolved line of an item, with what the game needs to colour it.
 *
 * The text alone was not enough. The card paints every number green, which is right for most
 * lines and a lie for the ones that matter most: a unique carrying −40% Attack Speed as its
 * downside read as a bonus. {@link StatLine.good} is what fixes it, and it is the game's own
 * rule rather than the sign of the number — see {@link totalLines}.
 */
export type StatLine = {
  /** The line as the game words it — "+40 Armor", "−40% Attack Speed". */
  text: string;
  statId: string;
  /** The signed value the line is about; `MORE` keeps its sign even though the word is "Less". */
  value: number;
  /** True when the line is an improvement. `minus_is_good` applied, never the sign. */
  good: boolean;
};

/**
 * One stat's contribution as the game words it: "+40 Armor", "+75% Cold Resistance".
 *
 * ## Which lines are green
 *
 * Not the positive ones — the *good* ones, which is the same distinction the game draws:
 *
 *     public ChatFormatting numberColor(ChatFormatting format, Stat stat, float val) {
 *         if (stat.minus_is_good) {
 *             if (val > 0) { return ChatFormatting.RED; } else { return ChatFormatting.GREEN; }
 *         } else {
 *             if (val > 0) { return ChatFormatting.GREEN; } else { return ChatFormatting.RED; }
 *         }
 *     }
 *
 * — `StatNameRegex.numberColor`, confirmed in the 6.4.13 jar. So −40% Attack Speed on a unique
 * is red and −15 Mana Cost is green, and neither is decided by the minus sign. It is the rule
 * `DeltaTable` and the stat sheet already read, so all three agree about which way a cost points.
 *
 * ## Why a flat line can still end in a percent
 *
 * `FLAT` is the modifier *kind* — it adds to the stat rather than scaling it — and says nothing
 * about the stat's own unit. Half this pack's stats are percentages in their own right, and the
 * game prints them with a `%` whether the modifier that granted them was flat or not: a ring
 * granting `FLAT 75 water_resist` reads "+75% Cold Resistance" on its tooltip, because 75 points
 * of a resist *is* 75 percent.
 *
 * `mmorpg_stat.is_perc` is that fact, and reading it here is what stopped every resist, every
 * `phys_taken_as_*`, Area of Effect, Area Damage and Song Effect Strength from rendering as a
 * bare number that could not be told from a rating. The same flag draws the `%` on the stat
 * sheet, the stat breakdown and the what-if tables, so the item card is no longer the one
 * surface with its own opinion.
 *
 * `PERCENT` and `MORE` carry their `%` unconditionally, as they always did: those are scalings,
 * and "+12% Increased Armor" is a percent of a rating that is not itself one.
 *
 * ## The lines that are whole sentences
 *
 * 57 stats in this pack are named with the value *inside* the name — `[VAL1]% Chance to Cast Fan
 * of Knives on Hit`. The game fills the placeholder and prints nothing else:
 *
 *     if (stat.is_long) {
 *         String txt = stat.locName().getString();
 *         txt = txt.replace(Stat.VAL1, plusminus + v1s);
 *         return txt;
 *     }
 *
 * — `StatNameRegex.translate`, and note it returns *before* the `More`/`Less` wording, so a
 * template wins over the modifier kind. Composing "+27% [VAL1]% Chance to Cast…" the ordinary way
 * printed the value twice and the placeholder raw, which is the data's variable name on screen.
 */
export function totalLines(snapshot: Snapshot, totals: Map<string, StatTotal>): StatLine[] {
  const lines: StatLine[] = [];
  for (const [statId, bucket] of totals) {
    const display = statDisplay(snapshot, statId);
    const name = display.name;
    const unit = display.isPerc ? "%" : "";
    const line = (text: string, value: number): StatLine => ({
      text,
      statId,
      value,
      good: display.minusIsGood ? value < 0 : value > 0,
    });

    if (display.templated) {
      const raw = statNameRaw(snapshot, statId);
      for (const value of [bucket.flat, bucket.percent, bucket.more]) {
        if (value === 0) continue;
        lines.push(
          line(
            raw === undefined
              ? `${signed(value)}${unit} ${name}`
              : stripFormatting(fillTemplate(raw, [signed(value)])),
            value,
          ),
        );
      }
      continue;
    }

    if (bucket.flat !== 0) lines.push(line(`${signed(bucket.flat)}${unit} ${name}`, bucket.flat));
    if (bucket.percent !== 0) {
      lines.push(line(`${signed(bucket.percent)}% Increased ${name}`, bucket.percent));
    }
    if (bucket.more !== 0) {
      // The word carries the sign, so the text reads "20% Less" rather than the game's own
      // "−20% Less" — but `value` stays signed, because that is what decides the colour.
      lines.push(
        line(
          bucket.more < 0
            ? `${smart(-bucket.more)}% Less ${name}`
            : `${smart(bucket.more)}% More ${name}`,
          bucket.more,
        ),
      );
    }
  }
  return lines;
}

/**
 * Which part of an item a line came from.
 *
 * `ModOrigin["kind"]` names every part except socketed **gems**, and that is not an omission:
 * `BaseGem` stats are fixed rather than rolled, so `socketStats` never tags them and they arrive
 * with no origin at all. `"socket"` is the bucket those land in, and nothing else does.
 *
 * `"aura"` is the jewel side of the same gap. A Watcher's Eye line is an ordinary affix roll —
 * `collectJewels` tags it `prefix` like any other — and what makes it conditional is the
 * *context* it lands in rather than anything on the modifier. See {@link jewelSections}.
 */
export type ItemSectionKind = NonNullable<ExactMod["from"]>["kind"] | "socket" | "aura";

/** One part of an item, already worded: `{ kind: "prefix", label: "Prefix Stats", lines: [...] }`. */
export type ItemSection = {
  kind: ItemSectionKind;
  /**
   * Unique within one card, and the only thing that is.
   *
   * `kind` was the key until an Abyssal Eye started getting one section per Augment: three
   * `aura` sections in a row, three identical React keys. For everything else it is still the
   * kind.
   */
  id: string;
  label: string;
  lines: StatLine[];
  /**
   * An Augment section the build is not running, so the sheet counts none of these lines.
   *
   * Printed anyway, which is a deliberate reversal: the card used to drop them and carry a
   * footnote, and what that showed was an Abyssal Eye with a heading missing and no way to
   * find out what the missing line was worth. An eye is bought *for* the lines it is not
   * currently using, so they are shown, marked, and left out of nothing else.
   */
  dormant?: boolean;
};

/**
 * The parts a tooltip prints, in the order it prints them.
 *
 * Base first, because the base roll is what the item *is* and an affix is what was done to it.
 * The rest follow `GearItemData.GetAllStatContainers` — see `collect/gear.ts`.
 */
const ITEM_SECTIONS: readonly { kind: ItemSectionKind; label: string }[] = [
  { kind: "base", label: "Base Stats" },
  { kind: "implicit", label: "Implicit Stats" },
  { kind: "prefix", label: "Prefix Stats" },
  { kind: "suffix", label: "Suffix Stats" },
  { kind: "corruption", label: "Corruption Stats" },
  // "Infusion", not "Enchantment". `enchant` is the affix type's id in the data and stays the
  // origin tag the engine sets, but the word a player uses for it is Infusion — Minecraft's own
  // enchantments are a different thing entirely, granted through `mmorpg_stat_compat`, and this
  // card can show both at once. The item editor has called it an Infusion for a while; this was
  // the last place that did not.
  { kind: "enchant", label: "Infusion" },
  { kind: "unique", label: "Unique Stats" },
  { kind: "rune", label: "Rune Stats" },
  { kind: "runeword", label: "Runeword Stats" },
  { kind: "socket", label: "Socket Stats" },
];

/**
 * {@link totalLines}, split by which part of the item produced each line.
 *
 * The engine tags every modifier it resolves with its origin (`ExactMod.from`), so the split is
 * a regroup of what `collectGear` already returned rather than a per-affix re-derivation. That
 * matters for more than brevity: an implicit and a prefix on the same item can grant the same
 * stat, and only the tag says which line is which. Stripping the other lists off the item and
 * re-running the collector — the obvious first attempt — cannot work, because the base stats,
 * uniques and gems are not affixes and survive every one of those strips, so each group ended up
 * carrying all of them.
 *
 * Sections with no lines are dropped, and a warning the collector raised (an unknown affix, a
 * missing base roll) surfaces in the caller's diagnostics rather than here.
 */
export function itemSections(
  snapshot: Snapshot,
  item: Item,
  characterLevel: number,
): ItemSection[] {
  const env = makeEnv(snapshot, statIndex(snapshot), balance(snapshot), characterLevel);
  const [gear] = collectGear(env, [item]);

  const byKind = new Map<ItemSectionKind, Map<string, StatTotal>>();
  for (const mod of gear?.stats ?? []) {
    addTo(byKind, mod.from?.kind ?? "socket", mod);
  }

  return assemble(snapshot, ITEM_SECTIONS, byKind);
}

/**
 * Folds one modifier into the bucket for its part of the item, creating the bucket if new.
 *
 * Generic in the key because a jewel buckets its conditional lines by *Augment* rather than by
 * part, and that is the only difference between the two walks.
 */
function addTo<K>(byKey: Map<K, Map<string, StatTotal>>, key: K, mod: ExactMod): void {
  let totals = byKey.get(key);
  if (totals === undefined) {
    totals = new Map<string, StatTotal>();
    byKey.set(key, totals);
  }
  addMod(totals, mod);
}

/** The buckets, worded and put in the card's order, with the empty ones dropped. */
function assemble(
  snapshot: Snapshot,
  order: readonly { kind: ItemSectionKind; label: string }[],
  byKind: ReadonlyMap<ItemSectionKind, Map<string, StatTotal>>,
): ItemSection[] {
  return order
    .map(({ kind, label }) => ({
      kind,
      id: kind,
      label,
      lines: totalLines(snapshot, byKind.get(kind) ?? new Map<string, StatTotal>()),
    }))
    .filter((section) => section.lines.length > 0);
}

/**
 * The parts of a *jewel*, which are three of the ten a piece of gear has.
 *
 * A jewel has no base, no implicit, no socket and no enchant, and its rolled affixes are not
 * split into prefixes and suffixes — `JewelItemData` keeps one `affixes` list and one `cor`
 * list. "Jewel Stats" is therefore the heading over what the game would call prefixes, because
 * calling them prefixes on an item that has no suffixes would invent a distinction the data
 * does not draw.
 */
const JEWEL_SECTIONS: readonly { kind: ItemSectionKind; label: string }[] = [
  { kind: "prefix", label: "Jewel Stats" },
  { kind: "corruption", label: "Corruption Stats" },
];

/**
 * {@link itemSections} for a jewel: what it grants, split by which list it came from.
 *
 * Through `collectJewels` for the reason the gear card goes through `collectGear` — the sheet
 * and the card must be the same computation — and that brings the game's rules with it:
 * corruptions resolve alongside the rolled affixes, and every roll scales to the jewel's own
 * level rather than the character's.
 *
 * ## One heading per Augment
 *
 * An Abyssal Eye is two or three `auraStats` lines, each waiting on a *different* Augment —
 * `Affix.eye_aura_req`, which the record itself never names. So the card prints the game's own
 * heading per Augment (`underAugmentLabel`, from `mmorpg.word.while_under_aura`) with that
 * Augment's lines under it. It used to print one "While Under Aura" heading over the lot, which
 * is the one thing a reader cannot act on: the point of an eye is *which* Augment each line is
 * bought for.
 *
 * Two affixes can name the same Augment — `chaos_damage_eye` and `chaos_damage_ms_eye` both
 * wait on Chaos Damage — so the grouping is by Augment and not by line, and one heading covers
 * both.
 *
 * `aurasOn` no longer decides what is *printed*, only what is marked live. Every gate is opened
 * for the collector and the sections the build is not running come back flagged `dormant`; the
 * card dims those and says which Augment would switch them on. The sheet still counts exactly
 * what `collectJewels` counts with the build's real set — this function is the card, and the
 * card's job is to say what the jewel is worth, including under the Augment you have not
 * socketed yet.
 *
 * ## Why the aura lines are told apart by their context
 *
 * `affixStats` tags every jewel roll `prefix`, aura lines included, so `ExactMod.from.kind`
 * cannot separate them. What does is the *shape* of what `collectJewels` returns: one context
 * per aura line, each pathed `jewels[0].auraStats[n]`, and then one context for the jewel
 * itself at `jewels[0]`. The path is the discriminator, and it is stable because it is the same
 * string the validator points its diagnostics at.
 *
 * The socket clamp is deliberately not applied. A jewel past the last socket grants nothing,
 * and the card's job is to say what the jewel *is* — the list already badges it "no socket" and
 * the panel already carries the notice explaining that the engine drops it.
 */
export function jewelSections(
  snapshot: Snapshot,
  jewel: Jewel,
  characterLevel: number,
  aurasOn: ReadonlySet<string>,
): ItemSection[] {
  const env = makeEnv(snapshot, statIndex(snapshot), balance(snapshot), characterLevel);

  // Which Augment gates each `auraStats` entry, by its index in the list — the affix's
  // `eye_aura_req`, since `StatsWhileUnderAuraData` does not carry it. A line whose affix is
  // unknown or carries no requirement is absent here and the collector reports it.
  const gatedBy = new Map<number, string>();
  (jewel.auraStats ?? []).forEach((line, index) => {
    const required = affix(snapshot, line.affixId)?.eyeAuraReq ?? "";
    if (required.length > 0) gatedBy.set(index, required);
  });

  const contexts = collectJewels(env, [jewel], new Set(gatedBy.values()));

  const byKind = new Map<ItemSectionKind, Map<string, StatTotal>>();
  const byAugment = new Map<string, Map<string, StatTotal>>();
  for (const context of contexts) {
    const line = auraLineIndex(context.path);
    const augment = line === undefined ? undefined : gatedBy.get(line);
    for (const mod of context.stats) {
      if (augment === undefined) addTo(byKind, mod.from?.kind ?? "prefix", mod);
      else addTo(byAugment, augment, mod);
    }
  }

  // In the order the jewel lists them, which is the order the game's own tooltip prints them.
  const augments: ItemSection[] = [];
  const seen = new Set<string>();
  for (const augment of gatedBy.values()) {
    if (seen.has(augment)) continue;
    seen.add(augment);
    const totals = byAugment.get(augment);
    if (totals === undefined) continue;
    augments.push({
      kind: "aura",
      id: `aura:${augment}`,
      label: underAugmentLabel(snapshot, augment),
      lines: totalLines(snapshot, totals),
      dormant: !aurasOn.has(augment),
    });
  }

  return [...assemble(snapshot, JEWEL_SECTIONS, byKind), ...augments];
}

/** The `n` of a `jewels[0].auraStats[n]` path; `undefined` for the jewel's own context. */
function auraLineIndex(path: string): number | undefined {
  const match = /\.auraStats\[(\d+)\]$/.exec(path);
  return match === null ? undefined : Number(match[1]);
}
