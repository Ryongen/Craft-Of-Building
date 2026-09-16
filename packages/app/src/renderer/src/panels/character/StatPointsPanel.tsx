/**
 * The stat screen: spending level-up points on strength, dexterity and intelligence.
 *
 * This is the mod's own `MainHubScreen` allocation, reproduced against the same rules the
 * server enforces rather than against a screenshot of it:
 *
 *  - **which stats** — `AllocateStatPacket.onReceived` rejects anything that is not a
 *    `CoreStat`, so the rows come from `coreStatIds`, which filters `mmorpg_stat` on the
 *    `core_stat` serializer. Hardcoding the three would quietly go wrong the day the pack adds
 *    a fourth, and would also have swept up the 20 `bonus_stat_per_effect` stats that carry a
 *    `core_stat_data` block without being core stats.
 *  - **how many** — `PlayerPointsType.getFreePoints` is
 *    `base_points + (int)(lvl * points_per_lvl)`, capped at `max_total_points`, which for
 *    `original_balance` is one per level capped at 300. The `+` buttons stop there, the way
 *    the packet's `if (getFreePoints(player) < 1) break;` does.
 *  - **what a point is worth** — exactly +1, at every level. `StatPointsData` passes a literal
 *    `1` as the level to `ExactStatData.levelScaled`, and `CORE_STAT_SCALING` at level 1 is 1.
 *    Levelling grants more points; it never inflates the ones already spent.
 *
 * `max_bonus_points` (50) is deliberately *not* spendable here. Those come from quests and
 * items that a build document has no field for, so the budget shown is what levelling gives;
 * the validator downgrades a spend past it to a warning rather than an error, and the note at
 * the bottom of this panel says why.
 *
 * What each point *does* is not modelled here at all. `CoreStat.affectStats` expands the stat
 * into its bundle during the engine's core-stat pass, so the "grants" column below is read off
 * `core_stat_data` for display and the sheet in the sidebar is the authority.
 */

import {
  CATEGORY,
  coreStatIds,
  entry,
  modifierLine,
  statDesc,
  statName,
  pointsAvailable,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, smart } from "../../ui/fields.js";

/** `AllocateStatPacket.MAX_ALLOCATE_AT_ONCE` — what a shift-click sends. */
const SHIFT_STEP = 5;

