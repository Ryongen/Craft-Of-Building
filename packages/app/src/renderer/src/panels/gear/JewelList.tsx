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
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, RollSlider, useRollDraft } from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { exactModSummary, modDetail, modKeywords } from "../../ui/mods.js";
import { StatLines } from "../../ui/StatLines.js";
import { RarityBadge } from "../../ui/RarityBadge.js";

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
        .map((a) => {
          // The first stat is in the label because a jewel's *name* rarely distinguishes it;
          // the rest go on the hover, and every stat id and stat name goes in the search
          // corpus, so a jewel with three mods is findable by any of them rather than only
          // by the one that happened to be printed.
          const detail = modDetail(snapshot, a.stats);
          return {
            id: a.id,
            label: `${affixName(snapshot, a.id)} — ${
              a.stats[0] === undefined ? "no stats" : modifierLine(snapshot, a.stats[0], 100)
            }`,
            keywords: modKeywords(snapshot, a.stats),
            ...(detail === undefined ? {} : { detail }),
          };
        }),
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
          nth={index + 1}
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

/**
 * One jewel, collapsed to a row that says what it is worth.
 *
 * A jewel has no name of its own — it is a rarity, a level and a handful of affixes — so the
 * row is numbered the way the game numbers its sockets, and what it grants goes beside the
 * number. Expanded, one jewel is three controls plus a block per affix, and a character with
 * four of them filled the Items tab's left column entirely; collapsed, the list answers "what
 * am I wearing" in four lines and still opens onto the editor.
 */
