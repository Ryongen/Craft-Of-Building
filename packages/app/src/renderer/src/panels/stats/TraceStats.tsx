/**
 * The stats a figure was actually built from — read off the trace, not guessed.
 *
 * The Damage and Defence tabs each end in a number with fourteen layers behind it, and the
 * obvious question at that point is "which of my stats is this made of". A curated list per
 * screen would be a guess that goes stale the moment the pack adds a stat; the layer trace
 * already names every stat that touched the hit, because the recorder writes one contribution
 * per stat that fed a layer. So this reads that list back.
 *
 * The consequence worth stating: a stat here is a stat that **measurably did something to this
 * figure**. `fire_resist` is in the fire column and not in the cold one. A gem that grants
 * `chaos_penetration` to a cold skill does not appear, because the layers never read it. That is
 * strictly more useful than a list of stats that *could* matter, and it is why this is a read of
 * the trace rather than a table of ids.
 */

import { statDesc, statDisplay, statName } from "@cte2/schema";
import type { EventTrace, LayerStep } from "@cte2/engine";
import type { ReactNode } from "react";

import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { USABLE_NOUN, num, smart } from "../../ui/format.js";
import { StatIcon } from "../../ui/StatIcon.js";
import { statLook } from "../../ui/stat-look.js";
import type { SheetFocus } from "./SheetDetail.js";
import { useTechnical } from "../../ui/detail-mode.js";

/**
 * Every stat that fed a layer on one side of a trace, in the order the layers ran.
 *
 * Order matters and is not alphabetical: the layers run in the game's own priority order, so the
 * list reads the way the hit was actually built — conversion before penetration before the
 * mitigation layers. Deduplicated, keeping the first appearance, because a stat that feeds two
 * layers is one stat.
 *
 * Bonus-element children are walked too. A physical hit converting half of itself to cold spawns
 * a child event whose layers read the *cold* stats, and those are as much a part of the figure as
 * the parent's.
 */
export function traceStats(trace: EventTrace, side: "Source" | "Target"): string[] {
  const seen = new Set<string>();
  const walk = (node: EventTrace): void => {
    for (const step of node.steps as LayerStep[]) {
      for (const contribution of step.contributions) {
        const fromSource = contribution.side === "Source";
        if (fromSource !== (side === "Source")) continue;
        seen.add(contribution.statId);
      }
    }
    // The MORE multipliers are held out of every layer and applied last, so they have no step to
    // hang off — and they are some of the biggest terms in the number.
    if (side === "Source") for (const more of node.moreMultis) seen.add(more.statId);
    for (const child of node.children) walk(child);
  };
  walk(trace);
  return [...seen];
}

/**
 * The same, gathered across every element of the defence pass.
 *
 * Defence is five sweeps rather than one, and a reader wants the union: `fire_resist` belongs on
 * the list even though only one of the five read it. Which element each came from is not carried,
 * because the stat's own name says it.
 */
export function defenceStats(steps: readonly LayerStep[][]): string[] {
  const seen = new Set<string>();
  for (const perElement of steps) {
    for (const step of perElement) {
      for (const contribution of step.contributions) {
        if (contribution.side === "Source") continue;
        seen.add(contribution.statId);
      }
    }
  }
  return [...seen];
}

/**
 * How one row's value is written: the raw number, or the share of a hit it is actually worth.
 *
 * `IUsableStat.getUsableValue` is the game's own answer to "what is this stat doing", and half
 * the rows on the Defence tab are one: 2,679 armour is a rating on a hyperbolic curve and the
 * only question ever asked of it is what fraction of a hit it stops. The sidebar has printed it
 * that way for a while — percent first, rating in the parenthetical — and this list, which is
 * literally the stats *behind* the figure the sidebar shows, was still printing bare ratings.
 *
 * Two shapes, because the family splits in two and the split is `is_perc`:
 *
 *  - **A rating** (`armor`, `dodge`, `spell_dodge`) always reads as `56.29% (2,679)`. The two
 *    numbers are a conversion, not a comparison, and neither is redundant.
 *  - **A percentage** (the resists, `block_chance`) reads as its bare value — because for those
 *    the "usable" number *is* the value — until it passes the ceiling, and then as
 *    `75% (143%)`. `ElementalResist.getUsableValue` clamps to `min(75 + max_<element>_resist,
 *    90)`, so the two disagreeing is the cap being hit and nothing else. Writing every resist in
 *    the two-number form would put `60% (60%)` on rows where it says nothing.
 *
 * The half-point tolerance on the cap is the `(int)` cast in `getUsableValue`: 74.6% resistance
 * mitigates 74%, which is truncation rather than a cap, and flagging it would decorate every
 * fractional resist in the build.
 */
type ValueShape =
  | { kind: "plain" }
  /** A rating and what it converts to. */
  | { kind: "rating"; usable: number; raw: number }
  /** A percentage clipped by its ceiling: what applies, and what was granted. */
  | { kind: "capped"; usable: number; raw: number };

