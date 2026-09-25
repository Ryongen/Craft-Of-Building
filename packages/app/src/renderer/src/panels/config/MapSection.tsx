/**
 * The map the fight is in: its tier, and the affixes it rolled.
 *
 * Below the conditions because it is the same kind of question — something about the world the
 * build is played in, rather than about the build — and above the server settings because a map
 * moves every number on the Damage and Defence tabs and a server setting moves one.
 *
 * Every affix lands on the side its `affected` names, which is the part a player is least likely
 * to expect: `fire_minus_res` is a map affix too, and it is on **your** sheet. So the chosen list
 * is split by side rather than kept in the order they were added — "what is this map doing to me"
 * is a question worth being able to read at a glance. See `damage/map.ts` for the arithmetic.
 */

import { humanise, mapRarityForTier, maxMapTier, rarityName, type MapSetup } from "@cte2/schema";
import { balance, mapAffix, mapAffixIds, mapAffixRoll, mapTierBonus, mapTierOf } from "@cte2/engine";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { NumberField, RollSlider } from "../../ui/fields.js";
import type { PickerOption } from "../../ui/Picker.js";
import type { At } from "../../ui/HoverCard.js";
import { GemWindow, useGemTooltip } from "../../ui/SpellTooltip.js";
import { mapAffixCard } from "../../ui/spell-stats.js";
import { Plain, Tech } from "../../ui/copy/hint.js";
import { num } from "../../ui/format.js";