export function StatPointsPanel(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setStatPoints = useBuild((s) => s.setStatPoints);
  const clearStatPoints = useBuild((s) => s.clearStatPoints);
  const derived = useDerived();

  const coreStats = useMemo(() => coreStatIds(snapshot), [snapshot]);
  // A capture records `getFreePoints`, which includes the quest and item bonus points this
  // panel deliberately does not offer to spend. Where it is present it is the answer, not an
  // estimate — so the counter reads the game's own number instead of the level-derived floor.
  const points = useMemo(
    () => pointsAvailable(snapshot, doc.character, "STATS"),
    [snapshot, doc.character],
  );
  const budget = points.budget;

  const allocated = doc.character.statPoints ?? {};
  const spent = Object.values(allocated).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  const available = points.total;
  const free = available - spent;

  if (coreStats.length === 0) {
    return (
      <div className="panel">
        <div className="notice">
          No stat in this snapshot uses the <code>core_stat</code> serializer, so there is
          nothing a level-up point could be spent on. That would be a pack change worth looking
          at rather than something to work around here.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="row wrap mb-5">
        <strong>
          {free} point{free === 1 ? "" : "s"} unspent
        </strong>
        <span className="faint">
          {spent} of {available} spent ·{" "}
          {points.recorded
            ? "reported by the game for this character"
            : `level ${doc.character.level} grants ${budget === undefined ? "?" : budget.fromLevel}`}
          {!points.recorded && budget !== undefined && budget.fromLevel === budget.maxTotal
            ? ` (the ${budget.maxTotal} cap)`
            : ""}
        </span>
        <span className="grow" />
        <button disabled={spent === 0} onClick={clearStatPoints}>
          Reset
        </button>
      </div>

      {free < 0 && (
        <div className="notice">
          <strong>{-free} points over budget.</strong>{" "}
          {points.recorded ? (
            <>
              The game reported {available} stat points for this character, bonus points
              included, so this spend is not one it would have allowed.
            </>
          ) : (
            <>
              Levelling to {doc.character.level} grants {available}. Up to{" "}
              {budget?.maxBonus ?? 0} more are obtainable in game from sources a build document
              cannot record, so this is legal up to {budget?.ceiling ?? available} — just not
              verifiable here.
            </>
          )}
        </div>
      )}

      {coreStats.map((statId) => (
        <CoreStatRow
          key={statId}
          statId={statId}
          points={allocated[statId] ?? 0}
          free={free}
          total={derived.stats.get(statId)?.value}
          onChange={(points) => setStatPoints(statId, points)}
        />
      ))}

      <FoodDiversity />

      <WeaponSpeed />

      <WeaponAttackDamage />

      <div className="faint text-sm mt-5" style={{ lineHeight: 1.5 }}>
        One point is <strong>+1</strong>, at every character level —{" "}
        <code>StatPointsData</code> passes a hardcoded level of 1 to{" "}
        <code>ExactStatData.levelScaled</code>, and the core-stat scaling curve at level 1 is
        exactly 1. Levelling grants more points; it never makes the ones you already spent
        worth more.
        <br />
        The <strong>Total</strong> column is the stat on the character sheet, which includes
        gear, perks and auras as well as these points. What each point grants is applied by the
        engine's core-stat pass, so a percentage bonus to the granted stat reaches what the
        attribute itself granted.
      </div>
    </div>
  );
}

/**
 * How fast the equipped weapon swings, which is the one half of the rate nothing can derive.
 *
 * `minecraft:generic.attack_speed` is `(4.0 + the item's own modifier) × (1 + attack_speed / 100)`
 * — MnS's stat is a `MULTIPLY_BASE` modifier on vanilla's attribute. The right factor is a stat
 * and moves with every edit; the left one belongs to a Minecraft item whose modifiers are in that
 * mod's code, not in any registry the extractor reads.
 *
 * So a capture's finished attribute cannot be the answer on its own: read whole, it froze the
 * swing rate at whatever the character was when the photograph was taken. Opening a capture
 * splits it — both numbers are in the file — and this field is the other way in, for a weapon no
 * capture ever held.
 */
function WeaponSpeed(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setBaseAttackSpeed = useBuild((s) => s.setBaseAttackSpeed);
  const derived = useDerived();

  const base = doc.character.baseAttackSpeed;
  const percent = derived.stats.get("attack_speed")?.value ?? 0;
  const captured = doc.character.attributes?.["minecraft:generic.attack_speed"];
  const swings = base === undefined ? captured : base * (1 + percent / 100);

  return (
    <div className="mt-7">
      <div className="section-title">Weapon speed</div>
      <div className="row wrap">
        {/* 0 is "not recorded"; the setter deletes the field rather than storing a zero. */}
        <NumberField
          value={base ?? 0}
          min={0}
          step={0.1}
          width={64}
          onChange={(next) => setBaseAttackSpeed(next)}
        />
        <span className="faint text-sm">
          the weapon&apos;s own swings per second
        </span>
        {swings !== undefined && (
          <span className="badge" title="The weapon's own rate times your attack_speed stat">
            {swings.toFixed(2)}/s at {percent.toFixed(1)}% attack speed
          </span>
        )}
        {base === undefined && captured !== undefined && (
          <span
            className="badge warn"
            title="Your capture's attribute already has this build's attack_speed baked into it, so the rate cannot respond to an edit until the two halves are separated."
          >
            frozen at the captured {captured.toFixed(2)}/s
          </span>
        )}
      </div>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        Vanilla&apos;s <code>attack_speed</code> attribute is the weapon&apos;s own rate multiplied
        by your <code>attack_speed</code> stat, and a capture records only the finished product.
        Splitting them is what lets the basic-attack figure move when your gear does. An axe is
        about 1.2/s, a dagger about 2.5/s; opening a capture fills this in for the weapon you had.
      </div>
    </div>
  );
}

/**
 * The weapon's vanilla attack damage — the other half of it no registry carries.
 *
 * `attack_damage_compat` converts `minecraft:generic.attack_damage` into `total_damage` at 0.5x,
 * and `total_damage` is the only additive-damage stat in the pack with no condition on it: it
 * multiplies every element of every hit, conversion children included. So a build that names a
 * sword in its gear while this reads vanilla's bare-handed 1.0 is not a rounding error — it is
 * every damage figure on the page, low.
 *
 * It is a separate field from the swing rate above because it fails differently. Attack speed
 * has to be *split*, since MnS multiplies into the attribute and a capture records the product.
 * Nothing writes onto attack damage, so a capture taken with the weapon in hand is already right
 * and this box is only ever for a weapon no capture held — which is why it shows the captured
 * number rather than fighting it.
 */
function WeaponAttackDamage(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setWeaponAttackDamage = useBuild((s) => s.setWeaponAttackDamage);
  const derived = useDerived();

  const value = doc.character.attributes?.["minecraft:generic.attack_damage"];
  const total = derived.stats.get("total_damage")?.value ?? 0;

  // Vanilla's player base is 1.0 and every weapon in the pack raises it, so a weapon plus a 1
  // can only mean the attributes were read before the weapon went on.
  const weapons = (doc.gear ?? [])
    .map((item) => entry(snapshot, CATEGORY.baseGearType, item.base)?.data["weapon_type"])
    .filter((type): type is string => typeof type === "string" && type !== "" && type !== "none");
  const stale = weapons.length > 0 && (value === undefined || value <= 1);

  return (
    <div className="mt-7">
      <div className="section-title">Weapon attack damage</div>
      <div className="row wrap">
        {/* 0 removes the key, so "not recorded" stays distinct from "recorded bare-handed". */}
        <NumberField
          value={value ?? 0}
          min={0}
          step={0.5}
          width={64}
          onChange={(next) => setWeaponAttackDamage(next)}
        />
        <span className="faint text-sm">
          vanilla <code>generic.attack_damage</code>, 1.0 bare-handed
        </span>
        {total > 0 && (
          <span className="badge" title="attack_damage_compat converts it at 0.5x into total_damage">
            +{smart(total)}% to every hit
          </span>
        )}
        {stale && (
          <span
            className="badge warn"
            title="A weapon is equipped but this is still the bare-handed value, so total_damage reads zero and every damage number on the page is low."
          >
            {weapons.join(", ")} equipped, still bare-handed
          </span>
        )}
      </div>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        A weapon&apos;s attack damage is a Minecraft item property, so no registry the extractor
        reads can supply it — only a capture taken <em>with the weapon in hand</em>, or this box.{" "}
        <code>attack_damage_compat</code> halves it into <code>total_damage</code>, which is
        additive damage with no condition attached: it moves every element of every hit, so a
        missing weapon here is a flat shortfall on the whole Damage tab.
      </div>
    </div>
  );
}

/**
 * Solonion's food-diversity count.
 *
 * It sits here rather than under gear because it is a property of the character, and it is
 * worth surfacing at all because it is invisible everywhere else: eating distinct foods grants
 * vanilla attributes, `mmorpg_stat_compat` converts those into real stats, and the result is
 * health, magic shield, dodge and armour a player cannot account for by looking at their gear.
 *
 * A capture overrides this — `character.attributes` is what the game reported and already
 * includes diversity — so the field is disabled with a note rather than silently ignored.
 */
function FoodDiversity(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setFoodDiversity = useBuild((s) => s.setFoodDiversity);

  const config = snapshot.externalConfig?.foodDiversity;
  if (!config || config.benefits.length === 0) return null;

  const captured = doc.character.attributes !== undefined;
  const count = doc.character.foodDiversity ?? 0;

  // The next threshold worth eating toward, so the number means something.
  const thresholds = [...new Set(config.benefits.map((b) => b.threshold))].sort((a, b) => a - b);
  const next = thresholds.find((t) => t > count);
  const active = config.benefits.filter((b) => b.threshold <= count);

  return (
    <div className="mt-7">
      <div className="section-title">Food diversity</div>
      <div className="row">
        <NumberField
          value={count}
          min={0}
          max={config.trackCount}
          width={64}
          disabled={captured}
          onChange={(next) => setFoodDiversity(next)}
        />
        <span className="faint text-sm">
          distinct foods eaten (max {config.trackCount})
        </span>
      </div>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        {captured ? (
          <>
            This build carries <code>character.attributes</code> captured from the game, which
            already includes food diversity. The field is disabled so the two are not counted
            twice.
          </>
        ) : (
          <>
            {active.length} of {config.benefits.length} benefits active
            {next === undefined ? " — every threshold reached." : `; next at ${next} foods.`}
            <br />
            These grant vanilla attributes, which <code>mmorpg_stat_compat</code> converts into
            real stats — health, magic shield, dodge and weapon damage among them. Nothing about
            your gear reveals them.
            {config.resetOnDeath ? " Diversity resets on death in this pack." : ""}
          </>
        )}
      </div>
    </div>
  );
}

function CoreStatRow({
  statId,
  points,
  free,
  total,
  onChange,
}: {
  statId: string;
  points: number;
  /** Unspent points, so the steppers can stop where the packet would. */
  free: number;
  /** The stat's value on the character sheet — points plus everything else. */
  total: number | undefined;
  onChange: (points: number) => void;
}): ReactNode {
  const { snapshot } = useWorld();

  /** `core_stat_data.stats` — the bundle one point of this attribute grants. */
  const grants = useMemo(() => {
    const data = entry(snapshot, CATEGORY.stat, statId)?.data;
    const inner = data?.["data"];
    const node = inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
    const bundle = node["core_stat_data"];
    const stats =
      bundle !== null && typeof bundle === "object"
        ? (bundle as Record<string, unknown>)["stats"]
        : undefined;
    return Array.isArray(stats)
      ? stats.filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      : [];
  }, [snapshot, statId]);

  const step = (by: number): void => onChange(Math.max(0, points + by));
  const canAdd = free > 0;

  return (
    <div className="mb-4">
      <div className="alloc-row">
        <span className="alloc-name" title={statDesc(snapshot, statId) ?? statId}>
          {statName(snapshot, statId)}
        </span>

        <button
          className="nudge"
          disabled={points <= 0}
          title="Remove a point"
          onClick={() => step(-1)}
        >
          −
        </button>
        <NumberField
          value={points}
          min={0}
          width={58}
          onChange={(next) => onChange(Math.max(0, Math.round(next)))}
        />
        <button
          className="nudge"
          disabled={!canAdd}
          title="Spend a point"
          onClick={() => step(1)}
        >
          +
        </button>
        {/* `AllocateStatPacket.MAX_ALLOCATE_AT_ONCE` is 5, which is what shift-clicking sends. */}
        <button
          disabled={!canAdd}
          title={`Spend ${SHIFT_STEP} (what a shift-click sends in game)`}
          onClick={() => step(Math.min(SHIFT_STEP, Math.max(free, 0)))}
        >
          +{SHIFT_STEP}
        </button>

        <span className="grow" />
        <span className="faint text-sm">
          total
        </span>
        <span className="alloc-count">{total === undefined ? "—" : smart(total)}</span>
      </div>

      {grants.length > 0 && (
        <div className="faint text-sm" style={{ paddingLeft: 8 }}>
          per point:{" "}
          {grants.map((mod, index) => (
            <span key={index}>
              {index > 0 ? " · " : ""}
              {modifierLine(snapshot, mod, 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
