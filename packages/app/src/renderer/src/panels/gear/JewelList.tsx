/**
 * Jewels socketed into the tree.
 *
 * A smaller item: a rarity, a level, and affixes of type `jewel`. No base, because a jewel has
 * none — which means the affix pool cannot be filtered by tags the way gear's is, and every
 * `jewel` affix in the pack is offered.
 *
 * `socket` is optional in the document and left that way here. It records which talent-grid
 * cell the jewel sits in, and nothing in the engine reads it — jewel stats apply wherever the
 * jewel is. Offering a coordinate picker would imply a radius rule Mine and Slash does not have.
 *
 * ## How many you may wear is a stat, not a constant
 *
 * `JewelInvHelper.getJewelSocketsMaxStat` is `(int) getCalculatedStat(JewelSocketStat)` and
 * `checkRemoveJewels` unequips everything past it, so a jewel with no socket contributes
 * nothing at all. The stat comes from the 18 `jewel_socket` cells in the talent grid and from
 * two uniques — Bubonic Trail (1-2) and Hungering Vessel (4) — and the engine reads it off the
 * finished sheet. This panel reads the same number back off the sheet rather than recounting
 * the tree, so the two cannot disagree.
 */

import {
  CATEGORY,
  affix,
  affixName,
  allowedAffixTiers,
  gearRarity,
  ids,
  modifierLine,
  type AffixRoll,
  type Jewel,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, RollSlider } from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";

/** `JewelSocketStat`'s GUID, which is also the id of the talent that grants it. */
const JEWEL_SOCKET_STAT = "jewel_socket";

export function JewelList(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const addJewel = useBuild((s) => s.addJewel);
  const updateJewel = useBuild((s) => s.updateJewel);
  const removeJewel = useBuild((s) => s.removeJewel);
  const derived = useDerived();

  const jewels = doc.jewels ?? [];
  const { snapshot } = world;
  // The same number `collectJewels` clamps against: the sheet's own, truncated as the game's
  // `(int)` cast does.
  const sockets = Math.trunc(derived.stats.get(JEWEL_SOCKET_STAT)?.value ?? 0);

  const pool = useMemo<PickerOption[]>(
    () =>
      ids(snapshot, CATEGORY.affix)
        .map((id) => affix(snapshot, id))
        .filter((a): a is NonNullable<typeof a> => a !== undefined && a.type === "jewel")
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          label: `${affixName(snapshot, a.id)} — ${
            a.stats[0] === undefined ? "no stats" : modifierLine(snapshot, a.stats[0], 100)
          }`,
          keywords: a.stats.map((s) => String(s["stat"] ?? "")).join(" "),
        })),
    [snapshot],
  );

  return (
    <>
      <div className="section-title">Jewels</div>

      <div className="row wrap mb-3">
        <span className={jewels.length > sockets ? "badge bad" : "badge"}>
          {jewels.length} of {sockets} socket{sockets === 1 ? "" : "s"}
        </span>
        <span className="faint text-sm">
          <code>jewel_socket</code> off your sheet — 18 talents grant one each, and Bubonic Trail
          and Hungering Vessel grant more.
        </span>
      </div>

      {sockets === 0 && (
        <div className="notice">
          No <code>jewel_socket</code> allocated, so a jewel here would grant{" "}
          <strong>nothing</strong>. <code>JewelInvHelper.checkRemoveJewels</code> unequips every
          jewel past the socket count, and the engine drops them the same way. Take a{" "}
          <code>jewel_socket</code> talent on the tree first.
        </div>
      )}

      {jewels.length === 0 && (
        <div className="faint mb-4">
          None. Jewels carry <code>jewel</code>-type affixes and apply wherever they are
          socketed — the tree position is recorded but Mine and Slash has no radius rule.
        </div>
      )}

      {jewels.map((jewel, index) => (
        <JewelCard
          key={index}
          jewel={jewel}
          pool={pool}
          unsocketed={index >= sockets}
          onChange={(next) => updateJewel(index, next)}
          onRemove={() => removeJewel(index)}
        />
      ))}

      <button
        disabled={pool.length === 0 || jewels.length >= sockets}
        title={
          jewels.length >= sockets
            ? `All ${sockets} jewel socket(s) are used. Allocate another jewel_socket talent to add one.`
            : undefined
        }
        onClick={() => addJewel({ rarity: "rare", itemLevel: doc.character.level })}
      >
        Add jewel
      </button>
    </>
  );
}

