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

import type { Defence, ElementDefence, Resources } from "@cte2/engine";
import { type ReactNode } from "react";

import { statName, statLayerName } from "@cte2/schema";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, num, smart } from "../../ui/fields.js";
import { Figure } from "../../ui/Figure.js";

export function DefencePanel(): ReactNode {
  const derived = useDerived();

  return (
    <div className="panel">
      <PoolsCard defence={derived.defence} />
      <ElementTable defence={derived.defence} />
      <RegenTable resources={derived.resources} />
      <Breakdown defence={derived.defence} />
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
        <span className="faint text-sm" style={{ fontWeight: 600 }}>
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

function PoolsCard({ defence }: { defence: Defence }): ReactNode {
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
          hint={`Against ${weakest.element}, the element you are softest to. Raw incoming damage, before your mitigation touches it.`}
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
        <Figure
          size="lg"
          label="Weakest to"
          value={weakest.element}
          hint={`${num(weakest.taken * 100, 1)}% of a ${weakest.element} hit reaches your pools`}
        />
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

function ElementTable({ defence }: { defence: Defence }): ReactNode {
  return (
    <div className="card">
      <table className="grid">
        <thead>
          <tr>
            <th>Element</th>
            <th className="num">Taken</th>
            <th className="num">Mitigation</th>
            <th className="num">Pool</th>
            <th className="num">Effective HP</th>
          </tr>
        </thead>
        <tbody>
          {defence.byElement.map((entry) => (
            <tr
              key={entry.element}
              className={entry === defence.weakest ? "highlight" : undefined}
            >
              <td>{entry.element}</td>
              <td className="num">{num(entry.taken * 100, 1)}%</td>
              <td className="num">{num((1 - entry.taken) * 100, 1)}%</td>
              <td className="num">{smart(entry.pool)}</td>
              <td className="num">{smart(entry.effectiveHealth)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AttackerNote defence={defence} />
    </div>
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
function Breakdown({ defence }: { defence: Defence }): ReactNode {
  const world = useWorld();
  const entry: ElementDefence = defence.weakest;
  if (entry.steps.length === 0) return null;

  return (
    <div className="card">
      <div className="faint text-sm mb-4" style={{ fontWeight: 600 }}>
        {entry.element} hit, layer by layer
      </div>
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
          {entry.steps.map((step, i) => (
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
