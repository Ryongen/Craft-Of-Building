/**
 * What it takes to kill you.
 *
 * The same question the Damage tab asks about a mob, asked about you: a hit comes in, the fourteen
 * layers chew on it, and what is left comes off your pools. So this runs the *same* sweep with the
 * sheets swapped rather than a second mitigation model, and every row can be taken apart into the
 * stats that produced it.
 *
 * Per element, because a character is never equally soft everywhere and the number that matters is
 * the smallest one. Chaos usually is: this pack starts you on a chaos resist penalty, and half of
 * a chaos hit walks past your magic shield.
 */

import type { Defence, ElementDefence, LayerStep, Resources } from "@cte2/engine";
import { useMemo, type ReactNode } from "react";

import { statName, statLayerName } from "@cte2/schema";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, num, smart } from "../../ui/fields.js";
import { Figure } from "../../ui/Figure.js";
import { Panel, setAllPanels } from "../../ui/Panel.js";
import { elementColour, elementLabel } from "../../ui/palette.js";
import { useDetailPane } from "../stats/DetailPane.js";
import type { SheetFocus } from "../stats/SheetDetail.js";
import { TraceStatList, defenceStats } from "../stats/TraceStats.js";

/**
 * Every folding card on this tab, for the two buttons in the header.
 *
 * A literal list rather than something collected at render, so "collapse all" reaches the cards a
 * particular build does not currently show.
 */
const DEFENCE_PANELS = [
  "defence.elements",
  "defence.regen",
  "defence.layers",
  "defence.layers-unavoided",
  "defence.stats",
] as const;

export function DefencePanel(): ReactNode {
  const derived = useDerived();
  const { defence, resources } = derived;
  const detail = useDetailPane(340);

  /**
   * The stats that measurably changed an incoming hit, across all five elements.
   *
   * Off the defence pass's own layer steps rather than a curated list, so it is exactly the stats
   * the mitigation read — `fire_resist` is here because a layer used it, and a resist the build
   * has none of is not. The unavoided sweep is included because dodge and block only appear in
   * the averaged one, and they are the whole subject of the Maximum hit card.
   */
  const stats = useMemo(
    () =>
      defenceStats([
        ...defence.byElement.map((e) => e.steps),
        ...defence.byElement.map((e) => e.unavoidedSteps),
      ]),
    [defence],
  );

  const luck =
    defence.mostFragile.takenUnavoided > 0
      ? 1 - defence.mostFragile.taken / defence.mostFragile.takenUnavoided
      : 0;

  return (
    <div className="panel damage-panel">
      <div className="calcs-body">
        <PoolsCard defence={defence} onCollapseAll={() => setAllPanels(DEFENCE_PANELS, false)} onExpandAll={() => setAllPanels(DEFENCE_PANELS, true)} />

        <div className="card-columns">
          <Panel
            id="defence.elements"
            title="Per element"
            summary={`softest to ${elementLabel(defence.weakest.element)} · one-shot by ${smart(defence.mostFragile.maximumHit)} ${elementLabel(defence.mostFragile.element)}`}
          >
            <ElementTable defence={defence} onSelect={detail.open} />
          </Panel>

          <Panel
            id="defence.regen"
            title="Regeneration"
            summary="one tick a second"
            defaultOpen={false}
          >
            <RegenTable resources={resources} />
          </Panel>

          <Panel
            id="defence.layers"
            title={`${elementLabel(defence.weakest.element)} hit, layer by layer`}
            summary={`${num((1 - defence.weakest.taken) * 100, 1)}% stopped, averaged`}
          >
            <Breakdown entry={defence.weakest} steps={defence.weakest.steps} />
          </Panel>

          {/* Only worth its own card when the two sweeps differ — for a build with no dodge and
              no block it would be the card above, printed twice. */}
          {luck > 0.005 && (
            <Panel
              id="defence.layers-unavoided"
              title={`${elementLabel(defence.mostFragile.element)} hit, avoidance failed`}
              summary={`${num((1 - defence.mostFragile.takenUnavoided) * 100, 1)}% stopped`}
            >
              <Breakdown
                entry={defence.mostFragile}
                steps={defence.mostFragile.unavoidedSteps}
              />
              <div className="muted text-sm mt-4 prose">
                The same sweep with every dodge and block roll assumed to fail, which is what the
                Maximum hit figure is measured through. Compare it against the averaged card:
                whatever is missing here is the part of your mitigation that is a dice roll.
              </div>
            </Panel>
          )}

          <Panel id="defence.stats" title="Stats behind your effective HP" summary={`${stats.length} stats`}>
            <TraceStatList
              statIds={stats}
              scope="character"
              selected={detail.focus}
              onSelect={detail.open}
              empty="Nothing in this build modified an incoming hit."
            />
          </Panel>
        </div>
      </div>

      {detail.pane}
    </div>
  );
}