function valueShape(
  stat: { value: number; usableValue?: number } | undefined,
  isPerc: boolean,
): ValueShape {
  if (stat?.usableValue === undefined) return { kind: "plain" };
  if (!isPerc) return { kind: "rating", usable: stat.usableValue, raw: stat.value };
  if (stat.value <= stat.usableValue + 0.5) return { kind: "plain" };
  return { kind: "capped", usable: stat.usableValue, raw: stat.value };
}

/**
 * The list, as clickable rows.
 *
 * `scope` decides which sheet a row opens against, and it is not cosmetic: a damage figure is
 * built from the *spell's* stat unit, where the support gems are, so a row here opening the
 * character breakdown would answer a question nobody asked. Defence has only the one sheet.
 */
export function TraceStatList({
  statIds,
  scope,
  selected,
  onSelect,
  empty,
}: {
  statIds: readonly string[];
  scope: "character" | "skill";
  selected: SheetFocus | null;
  onSelect: (focus: SheetFocus) => void;
  /** What to say when the trace named nothing, which is a real answer rather than a failure. */
  empty: string;
}): ReactNode {
  const [technical] = useTechnical();
  const { snapshot } = useWorld();
  const derived = useDerived();

  if (statIds.length === 0) return <div className="muted text-sm prose">{empty}</div>;

  const kind = scope === "skill" ? "skill-stat" : "stat";
  const read = (statId: string): number | undefined =>
    scope === "skill"
      ? derived.skillBreakdown(statId)?.stat.value
      : derived.stats.get(statId)?.value;

  return (
    <div className="trace-stats">
      {statIds.map((statId) => {
        const value = read(statId) ?? derived.stats.get(statId)?.value ?? 0;
        const stat = derived.stats.get(statId);
        const multi = stat?.dmgMulti ?? 1;
        const isPerc = statDisplay(snapshot, statId).isPerc;
        // Character scope only: `stat` is the character sheet, and in skill scope the value
        // beside it came from the spell's own unit — pairing the two would print one sheet's
        // conversion over another sheet's number.
        const shape: ValueShape =
          scope === "character" ? valueShape(stat, isPerc) : { kind: "plain" };
        const isOpen =
          selected !== null &&
          (selected.kind === "stat" || selected.kind === "skill-stat") &&
          selected.statId === statId &&
          selected.kind === kind;

        return (
          <div
            key={statId}
            className={`stat-row${isOpen ? " selected" : ""}`}
            title={technical ? statId : (statDesc(snapshot, statId) ?? undefined)}
            onClick={() => onSelect({ kind, statId } as SheetFocus)}
          >
            <StatIcon statId={statId} />
            <span className="name" style={{ color: statLook(snapshot, statId).colour }}>
              {statName(snapshot, statId)}
            </span>
            {/* A MULTIPLICATIVE_DAMAGE stat reads 0 and carries its whole contribution here, so
                without the badge the most important rows on this list look like empty ones. */}
            {multi !== 1 && (
              <span
                className="badge warn"
                title="MORE multiplier, held out of the value and spent once in the damage layer"
              >
                ×{num(multi, 3)}
              </span>
            )}
            {/* The `%` is the stat's own `is_perc`, not the modifier type: this row is a
                *value*, so it reads the way the game's stat GUI reads it. Without it a 40%
                Shatter Chance and a 40-point Dodge Rating are the same two characters, and the
                two rows sit next to each other on the Defence tab.

                Over the cap it is written the way the sidebar writes it, capped first: this list
                is the stats *behind a figure*, and a 143% fire resistance next to an effective
                HP computed through 75% is the one place where printing the granted number alone
                reads as a promise the figure did not keep. See `overCap`. */}
            <span
              className="value"
              {...(shape.kind === "plain"
                ? {}
                : shape.kind === "rating"
                  ? {
                      title:
                        `${num(shape.usable, 2)}% ${USABLE_NOUN[statId] ?? "effective"} from ` +
                        `${smart(shape.raw)}. IUsableStat.getUsableValue, a hyperbolic curve read ` +
                        `at your level, so the same rating is worth less the more of it you have.`,
                    }
                  : {
                      title:
                        `Capped at ${smart(shape.usable)}%. ` +
                        `ElementalResist.getUsableValue clamps to 75 plus this element's ` +
                        `max-resist stat, itself clamped to 90. The ` +
                        `${smart(shape.raw - shape.usable)}% above it is granted and unused, and ` +
                        `no figure on this tab counts it.`,
                    })}
            >
              {shape.kind === "plain" ? (
                <>
                  {smart(value)}
                  {isPerc ? "%" : ""}
                </>
              ) : shape.kind === "rating" ? (
                <>
                  {num(shape.usable, 2)}%<span className="faint"> ({smart(shape.raw)})</span>
                </>
              ) : (
                <>
                  {smart(shape.usable)}%<span className="faint"> ({smart(shape.raw)}%)</span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