/** `map`, with `changes` laid over it — `undefined` in `changes` removes the field. */
function withChanges(map: MapSetup | undefined, changes: { [K in keyof MapSetup]?: MapSetup[K] | undefined }): MapSetup {
  const next: MapSetup = { ...(map ?? {}) };
  for (const [key, value] of Object.entries(changes) as [keyof MapSetup, unknown][]) {
    if (value === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

export function MapSection(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setMap = useBuild((s) => s.setMap);
  const map = doc.config?.map;

  const top = useMemo(() => maxMapTier(snapshot), [snapshot]);
  const rollable = useMemo(() => mapAffixIds(snapshot), [snapshot]);
  const tier = mapTierOf(snapshot, map);
  const rarity = mapRarityForTier(snapshot, tier);
  const roll = mapAffixRoll(snapshot, map);
  const bonus = mapTierBonus(balance(snapshot), tier);
  // A mob in a map spawns at the map's level, and the enemy level is where this document says
  // what that is.
  const level = doc.config?.enemy?.level ?? doc.config?.enemyLevel ?? doc.character.level;

  const chosen = map?.affixes ?? [];
  const onYou = chosen.filter((id) => mapAffix(snapshot, id)?.affected === "Players");
  const onMobs = chosen.filter((id) => !onYou.includes(id));

  const options = useMemo<PickerOption[]>(
    () =>
      rollable.map((id) => {
        const lines = mapAffixCard(snapshot, id, { roll, level })?.stats.map((l) => l.text) ?? [];
        const players = mapAffix(snapshot, id)?.affected === "Players";
        return {
          id,
          label: humanise(id),
          hint: players ? "on you" : "on mobs",
          keywords: `${id} ${lines.join(" ")}`,
          detail: lines.join("\n"),
          ...(chosen.includes(id) ? { disabled: "Already on this map. A map can't roll the same affix twice" } : {}),
        };
      }),
    [rollable, snapshot, roll, level, chosen],
  );

  const setTier = (next: number): void => {
    const band = mapRarityForTier(snapshot, Math.trunc(next))?.statPercents;
    // A roll stated for the old rarity is not one the new rarity can make, so it goes back to
    // following the band rather than sitting outside it.
    const staleRoll =
      map?.affixRoll !== undefined &&
      band !== undefined &&
      (map.affixRoll < band.min || map.affixRoll > band.max);
    setMap(withChanges(map, { tier: next, ...(staleRoll ? { affixRoll: undefined } : {}) }));
  };

  const band = rarity?.statPercents;
  const stated = map !== undefined && ((map.tier ?? 0) > 0 || chosen.length > 0);

  return (
    <>
      <div className="section-title">
        Map{" "}
        <span className="faint text-sm" style={{ fontWeight: "normal" }}>
          what the map puts on the mobs, and on you
        </span>
      </div>
      <div className="card">
        <div className="row wrap gap-6" style={{ alignItems: "flex-end" }}>
          <div className="field">
            <label>Tier</label>
            <NumberField value={tier} min={0} max={top} width={62} onChange={setTier} />
          </div>
          {rarity !== undefined && (
            <div className="field" title={`Tiers ${rarity.tiers.min}–${rarity.tiers.max}`}>
              <label>Rarity</label>
              <div>{rarityName(snapshot, rarity.id)}</div>
            </div>
          )}
          {band !== undefined && (
            <div className="field">
              <label>Affix roll</label>
              <div className="row gap-6">
                <RollSlider
                  value={roll}
                  min={band.min}
                  max={band.max}
                  onChange={(value) => setMap(withChanges(map, { affixRoll: value }))}
                />
                {map?.affixRoll !== undefined && (
                  <button
                    title="Reset to the average roll for this rarity"
                    onClick={() => setMap(withChanges(map, { affixRoll: undefined }))}
                  >
                    Average
                  </button>
                )}
              </div>
            </div>
          )}
          {stated && (
            <button className="map-clear" onClick={() => setMap(undefined)}>
              Clear map
            </button>
          )}
        </div>

        {tier > 0 && (
          <div className="text-sm mt-3">
            Every mob here has <strong>+{num(bonus.health, 1)}%</strong> more health and{" "}
            <strong>+{num(bonus.damage, 1)}%</strong> more damage.
          </div>
        )}

        <div className="map-affix-columns mt-4">
          <MapAffixList
            title="On the mobs"
            empty="Nothing added to the mobs."
            ids={onMobs}
            side="mobs"
            roll={roll}
            level={level}
            onRemove={(id) => setMap(withChanges(map, { affixes: chosen.filter((x) => x !== id) }))}
          />
          <MapAffixList
            title="On you"
            empty="Nothing added to you."
            ids={onYou}
            side="you"
            roll={roll}
            level={level}
            onRemove={(id) => setMap(withChanges(map, { affixes: chosen.filter((x) => x !== id) }))}
          />
        </div>

        <div className="row wrap gap-6 mt-3" style={{ alignItems: "center" }}>
          <AddPicker
            label="Add map affix"
            placeholder="Which affix?"
            options={options}
            width={300}
            // The same card the chosen rows and the mob prefix/suffix lists show, at this map's
            // roll and level — so the list reads as numbers rather than as ids.
            renderHover={(option: PickerOption, at: At) => {
              const card = mapAffixCard(snapshot, option.id, { roll, level });
              if (card === undefined) return null;
              return (
                <GemWindow
                  card={option.disabled === undefined ? card : { ...card, note: option.disabled }}
                  floating
                  at={at}
                />
              );
            }}
            onAdd={(id) => setMap(withChanges(map, { affixes: [...chosen, id] }))}
          />
          {rarity !== undefined && chosen.length > 0 && (
            <span className={`map-affix-count text-sm ${chosen.length > rarity.affixCount ? "warn" : "faint"}`}>
              {chosen.length} chosen · {rarityName(snapshot, rarity.id)} maps roll {rarity.affixCount}
            </span>
          )}
        </div>

        <>
          <Plain>
            <div className="faint text-sm mt-3" style={{ maxWidth: 760 }}>
              Higher map tiers make mobs tougher and roll stronger affixes. Some affixes buff the mobs
              (more resistance, hits converted to fire), others weaken you (less fire resistance, less
              armour). Both apply on the Damage and Defence tabs. Extra mob health is shown but doesn't
              change any number yet, since nothing measures time to kill.
            </div>
          </Plain>
          <Tech>
            <div className="faint text-sm mt-3" style={{ maxWidth: 760 }}>
              <code>StatCalculation</code> runs <code>CommonStatUtils.addMapAffixStats</code> for
              players and mobs alike, and each affix reaches the side its <code>affected</code>{" "}
              names, at <code>getStats(p, mapLevel)</code>, so <code>Players</code> affixes enter
              your own container as a <code>MOB_AFFIX</code> context. The tier is{" "}
              <code>getTierStats</code>: <code>MORE health</code> and{" "}
              <code>MORE total_damage</code> of{" "}
              <code>tier × HP/DMG_MOB_BONUS_PER_MAP_TIER × 100</code>, reaching non-summon mobs via{" "}
              <code>MobStatUtils.addMapTierStats</code>. <code>setTier</code> re-derives the rarity
              from the tier (<code>rarityForTier</code>) and <code>MapBlueprint</code> rolls each
              affix at <code>rarity.stat_percents.random()</code>; unset, the roll here is the middle
              of that band. Only affixes with an empty <code>req</code> and a non-zero weight are
              offered; prophecy affixes are a separate system. The tier&apos;s damage is in the
              Defence tab&apos;s over-time figures and not in effective HP, which is per unit of the
              mob&apos;s base hit. Mob level is the enemy level above. Read from{" "}
              <code>Mine_and_Slash-1.20.1-6.4.13.jar</code>.
            </div>
          </Tech>
        </>
      </div>
    </>
  );
}

function MapAffixList({
  title,
  empty,
  ids,
  side,
  roll,
  level,
  onRemove,
}: {
  title: string;
  empty: string;
  ids: readonly string[];
  side: "mobs" | "you";
  roll: number;
  level: number;
  onRemove: (id: string) => void;
}): ReactNode {
  return (
    <div className="map-affix-list">
      <div className="vitals-title">{title}</div>
      {ids.length === 0 ? (
        <div className="faint text-sm">{empty}</div>
      ) : (
        ids.map((id) => (
          <MapAffixRow key={id} id={id} side={side} roll={roll} level={level} onRemove={() => onRemove(id)} />
        ))
      )}
    </div>
  );
}

function MapAffixRow({
  id,
  side,
  roll,
  level,
  onRemove,
}: {
  id: string;
  side: "mobs" | "you";
  roll: number;
  level: number;
  onRemove: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const card = useMemo(() => mapAffixCard(snapshot, id, { roll, level }), [snapshot, id, roll, level]);
  const tip = useGemTooltip(card);

  return (
    <div className="map-affix-row" {...tip.props}>
      {tip.node}
      <span className="map-affix-name ellipsis">{humanise(id)}</span>
      <span className="map-affix-lines">
        {(card?.stats ?? []).map((line) => {
          // A line is `good` for whoever holds the stat. On a mob, that is bad for you — the
          // colour answers "does this hurt me", which is the only question the list is for.
          const helpsYou = side === "you" ? line.good : !line.good;
          return (
            <span key={line.statId} className={`gem-mod ${helpsYou ? "good" : "bad"}`}>
              {line.text}
            </span>
          );
        })}
      </span>
      <button
        className="map-affix-remove"
        title="Remove from the map"
        onClick={() => {
          tip.clear();
          onRemove();
        }}
      >
        ✕
      </button>
    </div>
  );
}