function JewelCard({
  jewel,
  pool,
  unsocketed,
  onChange,
  onRemove,
}: {
  jewel: Jewel;
  pool: PickerOption[];
  /** Past the last socket — the game unequips it, so the engine counts none of it. */
  unsocketed: boolean;
  onChange: (jewel: Jewel) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const rarity = world.rarity(jewel.rarity);
  const affixes = jewel.affixes ?? [];

  const tiers = useMemo(
    () => (rarity === undefined ? [] : allowedAffixTiers(snapshot, rarity)),
    [snapshot, rarity],
  );

  const setAffixes = (next: AffixRoll[]): void => {
    const merged: Jewel = { ...jewel };
    if (next.length === 0) delete merged.affixes;
    else merged.affixes = next;
    onChange(merged);
  };

  // A jewel affix always has a tier; the undefined arm is only here because `AffixRoll.tier`
  // is optional for implicits, which jewels do not have.
  const band = (tierId: string | undefined): { min: number; max: number } =>
    tierId === undefined ? { min: 0, max: 100 } : gearRarity(snapshot, tierId)?.statPercents ?? { min: 0, max: 100 };

  return (
    /*
     * `dimmed` is a class rather than `style={{ opacity: 0.55 }}` because of what is inside this
     * card: `opacity` below 1 creates a stacking context, and the "Add affix" picker's dropdown
     * has a `z-index` that would be scoped inside it — behind every jewel card below. That is
     * exactly the bug `.slot-row.empty` already carries a fix for, and it arrived here the same
     * way, the moment an "add" button became a control that opens something. An inline style
     * cannot be overridden by the `:has()` rule that lifts it, so it had to stop being one.
     */
    <div className={`card${unsocketed ? " dimmed" : ""}`}>
      {unsocketed && (
        <div className="notice">
          No socket for this one — it grants <strong>nothing</strong>. The game unequips every
          jewel past the <code>jewel_socket</code> count and the engine drops it the same way.
        </div>
      )}
      <div className="row wrap mb-3">
        <select
          value={jewel.rarity}
          onChange={(event) => onChange({ ...jewel, rarity: event.target.value })}
        >
          {world.rarities.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({r.minAffixes} affixes)
            </option>
          ))}
        </select>
        <div className="field">
          <label>ilvl</label>
          <NumberField
            value={jewel.itemLevel}
            min={1}
            max={world.maxLevel}
            width={58}
            onChange={(itemLevel) => onChange({ ...jewel, itemLevel })}
          />
        </div>
        <span className="faint">
          {affixes.length} of {rarity?.minAffixes ?? 0} affixes
        </span>
        <div className="grow" />
        <button onClick={onRemove}>Remove</button>
      </div>

      {affixes.map((roll, index) => (
        <div key={index} style={{ marginBottom: 5 }}>
          <div className="row">
            <Picker
              options={pool}
              value={roll.affixId}
              onChange={(id) =>
                id !== undefined &&
                setAffixes(affixes.map((r, i) => (i === index ? { ...r, affixId: id } : r)))
              }
              width={280}
            />
            <select
              value={roll.tier}
              onChange={(event) => {
                const tier = event.target.value;
                const next = band(tier);
                setAffixes(
                  affixes.map((r, i) =>
                    i === index
                      ? {
                          ...r,
                          tier,
                          rollPercent: Math.min(Math.max(r.rollPercent, next.min), next.max),
                        }
                      : r,
                  ),
                );
              }}
            >
              {tiers.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
            <RollSlider
              value={roll.rollPercent}
              min={band(roll.tier).min}
              max={band(roll.tier).max}
              ends
              onChange={(rollPercent) =>
                setAffixes(affixes.map((r, i) => (i === index ? { ...r, rollPercent } : r)))
              }
            />
            <button onClick={() => setAffixes(affixes.filter((_, i) => i !== index))}>✕</button>
          </div>
          {(affix(snapshot, roll.affixId)?.stats ?? []).map((mod, i) => (
            <div key={i} className="text-sm" style={{ color: "var(--good)", paddingLeft: 6 }}>
              {modifierLine(snapshot, mod, roll.rollPercent)}
            </div>
          ))}
        </div>
      ))}

      {/* `pool[0].id` — whichever affix the pool happened to order first, added without being
          named. The tier and roll it arrives with are unchanged: the first legal tier, at the
          floor of that tier's band. */}
      <AddPicker
        label="Add affix"
        placeholder="Which affix?"
        options={pool}
        width={280}
        onAdd={(affixId) =>
          setAffixes([
            ...affixes,
            {
              affixId,
              tier: tiers[0] ?? "common",
              rollPercent: band(tiers[0] ?? "common").min,
            },
          ])
        }
      />
    </div>
  );
}
