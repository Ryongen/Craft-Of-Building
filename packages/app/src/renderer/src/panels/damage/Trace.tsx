import {
  type DamageResult,
  type EventTrace,
  type LayerContribution,
  type LayerStep,
  type MitigationDetail,
  type MoreStep,
  type TargetStatOrigin,
} from "@cte2/engine";
import type { Snapshot } from "@cte2/extractor";
import {
  ELEMENTS,
  exileEffectName,
  statDisplay,
  statName,
  type ElementName,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useDerived, type ModContribution } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { StepRow as SharedStepRow } from "../../ui/StepRow.js";
import {
  contributionSubtotal,
  groupContributions,
  originPart,
  sourceName,
} from "../stats/StatBreakdown.js";
import { useEffectProvenance, useProvenance } from "../../ui/Provenance.js";
import { num, smart } from "../../ui/fields.js";
import { formatStep, layerLabel } from "../../ui/trace-format.js";

import { COLOURS } from "./colours.js";

/** One event: the hit itself, or a bonus element spawned by conversion. */
export function TraceBlock({
  trace,
  target,
  depth = 0,
}: {
  trace: EventTrace;
  /**
   * The enemy this hit landed on, so `[Target]` rows can be resolved against it.
   *
   * Threaded from the result that owns the trace rather than read off `useDerived`, because
   * the self-damage card's trace has a different target from the Damage tab's — its own
   * character — and the two must not borrow each other's.
   */
  target?: DamageResult["target"] | undefined;
  depth?: number;
}): ReactNode {
  const world = useWorld();
  const colour = COLOURS[trace.element] ?? "var(--text)";
  /*
    Multiplier rows whose printed name does not identify them.

    `melee_spell_dmg` and `str_dmg` are both "Melee Skill Damage" in this pack's lang file, and a
    build carrying both prints that name twice with two different numbers — which reads as a
    duplicated row rather than as two stats. The same is true of the four DoT stats, three of
    which end in "Damage Over Time". These rows get their stat id beside the name; the rest do
    not, because on every other row it is noise.
  */
  const ambiguousMores = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const more of trace.moreMultis) {
      const name = statName(world.snapshot, more.statId);
      const ids = byName.get(name) ?? new Set<string>();
      ids.add(more.statId);
      byName.set(name, ids);
    }
    return new Set(
      trace.moreMultis
        .map((more) => more.statId)
        .filter((statId) => {
          const name = statName(world.snapshot, statId);
          const ids = byName.get(name);
          return (
            ids !== undefined &&
            // Two stats under one name, or one stat writing two blocks — both print twice.
            (ids.size > 1 || trace.moreMultis.filter((m) => m.statId === statId).length > 1)
          );
        }),
    );
  }, [trace.moreMultis, world.snapshot]);

  /*
    Three wrappers, so the two columns' cards can be made to line up row for row.

    The working, the total and the bonus-element children are the card's three sections, and a
    reader compares the second of them across columns — "what did the hit come to, what did the
    ailment come to". Left to flow, those two rows land wherever their own list of layers happens
    to end, which on Holy Fire was twenty pixels apart because the ailment's event carries two
    `dot_dmg` multipliers the hit's does not. Wrapped, `.breakdown-grid` can put each section in a
    shared grid row, and the middle one being as tall as the taller of the two is what puts the
    Final damage rows level. See `.trace-body` in the stylesheet.

    The wrappers are unconditional, and only the card that is a direct child of a band cell is
    made a subgrid — a nested child trace flows normally inside its parent, which is right: it is
    a second event, not a second column.
  */
  return (
    <div
      /*
        A trace with no bonus-element children does not need the row that holds them, and saying
        so here rather than in CSS keeps the card's frame honest: spanning all three rows would
        have drawn 270px of empty box beside Holy Fire's Chaos block for the sake of a section
        this event does not have.
      */
      className={`card${trace.children.length === 0 ? " trace-leaf" : ""}`}
      style={depth > 0 ? { marginLeft: 16, borderLeft: `2px solid ${colour}` } : undefined}
    >
      <div className="trace-body">
      <div className="row gap-5" style={{ alignItems: "baseline" }}>
        <span className="num" style={{ color: colour, fontSize: 14 }}>
          {ELEMENTS[trace.element]?.displayName || trace.element}
        </span>
        {depth > 0 && <span className="badge">bonus damage</span>}
        {trace.takenAs && (
          <span className="badge" title="A `taken as` child skips the attacker's stat sweep entirely">
            taken as
          </span>
        )}
        {trace.penetration !== 0 && (
          <span
            className="badge mono"
            title={
              "One scalar, spent by every mitigation layer that reads it — the resists and " +
              "armour. Each of those rows shows what it spent."
            }
          >
            penetration {smart(trace.penetration)}
          </span>
        )}
      </div>

      <div className="trace-row mt-3">
        <span className="faint">Base damage</span>
        <span className="num">{smart(trace.baseNumber)}</span>
      </div>

      {trace.steps.length === 0 && trace.moreMultis.length === 0 && (
        <div className="faint text-sm mt-2">
          Nothing modified this hit.
        </div>
      )}

      {/*
        Wrapped so the zebra banding counts rows and nothing else.

        `SharedStepRow` returns a fragment — the row, then its open children — so every row of the
        tree, at every depth, is a sibling of every other. That is what lets one `nth-child` band
        the whole flattened list, and it is also why the band has to be scoped: left loose in
        `.trace-body` the parity would count the element heading and the Base damage row too, and
        flip halfway down when the Multipliers note came between two rows. See `.step-group`.
      */}
      <div className="step-group">
        {trace.steps.map((step, index) => (
          <StepRow
            key={`${step.layerId}-${step.side}-${index}`}
            step={step}
            element={trace.element}
            target={target}
          />
        ))}
      </div>

      {trace.moreMultis.length > 0 && (
        <>
          <div className="faint text-sm mt-3">
            Multipliers — held out of every layer and applied last
          </div>
          <div className="step-group">
            {trace.moreMultis.map((more, index) => (
              <MoreRow
                key={`${more.statId}-${more.effectId ?? ""}-${index}`}
                more={more}
                ambiguous={ambiguousMores.has(more.statId)}
              />
            ))}
          </div>
        </>
      )}

      </div>

      <div className="trace-final">
        <div className="trace-row" style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
          <strong>Final damage</strong>
          <span className="num" style={{ color: colour }}>
            {smart(trace.finalNumber)}
          </span>
        </div>
      </div>

      <div className="trace-children">
        {trace.children.map((child, index) => (
          <TraceBlock
            key={`${child.element}-${index}`}
            trace={child}
            target={target}
            depth={depth + 1}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One layer, expandable into the stats that fed it.
 *
 * The disclosure mechanics are `ui/StepRow`, shared with the stat drill-down. This grew the
 * pattern first and the drill-down was rebuilt around it; keeping two copies would have meant
 * two ideas of what an expandable row looks like, drifting apart one small fix at a time.
 * What stays here is the part that is genuinely about damage: a layer prints `x2.72` where a
 * contribution prints `+412`, and only this file knows which.
 */
function StepRow({
  step,
  element,
  target,
}: {
  step: LayerStep;
  /**
   * The element this event is dealt as, for the three layer names that are templates.
   *
   * Off the trace rather than off the step, because a `LayerStep` genuinely does not know it:
   * the accumulator belongs to the event, and it is the event that has an element. See
   * `layerLabel`.
   */
  element: ElementName;
  target: DamageResult["target"] | undefined;
}): ReactNode {
  const world = useWorld();

  /*
    The effectiveness this layer's writes were multiplied by, on the layer's own row.

    Only `flat_damage` ever has one, and only because the game multiplies added flat damage by
    `dmg_effectiveness` on the way in. It goes on the head of the row rather than only inside it
    because the row's number is the one that looks invented: +191 under a sheet that reads 99.84.
    One badge, not one per write — every write into a layer sees the same event scalar, so a
    second copy would only say it twice.
  */
  const effectiveness = step.contributions.find((c) => c.scaled !== undefined)?.scaled;

  return (
    <SharedStepRow
      label={
        <>
          <span className="faint">[{step.side}] </span>
          {layerLabel(world.snapshot, step, element)}
        </>
      }
      value={formatStep(step)}
      tone={stepTone(step)}
      {...(effectiveness === undefined
        ? {}
        : {
            badge: `×${num(effectiveness.multi, 3)} effectiveness`,
          })}
    >
      {step.contributions.length > 0 &&
        step.contributions.map((contribution, index) => (
          <ContributionRow
            key={`${contribution.statId}-${index}`}
            contribution={contribution}
            target={target}
            /*
              The unit of the accumulator this stat wrote into, which is the layer's and not the
              stat's. Only `ADD` layers — `flat_damage`, and `ele_as_extra_flat`'s flat twin —
              hold raw damage; the other four actions all accumulate percentage points, which is
              why `additive_damage` spends them as `1 + total / 100`. A row reading `+47.52`
              under a layer that then printed `x1.130` left the reader to work out that the two
              were the same number in different units.
            */
            percent={step.action !== "ADD"}
            // Same collision as the multiplier rows: two stats, one printed name. See `TraceBlock`.
            ambiguous={
              step.contributions.filter(
                (other) =>
                  other.statId !== contribution.statId &&
                  statName(world.snapshot, other.statId) ===
                    statName(world.snapshot, contribution.statId),
              ).length > 0
            }
          />
        ))}
    </SharedStepRow>
  );
}

/**
 * Which way a layer moved the number — green when it raised the damage, red when it cut it.
 *
 * Not the sign of the accumulator, which is a different question: `elemental_mitigation` against
 * a mob driven to −7% resistance holds −7 and multiplies by 1.07, and what the reader wants to
 * know at a glance is that the row *helped*. The three conversion actions move damage between
 * elements without creating or destroying any, so they stay uncoloured.
 */
function stepTone(step: LayerStep): "good" | "bad" | undefined {
  if (step.action === "MULTIPLY") {
    const multi = step.multiplier ?? 1;
    return multi > 1 ? "good" : multi < 1 ? "bad" : undefined;
  }
  if (step.action === "ADD") return valueTone(step.amount, false);
  return undefined;
}

/**
 * Green for a number that helps this hit, red for one that hurts it.
 *
 * `lowerIsBetter` is the whole of it, and it has two sources. A `[Target]` row is the mob's
 * sheet, so its fire resistance is good when it goes *down* and a mob driven below zero is the
 * best case there is — which is why a −7% wants to be green rather than merely looking like a
 * negative number. A row off **your** sheet asks the stat instead: 19 of this pack's stats are
 * better low, and `minus_is_good` is the game's own answer, the same one `compare` and the item
 * card already take. Guessing from the sign would paint a cooldown reduction red.
 */
function valueTone(value: number, lowerIsBetter: boolean): "good" | "bad" | undefined {
  if (value === 0) return undefined;
  return (lowerIsBetter ? value < 0 : value > 0) ? "good" : "bad";
}

/**
 * What a contribution reads as on its own terms, rather than as the accumulator saw it.
 *
 * `LayerData.reduce` records the negation of what it was handed — 25 resistance is stored as
 * −25 so that `1 + number / 100` comes out at ×0.75 — and printing that raw put the row at odds
 * with every number underneath it: a mob at −7% resistance showed `+7.00%`, and its own sheet
 * rows, one level down, showed −7. The defensive stats are the only ones that `reduce`, and all
 * of them read naturally as the mob's own figure.
 */
function contributionValue(contribution: LayerContribution): number {
  return contribution.kind === "reduce" ? -contribution.value : contribution.value;
}

/**
 * One stat that fed a layer, expandable into the things that granted it.
 *
 * **The two sides resolve against different sheets, and that is the whole point.** A `[Source]`
 * contribution is yours, so it drills into the character's stat breakdown — the item, perk, gem
 * or aura behind it. A `[Target]` contribution is the *enemy's*, and resolving one of those
 * against the character filed the mob's armour under the player's chestplate and Augments,
 * which is not a rough version of the truth: none of those stats is in that number.
 *
 * The enemy's own provenance is `target.origins`, and it is usually the answer to the question
 * a mitigation row provokes. A mythic mob declares 30 cold resistance, so `30 − 33.61`
 * penetration ought to read ×1.13 — and the panel says ×1.20, because Banner of the Piercing
 * Gale took 16.8 off the mob first and the layer saw 13.2. Every number in that sentence is
 * now a row you can open.
 */
function ContributionRow({
  contribution,
  target,
  percent,
  ambiguous = false,
}: {
  contribution: LayerContribution;
  /** The enemy this hit landed on. Absent on a self-hit, where the target *is* the character. */
  target: DamageResult["target"] | undefined;
  /** The layer's accumulator is in percentage points rather than raw damage. */
  percent: boolean;
  /** Another contribution to this layer prints the same name, so this one needs its id. */
  ambiguous?: boolean;
}): ReactNode {
  const world = useWorld();
  const fromTarget = contribution.side !== "Source";
  const origin = fromTarget ? target?.origins.get(contribution.statId) : undefined;
  const mitigation = contribution.mitigation;
  const shown = contributionValue(contribution);

  return (
    <SharedStepRow
      depth={1}
      label={
        <>
          {statName(world.snapshot, contribution.statId)}
          {ambiguous && (
            <span className="faint mono text-xs" title={contribution.statId}>
              {" "}
              {contribution.statId}
            </span>
          )}
        </>
      }
      value={signedValue(shown, percent)}
      tone={valueTone(shown, fromTarget)}
      /*
        Open already, on the rows that spend penetration.

        Expanding `Elemental Mitigation` used to show one row — a finished resistance figure with
        the penetration that produced it a badge away at the top of the card, and the mob's
        declared value nowhere at all. The subtraction *is* what that section is for, so it is
        what the section shows; every other row still opens on a click.
      */
      defaultOpen={contribution.mitigation !== undefined}
      {...(fromTarget && origin === undefined && mitigation === undefined
        ? {
            title:
              "The target's own stat, straight off the enemy preset — nothing this build does " +
              "modifies it. See the Target card.",
          }
        : {})}
    >
      {/*
        The stat sheet already knows which item, perk, gem or aura produced each modifier, so a
        layer row resolves all the way down without any new bookkeeping.

        Passed as a **thunk**, because this is the expensive corner of the panel: without one,
        `breakdown` ran and a row was built for every modifier of every contribution of every
        layer on every render, and then thrown away unopened. See `ui/StepRow`.
      */}
      {fromTarget
        ? origin === undefined && mitigation === undefined
          ? undefined
          : () => (
              <TargetOrigin
                statId={contribution.statId}
                origin={origin}
                mitigation={mitigation}
                applied={shown}
                percent={percent}
              />
            )
        : () => (
            <>
              {/*
                The multiplication the event did on the way in, where it did one.

                This is the row that stops flat added damage reading as a number the panel
                invented. `flat_water_added_damage` is 99.84 on the sheet and writes +191.12 into
                `flat_damage`, because `BonusFlatElementalDamage` multiplies by the skill's
                `dmg_effectiveness` first — and both figures were already on screen, one directly
                under the other, with nothing between them saying why they differ. The
                effectiveness is the one knob `dmg_effectiveness` turns anywhere in the game, and
                it is the whole reason flat added damage is worth carrying on one skill and not
                on another.
              */}
              {contribution.scaled !== undefined && (
                <SharedStepRow
                  depth={2}
                  label={<span className="faint">damage effectiveness</span>}
                  value={`${signedValue(contribution.scaled.raw, percent)} × ${num(contribution.scaled.multi, 3)} = ${signedValue(shown, percent)}`}
                  tone={contribution.scaled.multi > 1 ? "good" : "bad"}
                  title={
                    "`dmg_effectiveness` on this act's value calculation, read at the skill's " +
                    "rank. Flat added damage is multiplied by it before it reaches the layer, so " +
                    "the sheet figure below and the row above are the same stat either side of " +
                    "this multiplication."
                  }
                />
              )}
              <StatSources statId={contribution.statId} depth={2} kind="value" />
            </>
          )}
    </SharedStepRow>
  );
}

/**
 * One MORE multiplier, expandable into the stat behind it and the gear behind that.
 *
 * These were the only rows on the tab that were a dead end. A layer opened into the stats that
 * fed it and each of those into the item, perk, gem or aura that granted it — and then
 * `Multipliers:`, which on a finished build is most of the damage and is where a stat like
 * `fire_dot_damage` actually lands, printed a name and a number and stopped. Reading
 * "Damage Over Time x1.24" twice with no way to ask which +24% either row was is the complaint
 * this answers.
 *
 * The **stat's own value comes first**, because the multiplier is not the stat: the sweep records
 * `StatData.m`, which `getMoreStatTypeMulti` derives from the value, so `+24%` on the sheet and
 * `x1.24` here are two readings of one number and the rows underneath add up to the first.
 *
 * `effectId` is on the row rather than hidden, for the case that makes two rows look like a
 * duplicate: one stat can carry several `MULTIPLICATIVE_DAMAGE` blocks behind different gates,
 * and the game records one row per block. Two rows with one name are two blocks, not a bug.
 */
function MoreRow({ more, ambiguous }: { more: MoreStep; ambiguous: boolean }): ReactNode {
  const world = useWorld();

  return (
    <SharedStepRow
      label={
        <>
          {statName(world.snapshot, more.statId)}
          {ambiguous && (
            <span
              className="faint mono text-xs"
              title={
                `\`${more.statId}\`` +
                (more.effectId === undefined ? "" : `, written by \`${more.effectId}\``) +
                ". Another multiplier on this hit prints the same name — either a second stat " +
                "the pack names identically, or a second MULTIPLICATIVE_DAMAGE block of this " +
                "one, which the game records and prints as its own row."
              }
            >
              {" "}
              {more.statId}
            </span>
          )}
        </>
      }
      value={`x${num(more.multi, 3)}`}
      tone={more.multi > 1 ? "good" : more.multi < 1 ? "bad" : undefined}
      title={`${smart(more.before)} × ${num(more.multi, 4)} = ${smart(more.after)}`}
    >
      {() => <StatSources statId={more.statId} depth={1} kind="more" />}
    </SharedStepRow>
  );
}

/**
 * Where a `[Target]` number came from, start to finish.
 *
 * The chain is the answer to the question a mitigation row provokes, and until now it stopped two
 * steps short of it. A mythic mob declares 30 cold resistance and the row said −20.41%, which is
 * a true number with nothing on screen to derive it from: Banner of the Piercing Gale takes 16.8
 * off the mob first, and 33.61 penetration comes off what is left. Both of those are rows now, so
 * the column adds up on its own.
 *
 * **It renders with no `origin` too.** `target.origins` only holds stats something *aimed* at —
 * an affix or one of your debuffs — so on the ordinary build, carrying neither, a mitigation row
 * had no drill-down at all and the mob's declared figure never appeared anywhere. Where there is a
 * `mitigation` detail its `sheet` is that figure, and it is the same number `origin.final` would
 * have been.
 */
function TargetOrigin({
  statId,
  origin,
  mitigation,
  applied,
  percent,
}: {
  statId: string;
  origin: TargetStatOrigin | undefined;
  mitigation: MitigationDetail | undefined;
  /** What the layer ended up reducing by, in the layer's own unit. */
  applied: number;
  /** The layer's accumulator is in percentage points. See `ContributionRow`. */
  percent: boolean;
}): ReactNode {
  const world = useWorld();
  /*
    Two units, because the chain genuinely crosses one.

    Every row above the last is the mob's *stat* — `fire_resist` is a percentage and `armor` is a
    rating — so they take the stat's own `is_perc`, the same reading the Stats tab takes. The
    last row is what the layer accumulated, which for armour is the percentage the curve turned
    those points into. Printing the whole column in the layer's unit put a `%` on 1,200 points of
    armour.
  */
  const sheetUnit = statDisplay(world.snapshot, statId).isPerc ? "%" : "";
  const layerUnit = percent ? "%" : "";
  const declared = origin?.declared ?? mitigation?.sheet ?? 0;
  /*
    What the mitigation effect read off the mob's sheet: after its affixes and your debuffs, and
    before any penetration. The two sources agree where both exist; `origin` leads because it is
    there for every target stat, and `mitigation` only for the three layers that spend
    penetration.
  */
  const read = origin?.final ?? mitigation?.sheet;
  const mods = origin?.mods ?? [];
  const adjustment = adjustmentOf(mitigation, applied);

  return (
    <>
      <SharedStepRow
        depth={2}
        label={<span className="faint">Config base</span>}
        value={`${num(declared, 2)}${sheetUnit}`}
        tone={valueTone(declared, true)}
        title={
          "What the enemy preset, or the Target card, says this mob has before anything you do " +
          "to it — whatever Config is set to, by hand or by a preset."
        }
      />
      {mods.map((mod, i) => (
        <TargetModRow key={`${mod.source}-${i}`} mod={mod} isPerc={sheetUnit === "%"} />
      ))}
      {/* Only worth a row of its own once something has moved it off the declared figure. */}
      {read !== undefined && mods.length > 0 && (
        <SharedStepRow
          depth={2}
          label={<span className="faint">after debuffs</span>}
          value={`${num(read, 2)}${sheetUnit}`}
          tone={valueTone(read, true)}
          title="The mob's own figure, after its affixes and your debuffs and before penetration"
        />
      )}
      {mitigation !== undefined && mitigation.penetration !== 0 && (
        <SharedStepRow
          depth={2}
          label={<span className="faint">Penetration</span>}
          value={signedValue(-mitigation.penetration, sheetUnit === "%")}
          tone={valueTone(-mitigation.penetration, true)}
          title="Your penetration, spent against the figure above"
        />
      )}
      {/*
        The other subtraction, and the one that had nowhere to appear at all.

        Dodge is the mob's evasion *minus your accuracy* — `clamp(dodge - ACCURACY, 0, MAX)` in
        `DodgeRating` — and the panel used to print only the finished percentage. A row reading
        8.37% against a mob with 416 dodge is a number with nothing on screen to derive it from,
        and worse, it hid the stat that moves it: accuracy is the answer to "why am I missing",
        and it was not on this tab anywhere.
      */}
      {mitigation?.accuracy !== undefined && mitigation.accuracy !== 0 && (
        <SharedStepRow
          depth={2}
          label={<span className="faint">Your accuracy</span>}
          value={signedValue(-mitigation.accuracy, sheetUnit === "%")}
          tone={valueTone(-mitigation.accuracy, true)}
          title={
            "`DodgeRating`: the mob's evasion is reduced by your `accuracy` before the curve " +
            "reads it, exactly as penetration is spent against a resistance."
          }
        />
      )}
      {/*
        The rating the curve actually read, where it differs from the subtraction above.

        This is where the column changes units — a rating goes in and a percentage comes out —
        and it is also where the `(int)` cast drops a fraction of a point. Both were invisible:
        armour printed 395.2 and then −15.96 with nothing between them, and dodge printed 416
        and then 8.37.
      */}
      {mitigation?.points !== undefined && !near(mitigation.points, mitigation.afterPenetration) && (
        <SharedStepRow
          depth={2}
          label={<span className="faint">rating the curve read</span>}
          value={`${num(mitigation.points, 0)}${sheetUnit}`}
          tone="faint"
          title={
            "The subtraction above, truncated toward zero the way the game's `(int)` cast " +
            "truncates it. The curve takes an integer rating."
          }
        />
      )}
      {/*
        Whatever the effect did to the subtraction, said out loud on the hits where it did
        anything — which is most of them.

        `ElementalResistEffect` truncates towards zero and then clamps to the element's usable
        range, and both of those routinely move the number: on AMFK the column read
        −16.80 − 33.61 and landed on −50.00, and the missing .41 was one more figure with nothing
        on screen to account for it. Gated on `cap` so only the two resist layers show it —
        armour's gap is a curve, not an adjustment, and its own row says so.
      */}
      {adjustment !== undefined && (
        <SharedStepRow
          depth={2}
          label={<span className="faint">{adjustment.label}</span>}
          value={`${num(adjustment.from, 2)}${sheetUnit} → ${num(applied, 2)}${layerUnit}`}
          tone={adjustment.label === "truncated" ? "faint" : "warn"}
          {...(adjustment.label === "truncated" ? {} : { badge: adjustment.label })}
          title={adjustment.title}
        />
      )}
      <SharedStepRow
        depth={2}
        label={<strong>what the layer applied</strong>}
        value={`${num(applied, 2)}${layerUnit}`}
        tone={valueTone(applied, true)}
        {...(sheetUnit === layerUnit
          ? {}
          : {
              title:
                "A rating, not a percentage: the layer runs the points above through this " +
                "stat's curve, at the attacker's level, and mitigates by what comes out.",
            })}
      />
    </>
  );
}

/**
 * One thing that moved the mob's own figure: a mob affix, or a debuff you put on it.
 *
 * Its own component for the hover. A debuff row names an exile effect and nothing else on the
 * card says what else that effect does — Banner of the Piercing Gale takes 24% of the mob's
 * armour as well as the 16.8 water resistance the row is under — so the card is the answer to
 * the question the row raises. An affix has no such card and stays a plain row.
 */
function TargetModRow({
  mod,
  isPerc,
}: {
  mod: NonNullable<TargetStatOrigin["mods"]>[number];
  isPerc: boolean;
}): ReactNode {
  const world = useWorld();
  const affix = mod.path === "config.enemy.affixes";
  const where = useEffectProvenance(affix ? undefined : mod.source);

  return (
    <SharedStepRow
      depth={2}
      label={
        <span className={affix ? undefined : "has-source"} title={mod.path} {...where.props}>
          {effectLabel(world.snapshot, mod.source)}
          {where.node}
        </span>
      }
      value={modValue(mod, isPerc)}
      tone={valueTone(mod.value, true)}
      badge={affix ? "affix" : "debuff"}
    />
  );
}

/**
 * What the resist effect did to the subtraction, if anything.
 *
 * `undefined` where the subtraction is what the layer read, and on armour, whose `mitigation`
 * carries no clamp because it has none: its rating goes through a curve, which is a different
 * kind of step and gets its own explanation on the row below.
 */
function adjustmentOf(
  mitigation: MitigationDetail | undefined,
  applied: number,
): { label: string; title: string; from: number } | undefined {
  if (mitigation?.cap === undefined || mitigation.min === undefined) return undefined;
  const { afterPenetration, min, cap } = mitigation;
  if (near(afterPenetration, applied)) return undefined;

  if (applied >= cap - 0.005) {
    return {
      from: afterPenetration,
      label: "capped",
      title:
        `Resistance is usable up to ${num(cap, 2)}% — 75, plus this mob's own max-resist stat, ` +
        `clamped to 90. The subtraction came to more than that.`,
    };
  }
  if (applied <= min + 0.005) {
    return {
      from: afterPenetration,
      label: "floored",
      title: `\`ElementalResist.min\` is ${num(min, 0)}, and the subtraction went past it.`,
    };
  }
  return {
    from: afterPenetration,
    label: "truncated",
    title:
      "`ElementalResistEffect` truncates towards zero before it clamps, so the fraction of a " +
      "percentage point is dropped rather than rounded.",
  };
}

/** Two figures that are the same number once the float noise is taken off. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * Which half of a stat a drill-down is explaining.
 *
 * A `MULTIPLICATIVE_DAMAGE` stat reaches the hit **twice**, through two different sections of the
 * card, and the two are fed by disjoint sets of modifiers. `attack_damage` on AMFK is five FLAT
 * modifiers worth +47.52% into `additive_damage`, plus one MORE — Terror, the Guardian
 * ascendancy's `MORE attack_damage 20` — worth ×1.20 under Multipliers. The container keeps the
 * two apart deliberately: a MORE modifier of such a stat never enters `value`, it accumulates
 * into `StatData.m` and is spent once in the damage layer.
 *
 * Both sections used to open into the stat's *whole* modifier list, so Terror appeared under the
 * additive row as well — beside a number it contributed nothing to — and the card read as though
 * one perk were being counted twice.
 */
type SourceKind = "value" | "more";

/**
 * Where a stat on *your* sheet came from: the item, perk, gem or aura behind each modifier.
 *
 * Shared by the layer contributions and the multiplier rows so the two cannot end up answering
 * "where does this come from" differently — but each is shown only the modifiers that fed the
 * number it sits under. See {@link SourceKind}.
 *
 * The **spell unit is asked first**, and that is the correction rather than an optimisation. The
 * damage sweep reads Source-side stats off the per-spell stat container, which is where a support
 * gem's stats live and the only place they live — so asking the character sheet where a skill's
 * `spell_damage` came from answers with the gear and the tree and silently omits the gem that is
 * the whole reason the row moved. The character sheet is the fallback, for a stat the spell unit
 * has never heard of.
 */
function StatSources({
  statId,
  depth,
  kind,
}: {
  statId: string;
  depth: number;
  kind: SourceKind;
}): ReactNode {
  const world = useWorld();
  const derived = useDerived();

  const skill = derived.skillBreakdown(statId);
  const breakdown =
    skill !== undefined && skill.contributions.length > 0 ? skill : derived.breakdown(statId);

  /*
    Whether this stat's numbers are percentages — the stat's own `is_perc`, not the modifier's
    type. It is the reading the Stats tab's trace list already takes, and the game's own stat GUI
    before it. Without it the +2.00 that is two percent of damage and the +2.00 that is two points
    of a rating are the same four characters on adjacent rows, and telling them apart needs
    knowledge of the stat that the row exists to supply.
  */
  const { isPerc, minusIsGood } = statDisplay(world.snapshot, statId);

  const contributions = (breakdown?.contributions ?? []).filter((c) =>
    kind === "more" ? c.type === "MORE" : c.type !== "MORE",
  );

  /*
    Grouped the way the Stats tab groups them, and for a reason the flat list made obvious the
    moment the multiplier rows could be opened: `all_fire_damage` on a finished build is six real
    sources — three jewels, two auras, an enchantment — behind twenty-eight
    `STAT_CTX_MODIFIER_BONUS` entries of a hundredth each. Flat, the answer to "where does this
    come from" was twenty-eight rows of noise with the answer buried in it.
  */
  const groups = groupContributions(contributions);

  return (
    <>
      {/*
        What the sheet says this stat is — the half of it this section is about.

        The two halves are genuinely different numbers and the container keeps them apart on
        purpose, so each is printed where it belongs rather than both in both places:
        `melee_spell_dmg` reads 0.00 on the sheet and ×1.278 in the damage layer, and printing
        the 0.00 under Multipliers made the multiplier look like it came from nowhere.
      */}
      <SharedStepRow
        depth={depth}
        label={<span className="faint">on the sheet</span>}
        value={sheetValue(breakdown, kind, isPerc)}
        tone={valueTone(
          kind === "more" ? breakdown.stat.dmgMulti - 1 : breakdown.stat.value,
          minusIsGood,
        )}
        title={
          kind === "more"
            ? "This stat is MULTIPLICATIVE_DAMAGE: its MORE modifiers are deliberately kept out " +
              "of the value and carried as `StatData.m`, to be spent once in the damage layer. " +
              "That is the multiplier on the row above."
            : "What this stat resolves to, on the sheet the damage sweep read." +
              (breakdown.stat.dmgMulti === 1
                ? ""
                : " Its MORE modifiers are not in it — they are carried separately and spent " +
                  "under Multipliers.")
        }
      />
      {groups.map((group) => (
        <SharedStepRow
          key={group.id}
          depth={depth}
          label={
            <>
              {group.name} <span className="faint">({group.rows.length})</span>
            </>
          }
          value={contributionSubtotal(group.rows, isPerc)}
          tone={valueTone(groupTotal(group.rows), minusIsGood)}
        >
          {() =>
            [...group.rows]
              .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
              .map((mod, modIndex) => (
                <ModifierRow
                  key={`${mod.path}-${mod.source}-${modIndex}`}
                  mod={mod}
                  depth={depth + 1}
                  isPerc={isPerc}
                  minusIsGood={minusIsGood}
                />
              ))
          }
        </SharedStepRow>
      ))}
      {/*
        A stat with nothing under it still shows what it resolved to, because for the multiplier
        half that row *is* the answer: `melee_spell_dmg` gets its ×1.278 from the core-stat pass
        rather than from a modifier, and returning early on an empty list hid the number the
        reader opened the row to see.
      */}
      {groups.length === 0 && (
        <SharedStepRow
          depth={depth}
          label={
            <span className="faint">
              {kind === "more"
                ? "no modifier on the sheet grants it"
                : "nothing on the sheet grants it"}
            </span>
          }
          tone="faint"
          title={
            kind === "more"
              ? `No MORE modifier of \`${statId}\` is on the sheet, so this multiplier was ` +
                `derived rather than granted — a core-stat pass or a transfer. The Stats tab ` +
                `has the full picture.`
              : `\`${statId}\` has no modifier behind it, so it is either a base stat every ` +
                `character has or something the pipeline derived — the Stats tab has the full ` +
                `picture.`
          }
        />
      )}
    </>
  );
}

/**
 * The bottom of the drill-down: one modifier, and the thing in your build that granted it.
 *
 * This is where the chain finally stops being a number and becomes an object you own, and until
 * now it stopped one step short of saying so: `sourceName` gives "Sword" or "Attack Damage", and
 * on a build wearing two swords, or holding four grid positions of one perk, that names the kind
 * and not the thing. `useProvenance` reads the document path the collector left on the modifier
 * and puts the item, the jewel, the gem or the tree node itself under the pointer. See
 * `ui/mod-source.ts`.
 *
 * The id pair stays on the `title` for the rows that have no card — base stats, the level's
 * resist grant, context modifiers — because when a name looks wrong the id is what you need.
 *
 * `originPart` is the other half of the same answer and this row was dropping it, though the
 * sidebar's breakdown has printed it all along: which affix of the item, which vanilla
 * attribute the compat entry converted, which context a `Context modifiers` row took a share
 * of. That is what left "Vanilla attributes +2.00" and "Context modifiers ×1.338" on screen
 * with nothing to say for themselves.
 */
function ModifierRow({
  mod,
  depth,
  isPerc,
  minusIsGood,
}: {
  mod: ModContribution;
  depth: number;
  isPerc: boolean;
  minusIsGood: boolean;
}): ReactNode {
  const world = useWorld();
  const where = useProvenance(mod);
  const part = originPart(world.snapshot, mod);

  return (
    <SharedStepRow
      depth={depth}
      label={
        <span
          className={where.has ? "has-source" : undefined}
          title={where.has ? undefined : `${mod.ctxType} ${mod.source}\n${mod.path}`}
          {...where.props}
        >
          {sourceName(world.snapshot, mod)}
          {part !== undefined && <span className="faint"> — {part}</span>}
          {where.node}
        </span>
      }
      value={modValue(mod, isPerc)}
      tone={valueTone(mod.value, minusIsGood)}
    />
  );
}

/**
 * Which way a group of modifiers pushed the stat, for colouring its subtotal.
 *
 * The sum of the raw values rather than of what {@link contributionSubtotal} prints, because that
 * function words the total and a word has no sign. A group that both gives and takes — a unique
 * with an upside and a downside under one heading — is coloured by where it lands, which is the
 * only reading that matches the number beside it.
 */
function groupTotal(rows: readonly { value: number }[]): number {
  return rows.reduce((sum, row) => sum + row.value, 0);
}

/**
 * The stat's own reading, in the terms the container keeps it in, for the half being explained.
 *
 * A `MULTIPLICATIVE_DAMAGE` stat has two readings and they are not two views of one number:
 * `value` is what the additive layer read, `dmgMulti` is what the MORE step spent. Printing both
 * on both rows is what made one perk look like it was being counted twice.
 */
function sheetValue(
  breakdown: { stat: { value: number; dmgMulti: number } },
  kind: SourceKind,
  isPerc: boolean,
): string {
  if (kind === "more") return `×${num(breakdown.stat.dmgMulti, 3)}`;
  return signedValue(breakdown.stat.value, isPerc);
}

/**
 * One modifier, written the way the term it feeds is written.
 *
 * A MORE modifier is stored as the percentage the game's own JSON declares — Terror is
 * `{"type": "MORE", "stat": "attack_damage", "v1": 20}` — and the container spends it as
 * `multi *= 1 + v / 100`. Printing the stored number behind an `x` produced `x20.00` beside a
 * row that said ×1.200, which is the same modifier written two incompatible ways.
 */
function modValue(mod: { type: "FLAT" | "PERCENT" | "MORE"; value: number }, isPerc: boolean): string {
  if (mod.type === "MORE") return `×${num(1 + mod.value / 100, 3)}`;
  // A PERCENT modifier is a percentage *of the stat*, so it carries its own `%` whatever the
  // stat's unit is; a FLAT one is in the stat's own unit, which is what `isPerc` answers.
  return signedValue(mod.value, isPerc || mod.type === "PERCENT");
}

/** `+2.00`, or `+2.00%` where the stat is one the game prints as a percentage. */
function signedValue(value: number, isPerc: boolean): string {
  return `${value >= 0 ? "+" : ""}${num(value, 2)}${isPerc ? "%" : ""}`;
}

/** An exile effect's display name, falling back to the raw id. */
function effectLabel(snapshot: Snapshot, id: string): string {
  return exileEffectName(snapshot, id) || id;
}