function JewelCard({
  jewel,
  nth,
  pool,
  unsocketed,
  onChange,
  onRemove,
}: {
  jewel: Jewel;
  /** Its place in the list, 1-based — the only name a jewel has. */
  nth: number;
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
  const [open, setOpen] = useState(false);

  /**
   * Everything this jewel grants, on one line.
   *
   * Every affix at its own roll, resolved at the jewel's item level through the engine — so
   * the row cannot disagree with the sidebar. This is the whole reason a collapsed jewel is
   * still identifiable: `+42 Strength · +18 Dexterity` tells two of them apart where
   * "Jewel 2" does not.
   */
  const summary = affixes
    .map((roll) =>
      exactModSummary(snapshot, affix(snapshot, roll.affixId)?.stats, roll.rollPercent, jewel.itemLevel),
    )
    .filter((line) => line.length > 0)
    .join(" · ");

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
    <div className={`collapsible${open ? " open" : ""}${unsocketed ? " dimmed" : ""}`}>
      <div className="collapsible-head" onClick={() => setOpen(!open)}>
        <span className="faint caret">{open ? "▾" : "▸"}</span>
        <strong>Jewel {nth}</strong>
        <RarityBadge rarity={jewel.rarity} />
        <span className="badge">ilvl {jewel.itemLevel}</span>
        {unsocketed && (
          <span className="badge bad" title="Past the jewel_socket count — the game unequips it">
            no socket
          </span>
        )}
        {/* A jewel has no name, so what it grants *is* its name. On the hover too, because at
            this width the row shows the first affix and not much else. */}
        <span className="faint grow ellipsis text-sm" title={summary}>
          {summary.length === 0 ? "no affixes" : summary}
        </span>
        <button
          title="Remove this jewel"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>

      {!open ? null : (
      <div className="collapsible-body">
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
      </div>

      {affixes.map((roll, index) => (
        <JewelAffixRow
          key={index}
          roll={roll}
          pool={pool}
          tiers={tiers}
          itemLevel={jewel.itemLevel}
          onChange={(next) => setAffixes(affixes.map((r, i) => (i === index ? { ...r, ...next } : r)))}
          onRemove={() => setAffixes(affixes.filter((_, i) => i !== index))}
        />
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
      )}
    </div>
  );
}

/**
 * One affix on a jewel: which affix, which tier, and where in that tier's band it rolled.
 *
 * Its own component because the roll draft has to be: the slider and the stat lines under it
 * both render the roll, and during a drag both have to follow the thumb without the document —
 * and therefore the whole engine — moving per pixel. See `useRollDraft`.
 */
function JewelAffixRow({
  roll,
  pool,
  tiers,
  itemLevel,
  onChange,
  onRemove,
}: {
  roll: AffixRoll;
  pool: PickerOption[];
  /** The tiers this jewel's rarity allows, in order. */
  tiers: string[];
  itemLevel: number;
  onChange: (next: Partial<AffixRoll>) => void;
  onRemove: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const draft = useRollDraft(roll.rollPercent);

  // A jewel affix always has a tier; the undefined arm is only here because `AffixRoll.tier`
  // is optional for implicits, which jewels do not have.
  const band = (tierId: string | undefined): { min: number; max: number } =>
    tierId === undefined
      ? { min: 0, max: 100 }
      : gearRarity(snapshot, tierId)?.statPercents ?? { min: 0, max: 100 };

  const stats = affix(snapshot, roll.affixId)?.stats ?? [];

  /**
   * Every roll this affix could have, across all the tiers the jewel's rarity allows.
   *
   * The slider stays inside the tier it is set to — dragging is how you move a roll *within* a
   * tier. Typing a value is the other question: "my jewel says +14 Strength", where the tier is
   * part of the answer rather than a constraint on it. So the value box reaches the whole ladder
   * and `tierFor` works out which rung it landed on.
   */
  const reachable =
    tiers.length === 0
      ? band(roll.tier)
      : {
          min: Math.min(...tiers.map((t) => band(t).min)),
          max: Math.max(...tiers.map((t) => band(t).max)),
        };

  /** The allowed tier whose band holds this roll, or the current one when none does. */
  const tierFor = (rollPercent: number): string =>
    tiers.find((t) => rollPercent >= band(t).min && rollPercent <= band(t).max) ??
    roll.tier ??
    tiers[0] ??
    "common";

  return (
    <div className="mb-3">
      {/*
        Three lines rather than one. The affix name, the tier and the roll controls together came
        to about 700px, so at this width the picker was squeezed to nothing and the one thing a
        jewel is chosen by — which affix it is — was the part that got truncated. The name gets
        its own row and the numbers get theirs.
      */}
      <div className="row">
        <Picker
          options={pool}
          value={roll.affixId}
          onChange={(id) => id !== undefined && onChange({ affixId: id })}
          width="100%"
        />
        <button title="Remove this affix" onClick={onRemove}>
          ✕
        </button>
      </div>

      <div className="row wrap" style={{ marginTop: 3 }}>
        <select
          value={roll.tier}
          title="The affix's own tier, which is not the jewel's — the roll band comes from this"
          onChange={(event) => {
            const tier = event.target.value;
            const next = band(tier);
            // The bands never overlap, so a roll kept across a tier change would always be out
            // of band. Clamp rather than leaving it illegal.
            onChange({
              tier,
              rollPercent: Math.min(Math.max(roll.rollPercent, next.min), next.max),
            });
          }}
        >
          {tiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
        <RollSlider
          value={draft.shown}
          onPreview={draft.preview}
          min={band(roll.tier).min}
          max={band(roll.tier).max}
          ends
          onChange={(rollPercent) => onChange({ rollPercent })}
        />
      </div>

      {/*
        The same editable stat lines gear affixes get, so the number printed on a jewel in game
        can simply be typed in. `reachable` rather than the current tier's band means a value
        belonging to another tier re-tiers instead of being clamped to the nearest thing the
        selected tier could manage.
      */}
      <StatLines
        mods={stats}
        rollPercent={draft.shown}
        band={reachable}
        itemLevel={itemLevel}
        onRoll={(rollPercent) => onChange({ rollPercent, tier: tierFor(rollPercent) })}
      />
    </div>
  );
}
