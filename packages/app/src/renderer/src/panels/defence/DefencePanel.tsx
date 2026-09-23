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

import type {
  Defence,
  DpsResult,
  ElementDefence,
  LayerStep,
  OverTime,
  Resources,
  SelfSustain,
} from "@cte2/engine";
import { useMemo, type ReactNode } from "react";

import { spellName, statName } from "@cte2/schema";
import { layerLabel } from "../../ui/trace-format.js";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useTechnical } from "../../ui/detail-mode.js";
import { useWorld } from "../../state/snapshot.js";
import { Plain, Tech, resolveHint } from "../../ui/copy/hint.js";
import { DEFENCE_COPY } from "../../ui/copy/defence.js";
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
  "defence.self",
  "defence.layers",
  "defence.layers-unavoided",
  "defence.over-time",
  "defence.when-hit",
  "defence.stats",
] as const;

export function DefencePanel(): ReactNode {
  const derived = useDerived();
  const { defence, resources, dps, selfSustain } = derived;
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

          {/*
            How long you last, rather than how big a hit you survive.

            Always rendered, never hidden: the empty state is the whole point. A card that simply
            vanished when no attacker was stated would be indistinguishable from a build that has
            nothing to show, and the two are very different answers. Open by default when the
            drain is not covered, for the same reason Your own damage is.
          */}
          <Panel
            id="defence.over-time"
            title="Under attack"
            tone={
              defence.overTime === undefined
                ? undefined
                : defence.overTime.deadliest.sustain.sustainable
                  ? undefined
                  : "warn"
            }
            summary={
              defence.overTime === undefined
                ? "no attacker stated"
                : defence.overTime.deadliest.sustain.sustainable
                  ? "you out-regenerate it"
                  : `dead in ${smart(defence.overTime.deadliest.sustain.secondsToDeath)}s to ${elementLabel(defence.overTime.deadliest.element)}`
            }
            defaultOpen={
              defence.overTime !== undefined && !defence.overTime.deadliest.sustain.sustainable
            }
          >
            <OverTimeCard overTime={defence.overTime} />
          </Panel>

          {/*
            What an incoming hit sets off. Same empty-state rule as above.
          */}
          {defence.overTime !== undefined &&
            (defence.overTime.procs.length > 0 ||
              defence.overTime.ailments.length > 0 ||
              defence.overTime.restoresPerSecond.length > 0) && (
            <Panel
              id="defence.when-hit"
              title="When you are hit"
              summary={[
                defence.overTime.procs.length > 0
                  ? `${defence.overTime.procs.length} proc${defence.overTime.procs.length === 1 ? "" : "s"}`
                  : undefined,
                defence.overTime.ailments.length > 0
                  ? `${defence.overTime.ailments.length} ailment${defence.overTime.ailments.length === 1 ? "" : "s"} on you`
                  : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(" · ")}
              defaultOpen={false}
            >
              <WhenHitCard overTime={defence.overTime} />
            </Panel>
          )}

          {/*
            The damage this build does to itself, which is a defensive question and was only ever
            asked on the Damage tab.

            Present only when there is any — four auras and ten spells — and open by default when
            the build cannot cover it, because a drain your regeneration does not meet is the
            single most important thing on this tab for the character it applies to.
          */}
          {dps?.selfDamage !== undefined && selfSustain !== undefined && (
            <Panel
              id="defence.self"
              title="Your own damage"
              tone={selfSustain.sustainable ? undefined : "warn"}
              summary={
                selfSustain.sustainable
                  ? `${smart(selfSustain.drainPerSecond)}/s, covered`
                  : `${smart(selfSustain.netLossPerSecond)}/s more than you regenerate`
              }
              defaultOpen={!selfSustain.sustainable}
            >
              <SelfDamageSustain
                sustain={selfSustain}
                self={dps.selfDamage}
                spellId={dps.spellId}
                onSelect={detail.open}
              />
            </Panel>
          )}

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
 * Your own skill’s damage, set against the regenerations that have to pay for it.
 *
 * The order is the game’s and it is the whole point of the table: `MagicShield` absorbs before
 * health does, so magic shield regeneration pays first and health regeneration only ever sees
 * the overflow. Adding the two together would call a build fine that is quietly losing health
 * every second because its shield regeneration is already saturated.
 *
 * The failure mode is usually not death. Holy Fire, Sanguine, Abyss and Plague each carry a
 * `remove_<id>_when_very_low` stat whose gate is `is_target_very_low` — 25% of health *and*
 * magic shield combined — so a build that cannot sustain the drain loses the aura rather than
 * the character, and the row says which.
 */
function SelfDamageSustain({
  sustain,
  self,
  spellId,
  onSelect,
}: {
  sustain: SelfSustain;
  self: NonNullable<DpsResult["selfDamage"]>;
  spellId: string;
  onSelect: (focus: SheetFocus) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const [technical] = useTechnical();

  return (
    <>
      <div className="row wrap gap-7 mb-4" style={{ alignItems: "baseline" }}>
        <span className={sustain.sustainable ? "badge" : "badge warn"}>
          {sustain.sustainable
            ? `covered, ${smart(sustain.drainPerSecond)}/s`
            : `−${smart(sustain.netLossPerSecond)}/s net`}
        </span>
        <span className="badge mono" title={resolveHint(DEFENCE_COPY.selfDamageUnavoidable, technical)}>
          no dodge or block
        </span>
        <span className="badge mono" title={resolveHint(DEFENCE_COPY.selfDamageCannotCrit, technical)}>
          cannot crit
        </span>
      </div>

      <table className="grid">
        <tbody>
          <tr>
            <td>Raw, per cast</td>
            <td className="num">{smart(self.rawPerCast)}</td>
            <td className="faint text-sm">
              {spellName(snapshot, spellId)}&apos;s own value calculation, untouched.
            </td>
          </tr>
          <tr>
            <td>Your mitigation takes</td>
            <td className="num">{num(self.mitigated * 100, 1)}%</td>
            <>
            <Plain>
              <td className="faint text-sm">
                Armour, resistances, and reduced damage taken. Increases to damage and critical strikes do not apply to hits you inflict on yourself, but your mitigation stats still protect you.
              </td>
            </Plain>
            <Tech>
              <td className="faint text-sm">
                Armour, resists and <code>dmg_received</code>. Increases to damage and crit do not
                apply to a hit you inflict on yourself; mitigation does.
              </td>
            </Tech>
            </>
          </tr>
          <tr>
            <td>
              <strong>You take</strong>
            </td>
            <td className="num">
              <strong>{smart(sustain.drainPerSecond)}/s</strong>
            </td>
            <td className="faint text-sm">{smart(self.perCast)} per cast, at your cast rate.</td>
          </tr>
          <tr>
            <td>Magic shield regeneration pays</td>
            <td className="num">{smart(sustain.fromShieldRegen)}/s</td>
            <td className="faint text-sm">
              First, because the shield is hit first.{" "}
              {sustain.fromShieldRegen === 0 &&
                "Nothing here: this build has no magic shield for the stat to refill."}
            </td>
          </tr>
          <tr>
            <td>Reaching health</td>
            <td className="num">{smart(sustain.reachingHealth)}/s</td>
            <td className="faint text-sm">What the shield&apos;s regeneration could not cover.</td>
          </tr>
          <tr>
            <td>Health regeneration pays</td>
            <td className="num">{smart(sustain.fromHealthRegen)}/s</td>
            <td className="faint text-sm">In combat, which is when this is happening.</td>
          </tr>
          <tr>
            <td>
              <strong>Net</strong>
            </td>
            <td className={`num${sustain.sustainable ? "" : " bad"}`}>
              <strong>
                {sustain.sustainable ? "covered" : `−${smart(sustain.netLossPerSecond)}/s`}
              </strong>
            </td>
            <td className="faint text-sm">
              {sustain.sustainable
                ? "You can hold this indefinitely."
                : sustain.secondsToCutoff === undefined
                  ? `Dead in ${num(sustain.secondsToDeath, 1)}s from full.`
                  : `The effect takes itself off after ${num(sustain.secondsToCutoff, 1)}s rather ` +
                    `than killing you — it would otherwise be ${num(sustain.secondsToDeath, 1)}s.`}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="faint text-sm mt-3 prose">
        Not netted off your DPS, and your DPS is not netted off it: what you deal and what you pay
        are different questions. Click{" "}
        <button className="link" onClick={() => onSelect({ kind: "figure", id: "self-damage" })}>
          the arithmetic
        </button>{" "}
        for the same rows with every stat behind them.
      </div>
    </>
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
  const [technical] = useTechnical();
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
          <span className="badge warn" title={resolveHint(DEFENCE_COPY.bloodMage, technical)}>
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
        <Plain>
          You count as in combat for ten seconds after every hit you land or take, so a rotation
          never leaves it, the in-combat column is the one that has to pay for your casts, and it
          is the one the Damage tab&apos;s Sustain card uses.{" "}
        </Plain>
        <Tech>
          <code>in_combat</code> is a ten-second cooldown that every hit you land or take
          re-stamps, so a rotation never leaves it, the in-combat column is the one that has to pay
          for your casts, and it is the one the Damage tab&apos;s Sustain card uses.{" "}
        </Tech>
        {fights ? (
          <>
            The two differ here because{" "}
            {resources.inCombatRegenMulti === 1 ? (
              <>something in this build is gated on the combat state</>
            ) : (
              <>
                <Plain>
                  the in-combat regeneration multiplier is {resources.inCombatRegenMulti} (Config
                  &rarr; Server), and energy is exempt from it
                </Plain>
                <Tech>
                  <code>in_combat_regen_multi</code> is{" "}
                  <code>{resources.inCombatRegenMulti}</code> (Config &rarr; Server), energy exempt
                </Tech>
              </>
            )}
            .
          </>
        ) : (
          <>
            <Plain>
              Nothing in this
              build needs you to be out of combat (except Mercenary respawn).
            </Plain>
            <Tech>
              They agree here: <code>in_combat_regen_multi</code> is{" "}
              <code>{resources.inCombatRegenMulti}</code>, which is what this pack ships (the mod&apos;s
              own default is 0.5 — Config &rarr; Server if your server changed it), and nothing in
              this build is gated on being out of combat.
            </Tech>
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
            hint={DEFENCE_COPY.magicShield}
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
          color={elementColour(weakest.element)}
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
        <>
        <Plain>
          <div className="muted text-sm mt-3 prose">
            Each row is named for what the attacker swings, not what actually lands. Damage conversion happens after a hit leaves the mob, so an affix like Fire Lord (converting 75% physical to fire and adding 50% extra physical as fire)causes a raw physical hit to arrive mostly as fire. That shifts the Physical row while leaving the Fire row unchanged, as damage starting as fire is unaffected by physical conversion. The Arrives As column shows which of your resistances mitigates damage in each row.
          </div>
        </Plain>
        <Tech>
          <div className="muted text-sm mt-3 prose">
            <strong>A row is named for what the attacker swings, not for what lands.</strong>{" "}
            Conversion happens after the hit leaves the mob, so an affix like <code>fire_lord</code>{" "}
            &mdash; <code>phys_to_fire 75</code> and <code>plus_phys_to_fire 50</code> &mdash; makes a
            raw <em>physical</em> hit arrive mostly as fire. That is why it moves the Physical row and
            leaves the Fire row exactly where it was: a hit that started as fire is not something
            <code> phys_to_fire</code> has anything to say about. The Arrives as column is which of
            your resists is doing the work in each row.
          </div>
        </Tech>
        </>
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
        <> with no stats of its own, pick a target preset in Config to give it MnS&apos;s.</>
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
  const [technical] = useTechnical();
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
                  `ele_as_extra_flat` does not. Through `layerLabel` because three of those names
                  are templates: this table printed "%1$s to %2$s Conversion" verbatim. */}
              <td title={step.layerId}>{layerLabel(world.snapshot, step, entry.element)}</td>
              <td className="num">
                {step.multiplier === undefined ? "—" : `x${num(step.multiplier, 3)}`}
              </td>
              <td className="num">
                {smart(step.before)} → {smart(step.after)}
              </td>
              {/* Named rather than comma-joined ids: "Armour +120, Physical Resist +15" is a
                  sentence a player can check against their gear, and `armor +120` is not. The
                  ids stay on the hover for when a name is ambiguous. */}
              <td
                className="faint"
                title={
                  technical ? step.contributions.map((c) => c.statId).join(", ") : undefined
                }
              >
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


/**
 * How long you last under the stated attacker, per element.
 *
 * The empty state is deliberately a paragraph rather than a blank: "no attacker stated" and "you
 * take no damage" are very different answers, and a card that showed nothing would conflate them.
 * It names the two fields and where they live, because the fix is one click away and a reader who
 * does not know that will read the blank as a limitation of the tool.
 */
function OverTimeCard({ overTime }: { overTime: OverTime | undefined }): ReactNode {
  if (overTime === undefined) {
    return (
      <div className="card">
        <>
          <Plain>
            <p className="faint">
              Nothing here says how long you survive, because this build does not say what it is
              fighting. The figures above answer the other question — the biggest single hit you
              could take from full.
            </p>
          </Plain>
          <Tech>
            <p className="faint">
              <code>config.enemy.offence</code> states neither <code>vanillaAttackDamage</code> nor{" "}
              <code>attacksPerSecond</code>, and neither is derivable:{" "}
              <code>mmorpg_entity</code> carries <code>dmg_multi</code> and no attack damage, and{" "}
              <code>MobStatUtils.getMobBaseStats</code> gives a mob one line of offence, which is
              accuracy.
            </p>
          </Tech>
        </>
        <p className="faint text-sm">
          Set the enemy&rsquo;s attack damage and how often it swings on the Config tab — an
          attacker profile fills both in one click.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row gap-8 wrap">
        <Figure label="Raw per hit" value={smart(overTime.rawPerHit)} />
        <Figure label="Swings / sec" value={num(overTime.ratePerSecond, 2)} />
        {overTime.manaAbsorbSeconds !== undefined && (
          <Figure
            label="Mana buffer"
            value={
              Number.isFinite(overTime.manaAbsorbSeconds)
                ? `${smart(overTime.manaAbsorbSeconds)}s`
                : "holds"
            }
          />
        )}
      </div>

      <table className="grid mt-3">
        <thead>
          <tr>
            <th>Element</th>
            <th className="num" title="Post-mitigation, one swing">
              Per hit
            </th>
            <th className="num">Per second</th>
            <th
              className="num"
              title="What your shield and health regeneration between hits do not cover"
            >
              Net loss/s
            </th>
            <th className="num">Dead in</th>
            <th
              className="num"
              title="Hits survived from full, counting the recovery between them"
            >
              Hits
            </th>
          </tr>
        </thead>
        <tbody>
          {overTime.byElement.map((entry) => (
            <tr
              key={entry.element}
              className={entry.element === overTime.deadliest.element ? "warn" : undefined}
            >
              <td style={{ color: elementColour(entry.element) }}>
                {elementLabel(entry.element)}
              </td>
              <td className="num">{smart(entry.perHit)}</td>
              <td className="num">{smart(entry.perSecond)}</td>
              <td className="num">
                {entry.sustain.sustainable ? "—" : smart(entry.sustain.netLossPerSecond)}
              </td>
              <td className="num">
                {entry.sustain.sustainable ? "never" : `${smart(entry.sustain.secondsToDeath)}s`}
              </td>
              <td className="num">
                {Number.isFinite(entry.hitsSurvived) ? smart(entry.hitsSurvived) : "∞"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <>
        <Plain>
          <p className="faint text-sm mt-3">
            Shield regeneration pays first, because the shield is hit first; health regeneration
            covers what is left. Dead in is measured from full, against what neither covers.
          </p>
        </Plain>
        <Tech>
          <p className="faint text-sm mt-3">
            The same <code>selfSustain</code> walk Holy Fire&rsquo;s recoil gets: shield
            regeneration is capped by the drain and by the regen, health regeneration takes the
            remainder, and <code>netLossPerSecond</code> is what neither covers. Mitigation is the
            defence pass&rsquo;s own <code>taken</code> fraction — nothing here re-derives a layer.
          </p>
        </Tech>
      </>
    </div>
  );
}

/** The defensive procs, with the rate they have been waiting for. */
function WhenHitCard({ overTime }: { overTime: OverTime }): ReactNode {
  const world = useWorld();

  return (
    <div className="card">
      <table className="grid">
        <thead>
          <tr>
            <th>Casts</th>
            <th>From</th>
            <th className="num">Chance</th>
            <th className="num" title="Triggers a second, before the roll">
              Triggers/s
            </th>
            <th className="num">Casts/s</th>
          </tr>
        </thead>
        <tbody>
          {overTime.procs.map((proc) => (
            <tr key={`${proc.statId}:${proc.spellId}`}>
              <td>{spellName(world.snapshot, proc.spellId)}</td>
              <td className="faint">{statName(world.snapshot, proc.statId)}</td>
              <td className="num">{num(proc.chance * 100, 1)}%</td>
              <td className="num">
                {proc.limit === undefined ? num(proc.triggersPerSecond, 2) : "—"}
              </td>
              <td className="num">
                {proc.limit === undefined ? (
                  num(proc.perSecond, 2)
                ) : (
                  <span className="faint">not rated</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {overTime.ailments.length > 0 && (
        <table className="grid mt-3">
          <thead>
            <tr>
              <th>You suffer</th>
              <th className="num">Chance</th>
              <th className="num">Per second</th>
            </tr>
          </thead>
          <tbody>
            {overTime.ailments.map((ailment) => (
              <tr key={ailment.ailment} className="warn">
                <td style={{ color: elementColour(ailment.element) }}>{ailment.ailment}</td>
                <td className="num">{num(ailment.chance * 100, 0)}%</td>
                <td className="num">{smart(ailment.damagePerSecond)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {overTime.restoresPerSecond.length > 0 && (
        <table className="grid mt-3">
          <thead>
            <tr>
              <th>Restores</th>
              <th className="num">Per second</th>
            </tr>
          </thead>
          <tbody>
            {overTime.restoresPerSecond.map((record) => (
              <tr key={`${record.statId}:${record.resource}`}>
                <td>{statName(world.snapshot, record.statId)}</td>
                <td className="num">
                  {smart(record.amount)} {record.resource}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <>
        <Plain>
          <p className="faint text-sm mt-3">
            These fire when the enemy hits you, so their rate is how often that happens. A proc
            that fires when you <em>block</em> or <em>dodge</em> is listed without a rate: those
            depend on which way each hit went, which this figure averages over.
          </p>
        </Plain>
        <Tech>
          <p className="faint text-sm mt-3">
            <code>Target</code>-side <code>proc_spell</code> blocks. Their chances are the defence
            sweep&rsquo;s own — every <code>ifs</code> folded in — and only the rate is new. A
            block gated on <code>is_is_blocked_true</code> or <code>is_is_dodged_true</code> keeps
            its <code>when-hit</code> limit, because block, dodge and spell dodge are folded into
            one avoidance outcome by the sweep, and splitting them would mean re-deriving the{" "}
            <code>DodgeRating</code> and <code>SpellDodgeEffect</code> curves here.
          </p>
        </Tech>
      </>
    </div>
  );
}