/**
 * What refills, and how fast.
 *
 * One restore event a second, and three kinds of stat feed it: `<r>_regen` flat, `<r>_per_sec` as
 * a share of the pool, and the `on_restore_resource` percents that multiply both. Blood is the odd
 * one — it has no tick at all, and lives off whatever `hp_resto_to_blood` redirects out of your
 * health regeneration, which is what makes the Blood Magic game changer a sustain question rather
 * than a cosmetic one.
 */
function RegenTable({ resources }: { resources: Resources }): ReactNode {
  const fights = resources.byResource.some(
    (entry) => Math.abs(entry.inCombatPerSecond - entry.perSecond) > 1e-6,
  );

  return (
    <div className="card">
      <div className="row wrap gap-7 mb-4" style={{ alignItems: "baseline" }}>
        <span className="card-title">
          Regeneration
        </span>
        <span className="faint text-sm">
          one tick a second
        </span>
        {resources.bloodMage && (
          <span className="badge warn" title="`blood_user` is on: every mana cost is paid from blood">
            blood magic
          </span>
        )}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Pool</th>
            <th className="num">Max</th>
            <th className="num">Flat</th>
            <th className="num">% of max</th>
            <th className="num">Resting</th>
            <th className="num">In combat</th>
            <th className="num">Full in</th>
          </tr>
        </thead>
        <tbody>
          {resources.byResource.map((entry) => (
            <tr key={entry.resource}>
              <td title={entry.note}>
                {entry.resource.replace(/_/g, " ")}
                {entry.note !== undefined && <span className="faint"> *</span>}
              </td>
              <td className="num">{smart(entry.max)}</td>
              <td className="num">{entry.flat === 0 ? "—" : smart(entry.flat)}</td>
              <td className="num">
                {entry.fromPercentOfMax === 0 ? "—" : smart(entry.fromPercentOfMax)}
              </td>
              <td className="num">{smart(entry.perSecond)}</td>
              <td
                className="num"
                style={{
                  color:
                    entry.inCombatPerSecond < entry.perSecond - 1e-6 ? "var(--warn)" : undefined,
                }}
              >
                {smart(entry.inCombatPerSecond)}
              </td>
              <td className="num">
                {entry.secondsToFull === undefined ? "—" : `${num(entry.secondsToFull, 1)}s`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="faint text-sm mt-4" style={{ maxWidth: 760 }}>
        <code>in_combat</code> is a ten-second cooldown that every hit you land or take
        re-stamps, so a rotation never leaves it — the in-combat column is the one that has to pay
        for your casts, and it is the one the Damage tab&apos;s Sustain card uses.{" "}
        {fights ? (
          <>
            The two differ here because{" "}
            {resources.inCombatRegenMulti === 1 ? (
              <>something in this build is gated on the combat state</>
            ) : (
              <>
                <code>in_combat_regen_multi</code> is{" "}
                <code>{resources.inCombatRegenMulti}</code> (Config &rarr; Server), energy exempt
              </>
            )}
            .
          </>
        ) : (
          <>
            They agree here: <code>in_combat_regen_multi</code> is{" "}
            <code>{resources.inCombatRegenMulti}</code>, which is what this pack ships (the mod&apos;s
            own default is 0.5 — Config &rarr; Server if your server changed it), and nothing in
            this build is gated on being out of combat.
          </>
        )}
      </div>

      {resources.byResource
        .filter((entry) => entry.note !== undefined)
        .map((entry) => (
          <div key={entry.resource} className="faint text-sm mt-4">
            <strong>{entry.resource.replace(/_/g, " ")}:</strong> {entry.note}
          </div>
        ))}
    </div>
  );
}

function PoolsCard({
  defence,
  onCollapseAll,
  onExpandAll,
}: {
  defence: Defence;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setEnemyLevel = useBuild((s) => s.setEnemyLevel);
  const { pools, weakest } = defence;

  return (
    <div className="card">
      <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
        <Figure
          size="lg"
          label="Effective HP"
          value={smart(weakest.effectiveHealth)}
          hint={`Against ${elementLabel(weakest.element)}, the element you are softest to. Raw incoming damage, before your mitigation touches it.`}
        />
        <Figure size="lg" label="Health" value={smart(pools.health)} hint="The Mine and Slash pool, not vanilla hearts" />
        {pools.magicShield > 0 && (
          <Figure
            size="lg"
            label="Magic shield"
            value={smart(pools.magicShield)}
            hint="Absorbs before health. Half of a chaos hit walks past it unless chaos_doesnt_bypass_magic_shield is on"
          />
        )}
        {/*
          The other headline, beside the one it is usually mistaken for.

          Effective HP has dodge and block folded in as expectation; this is the same pools
          through mitigation alone. A build whose two figures differ is one carrying part of its
          defence on a roll, and that is a thing to be told rather than to work out.
        */}
        <Figure
          size="lg"
          label="Maximum hit"
          value={smart(defence.mostFragile.maximumHit)}
          hint={`The largest single ${elementLabel(defence.mostFragile.element)} hit you survive from full, with every dodge and block roll assumed to fail. Mitigation still applies; avoidance does not, because you cannot spend a chance on one particular hit.`}
        />
        <Figure
          size="lg"
          label="Weakest to"
          value={elementLabel(weakest.element)}
          hint={`${num(weakest.taken * 100, 1)}% of a ${elementLabel(weakest.element)} hit reaches your pools`}
        />
        <div className="grow" />
        <div className="row gap-2" style={{ alignSelf: "center" }}>
          <button onClick={onCollapseAll}>Collapse all</button>
          <button onClick={onExpandAll}>Expand all</button>
        </div>
      </div>

      <div className="row wrap gap-8 mt-5">
        <label className="field">
          <span className="faint text-sm">
            attacker level
          </span>
          <NumberField
            value={doc.config?.enemy?.level ?? doc.config?.enemyLevel ?? doc.character.level}
            min={1}
            width={64}
            onChange={(value) => value !== undefined && setEnemyLevel(value)}
          />
        </label>
        <span className="faint text-sm" style={{ maxWidth: 620 }}>
          Armour and dodge are curves read at the <em>attacker&apos;s</em> level, so who is hitting
          you changes what your armour is worth. Reference hit: {smart(defence.hitSize)} — it only
          matters for flat mitigation, which is worth less against a bigger hit.
        </span>
      </div>

      {pools.manaAbsorb.percent > 0 && (
        <div className="faint text-sm mt-4">
          <strong>Not counted above:</strong> mana absorbs {num(pools.manaAbsorb.percent, 1)}% of
          every hit, but only while it is above half full — a buffer of{" "}
          {smart(pools.manaAbsorb.buffer)}, not a pool. How full it is when a hit lands depends on
          regeneration between hits, which a build document does not state.
        </div>
      )}
    </div>
  );
}

/**
 * The five elements, with both survival figures side by side.
 *
 * Effective HP and the maximum hit are one table rather than two because the comparison is the
 * point: a row where they differ is a row whose defence is partly a dice roll, and a reader has
 * to be able to see which rows those are without holding two screens in their head.
 */
function ElementTable({
  defence,
  onSelect,
}: {
  defence: Defence;
  onSelect: (focus: SheetFocus) => void;
}): ReactNode {
  // A hit that arrives as more than one element, anywhere. See `ArrivesAs`.
  const converts = defence.byElement.some((entry) => entry.arrivesAs.length > 1);

  return (
    <div className="card">
      <table className="grid">
        <thead>
          <tr>
            <th>Element</th>
            {/* Only where something actually converts. Against a bare mob every row reads "100%
                of itself", which is a column of noise for the common case. */}
            {converts && (
              <th title="What the hit is made of by the time it reaches your pools. A mob affix that converts its damage — Fire Lord, Full Chaos — changes what the row above is defended by without changing which row it is.">
                Arrives as
              </th>
            )}
            <th className="num">Pool</th>
            <th className="num" title="Share of a raw hit that reaches your pools, with dodge and block averaged in">
              Taken
            </th>
            <th className="num" title="Pool divided by Taken: raw damage survived per hit on average">
              Effective HP
            </th>
            <th className="num" title="The same with every avoidance roll assumed to fail — the largest single hit you survive">
              Maximum hit
            </th>
          </tr>
        </thead>
        <tbody>
          {defence.byElement.map((entry) => {
            const luck =
              entry.takenUnavoided > 0 ? 1 - entry.taken / entry.takenUnavoided : 0;
            return (
              <tr
                key={entry.element}
                className={entry === defence.weakest ? "highlight" : undefined}
              >
                <td style={{ color: elementColour(entry.element) }}>{elementLabel(entry.element)}</td>
                {converts && (
                  <td>
                    <ArrivesAs entry={entry} />
                  </td>
                )}
                <td className="num">{smart(entry.pool)}</td>
                <td className="num">{num(entry.taken * 100, 1)}%</td>
                <td className="num link-ish" onClick={() => onSelect({ kind: "ehp", element: entry.element })}>
                  {smart(entry.effectiveHealth)}
                </td>
                {/* Marked where it is materially below the averaged figure, because that gap is
                    the finding — a comfortable effective HP over a maximum hit half its size is
                    a build that dies to one unlucky slam. */}
                <td
                  className="num link-ish"
                  style={luck > 0.05 ? { color: "var(--warn)" } : undefined}
                  title={
                    luck > 0.005
                      ? `${num(luck * 100, 0)}% of your mitigation here is a dodge or block roll, which this figure does not count.`
                      : "Nothing avoids hits here, so this is the same as your effective HP."
                  }
                  onClick={() => onSelect({ kind: "max-hit", element: entry.element })}
                >
                  {smart(entry.maximumHit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted text-sm mt-3 prose">
        Click either figure for the pools and the mitigation behind it. Rows are highlighted on the
        element you are softest to on average; the Maximum hit column turns amber where avoidance is
        carrying more than 5% of your mitigation, because none of it applies to a single hit.
      </div>
      {converts && (
        <div className="muted text-sm mt-3 prose">
          <strong>A row is named for what the attacker swings, not for what lands.</strong>{" "}
          Conversion happens after the hit leaves the mob, so an affix like <code>fire_lord</code>{" "}
          &mdash; <code>phys_to_fire 75</code> and <code>plus_phys_to_fire 50</code> &mdash; makes a
          raw <em>physical</em> hit arrive mostly as fire. That is why it moves the Physical row and
          leaves the Fire row exactly where it was: a hit that started as fire is not something
          <code> phys_to_fire</code> has anything to say about. The Arrives as column is which of
          your resists is doing the work in each row.
        </div>
      )}
      <AttackerNote defence={defence} />
    </div>
  );
}

/**
 * The elements one row's hit actually reaches the pools as.
 *
 * Suppressed at a single entry, because "Physical: 100% Physical" is a cell that costs a column
 * and says nothing. A share below half a percent is dropped for the same reason — a conversion
 * that survived its own mitigation by a rounding error is not a thing to plan around.
 */
function ArrivesAs({ entry }: { entry: ElementDefence }): ReactNode {
  const parts = entry.arrivesAs.filter((part) => part.share >= 0.005);
  if (parts.length <= 1) return <span className="faint">&mdash;</span>;

  return (
    <span
      title={
        `A raw ${elementLabel(entry.element)} hit reaches your pools as ` +
        parts.map((p) => `${num(p.share * 100, 1)}% ${elementLabel(p.element)}`).join(", ") +
        `. Those are shares of what got through, so the resist that already stopped its share is ` +
        `not in them.`
      }
    >
      {parts.map((part, at) => (
        <span key={part.element} style={{ color: elementColour(part.element) }}>
          {at > 0 ? " · " : ""}
          {num(part.share * 100, 0)}% {elementLabel(part.element)}
        </span>
      ))}
    </span>
  );
}

/** Who is hitting you, since that half decides what your resists are actually worth. */
function AttackerNote({ defence }: { defence: Defence }): ReactNode {
  const doc = useBuild((s) => s.doc);
  const offence = doc.config?.enemy?.offence;
  const pierces = Object.entries(offence?.penetration ?? {}).filter(([, v]) => v > 0);
  const preset = doc.config?.targetPreset;

  return (
    <div className="faint text-sm mt-4">
      Measured against a level {defence.attackerLevel} attacker
      {offence === undefined ? (
        <> with no stats of its own — pick a target preset in Config to give it MnS&apos;s.</>
      ) : (
        <>
          {" "}
          with {num(offence.accuracy ?? 0, 1)} accuracy
          {offence.armorPenetration ? `, ${num(offence.armorPenetration, 1)} armour penetration` : ""}
          {pierces.length > 0
            ? `, and ${pierces.map(([e, v]) => `${num(v, 1)} ${e}`).join(", ")} penetration`
            : " and no penetration"}
          {preset === undefined ? "" : ` (${preset})`}. Mine and Slash gives a mob accuracy and
          nothing else offensive, so a penetrating mob is one carrying a map affix — state it in
          the enemy block.
        </>
      )}{" "}
      Crit and the attacker&apos;s damage increases are not in these numbers: they make the hit
      bigger rather than your mitigation worse.
    </div>
  );
}

/** Layer by layer for the element that kills you, since that is the one worth fixing. */
function Breakdown({
  entry,
  steps,
}: {
  entry: ElementDefence;
  /** Either sweep's rows: the averaged one, or the one with avoidance switched off. */
  steps: readonly LayerStep[];
}): ReactNode {
  const world = useWorld();
  if (steps.length === 0) {
    return (
      <div className="muted text-sm prose">Nothing modified a {elementLabel(entry.element)} hit.</div>
    );
  }

  return (
    <div className="card">
      <table className="grid">
        <thead>
          <tr>
            <th>Layer</th>
            <th className="num">Multiplier</th>
            <th className="num">Damage</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step, i) => (
            <tr key={`${step.layerId}-${i}`}>
              {/* The layer's own name from the pack, rather than its id with the underscores
                  taken out — `damage_reduction` reads as "Damage Reduction" either way, but
                  `ele_as_extra_flat` does not. */}
              <td title={step.layerId}>{statLayerName(world.snapshot, step.layerId)}</td>
              <td className="num">
                {step.multiplier === undefined ? "—" : `x${num(step.multiplier, 3)}`}
              </td>
              <td className="num">
                {smart(step.before)} → {smart(step.after)}
              </td>
              {/* Named rather than comma-joined ids: "Armour +120, Physical Resist +15" is a
                  sentence a player can check against their gear, and `armor +120` is not. The
                  ids stay on the hover for when a name is ambiguous. */}
              <td className="faint" title={step.contributions.map((c) => c.statId).join(", ")}>
                {step.contributions
                  .map(
                    (c) =>
                      `${statName(world.snapshot, c.statId)} ${c.value > 0 ? "+" : ""}${num(c.value, 1)}`,
                  )
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
