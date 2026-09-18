/**
 * Augments — aura gems — what each one is granting, and whether they fit.
 *
 * Shared between the Config tab, where it sits with the rest of the character's declared
 * state, and the Items tab, where it belongs beside the gear because that is where a player
 * looks for it: an Augment is a socketed gem, not a setting.
 *
 * Extracted rather than copied. Two editors over the same `doc.auras` would be two ideas about
 * what an unset roll means, and the roll is the half of an Augment that decides its value.
 */

import {
  CATEGORY,
  auraName,
  entry,
  isAuraEnabled,
  type AuraSetup,
} from "@cte2/schema";
import { auraCapacity, type AuraCapacity } from "@cte2/engine";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../state/build-store.js";
import { useDerived } from "../state/derived.js";
import { useWorld } from "../state/snapshot.js";
import { AddPicker } from "./AddPicker.js";
import { GemRarityRoll, gemBand, gemRarities } from "./GemRoll.js";
import { Picker, type PickerOption } from "./Picker.js";
import { StatLines } from "./StatLines.js";
import { useRollDraft } from "./fields.js";
import { smart } from "./format.js";
import { exactModSummary, modDetail, modKeywords } from "./mods.js";

export function AugmentList({
  compact = false,
}: {
  /**
   * Drop the explanatory notice and narrow the controls, for the Items tab's left column.
   *
   * The prose is worth reading once, on the tab where the rest of the character's declared
   * state is explained. Beside the paperdoll it would be four lines of theory above two rows
   * of gem, in a column 320px wide.
   */
  compact?: boolean;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const setAuras = useBuild((s) => s.setAuras);
  const derived = useDerived();
  const auras = doc.auras ?? [];

  /**
   * The Augments, searchable by what they grant rather than only by what they are called.
   *
   * Every name in this list is flavour — Decree of Pain, not "physical ailment" — so the one
   * thing a player is certain to know about the Augment they want is the stat they are after.
   * `modKeywords` puts `bleed_chance` and "Bleed Chance" in the corpus, so "bleed" finds Decree
   * of Pain, and `modDetail` puts the same lines on the row's hover so the match is legible
   * rather than mysterious.
   *
   * At the top of the band, which is what `modDetail` defaults to: these are the numbers a
   * mythic roll is worth, and the point of the hover is to tell two Augments apart.
   */
  const options = useMemo<PickerOption[]>(
    () =>
      world.auraIds.map((id) => {
        const data = entry(world.snapshot, CATEGORY.aura, id)?.data;
        const stats = data?.["stats"];
        const detail = modDetail(world.snapshot, stats);
        const reservation = data?.["reservation"];
        // What it costs decides whether an Augment is takeable at all, so it is the hint on the
        // row rather than something you find out after picking one.
        const hint =
          typeof reservation === "number" ? `${smart(reservation * 100)} cap` : undefined;
        return {
          id,
          label: auraName(world.snapshot, id),
          keywords: `${id} ${modKeywords(world.snapshot, stats)}`,
          ...(hint === undefined ? {} : { hint }),
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    [world],
  );

  /**
   * What the Augments reserve against what the character has — `GemInventoryHelper`, ported.
   *
   * The same shape the jewel list gives sockets, and for the same reason: an Augment past the
   * capacity is not a weaker Augment. `removeAurasIfCantWear` strips **every** Augment off the
   * character the moment `getRemainingSpirit()` goes negative, so one Augment too many is a
   * character with none.
   */
  const capacity = useMemo(
    () => auraCapacity({ snapshot: world.snapshot }, auras, derived.stats),
    [world.snapshot, auras, derived.stats],
  );

  const update = (index: number, next: AuraSetup): void =>
    setAuras(auras.map((aura, i) => (i === index ? next : aura)));

  return (
    <>
      <div className="section-title">Augments</div>

      <CapacityBar capacity={capacity} />

      {!compact && (
        <div className="notice">
          Every Augment is a gem with a rarity and a roll of its own
          (<code>SkillGemData.rar</code> and <code>.perc</code>). The rarity grants nothing
          directly — it is the band the roll came from, so a mythic Augment rolls 86-100 and a
          common one 0-17. One with no roll set computes at the bottom of its band and says so in
          Diagnostics. <code>aura_effect</code> — Augment Effect — scales whatever these grant,
          and is applied.
        </div>
      )}

      {auras.map((aura, index) => (
        <AugmentRow
          key={`${aura.id}-${index}`}
          aura={aura}
          options={options}
          compact={compact}
          cost={capacity.entries.find((e) => e.auraId === aura.id)?.cost}
          onChange={(next) => update(index, next)}
          onRemove={() => setAuras(auras.filter((_, i) => i !== index))}
        />
      ))}

      {/* `world.auraIds[0]` used to be added outright — an Augment nobody picked, already
          enabled and already on the sheet. */}
      <AddPicker
        label="Add Augment"
        placeholder="Which Augment?"
        options={options}
        width={compact ? "100%" : 240}
        onAdd={(id) => setAuras([...auras, { id }])}
      />
    </>
  );
}

/**
 * Augment Capacity spent against Augment Capacity held.
 *
 * Deliberately the same row the jewel list prints its sockets in, because it answers the same
 * question — except the failure is worse: a jewel past the socket count is dropped on its own,
 * while an Augment past the capacity takes the whole set with it.
 */
function CapacityBar({ capacity }: { capacity: AuraCapacity }): ReactNode {
  const over = capacity.remaining < 0;
  const used = capacity.capacity === 0 ? 0 : (capacity.reserved / capacity.capacity) * 100;

  return (
    <>
      <div className="row wrap mb-3">
        <span className={over ? "badge bad" : "badge"}>
          {capacity.reserved} of {capacity.capacity} reserved
        </span>
        <span
          className={over ? "badge bad" : capacity.remaining === 0 ? "badge warn" : "badge good"}
        >
          {over ? `${-capacity.remaining} over` : `${capacity.remaining} left`}
        </span>
        <span
          className="faint text-sm"
          title={
            "GemInventoryHelper.getTotalSpirit — the `spirit_cost` stat, which the game calls " +
            "Augment Capacity. It is code-only (no mmorpg_stat entry declares it), base 100, and " +
            "talents and gear take it to at most 250."
          }
        >
          <code>spirit_cost</code> off your sheet
        </span>
      </div>

      {/* A bar because the question is "how much room is left", which is a proportion rather
          than a count — unlike jewel sockets, where every jewel costs exactly one. */}
      <div
        className="capacity-track mb-3"
        title={`${smart(capacity.reserved)} of ${capacity.capacity}`}
      >
        <div
          className={`capacity-fill${over ? " over" : ""}`}
          style={{ width: `${Math.min(100, used)}%` }}
        />
      </div>

      {over && (
        <div className="notice">
          <strong>Over capacity by {-capacity.remaining}.</strong>{" "}
          <code>removeAurasIfCantWear</code> unequips <strong>every</strong> Augment on the
          character the moment <code>getRemainingSpirit()</code> goes negative — not just the
          last one — so this is a character wearing none of them. The engine still sums them all,
          which is why this is a note rather than something the panel does for you.
        </div>
      )}
    </>
  );
}

/**
 * One Augment: a collapsed row that says what it is worth, opening onto its editor.
 *
 * Collapsed by default. An Augment is five controls and a stat list, and a character carries
 * several — expanded, two of them filled the Items tab's left column and pushed the jewels off
 * the bottom. What a reader wants from the list is which Augments are on and what they cost, and
 * both of those fit on the row.
 *
 * The roll draft lives here rather than inside the slider because the slider and the stat lines
 * are siblings and both have to follow a drag. See `useRollDraft`.
 */
function AugmentRow({
  aura,
  options,
  compact,
  cost,
  onChange,
  onRemove,
}: {
  aura: AuraSetup;
  options: PickerOption[];
  compact: boolean;
  /** What this one reserves, or `undefined` when it is switched off and reserves nothing. */
  cost: number | undefined;
  onChange: (next: AuraSetup) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const level = useBuild((s) => s.doc.character.level);
  const [open, setOpen] = useState(false);

  const band = gemBand(world, aura.rarity);
  const roll = useRollDraft(aura.rollPercent ?? band.min);

  const data = entry(snapshot, CATEGORY.aura, aura.id)?.data;
  const raw = data?.["stats"];
  const enabled = isAuraEnabled(aura);

  // What it grants, at the roll it is actually set to — the whole reason a collapsed row is
  // still readable. Resolved through the engine, so it is the number the sheet used.
  const summary = exactModSummary(snapshot, raw, roll.shown, level);

  const minLevel = typeof data?.["min_lvl"] === "number" ? data["min_lvl"] : 0;
  const tooLow = minLevel > level;

  // `undefined` is meaningful here — `GemRarityRoll` clears a field by passing it — so the
  // properties are explicitly nullable rather than merely optional, and the loop below turns a
  // cleared one into a *missing* key. These documents are pasted into fixtures, and
  // `"rarity": undefined` is not JSON.
  const merge = (next: { [K in keyof AuraSetup]?: AuraSetup[K] | undefined }): void => {
    const merged = { ...aura, ...next } as AuraSetup;
    for (const key of Object.keys(merged) as (keyof AuraSetup)[]) {
      if (merged[key] === undefined) delete merged[key];
    }
    onChange(merged);
  };

  return (
    <div className={`collapsible${open ? " open" : ""}${enabled ? "" : " off"}`}>
      <div className="collapsible-head" onClick={() => setOpen(!open)}>
        <span className="faint caret">{open ? "▾" : "▸"}</span>
        <label className="field" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={enabled}
            title="Off reserves nothing and grants nothing, and keeps the rarity and the roll"
            onChange={(event) => {
              // Spread rather than rebuild: an aura rebuilt from its id alone lost the roll
              // the capture measured, so unticking one to see what it was worth and ticking
              // it back gave a weaker aura than the character actually has.
              const next: AuraSetup = { ...aura };
              if (event.target.checked) delete next.enabled;
              else next.enabled = false;
              onChange(next);
            }}
          />
        </label>
        <strong className="ellipsis">{auraName(snapshot, aura.id)}</strong>
        {cost !== undefined && (
          <span className="badge" title="What this Augment reserves of your Augment Capacity">
            {smart(cost)}
          </span>
        )}
        {tooLow && (
          <span
            className="badge bad"
            title="AuraGem.min_lvl. The game unequips every Augment on the character when one of them is above your level, not just this one."
          >
            needs level {minLevel}
          </span>
        )}
        {/* The whole point of collapsing: the row still says what the Augment is doing. On the
            hover as well as in the row, because the row runs out of width first. */}
        <span className="faint grow ellipsis text-sm" title={summary}>
          {summary}
        </span>
        <button
          title="Remove this Augment"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>

      {open && (
        <div className="collapsible-body">
          <div className="row wrap mb-2">
            <Picker
              options={options}
              value={aura.id}
              onChange={(id) => id !== undefined && merge({ id })}
              width={compact ? "100%" : 260}
            />
          </div>
          <div className="row wrap mb-2">
            <GemRarityRoll
              gem={aura}
              shownRoll={roll.shown}
              onPreview={roll.preview}
              onChange={(next) => merge(next)}
            />
          </div>
          <AuraStatLines aura={aura} shownRoll={roll.shown} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/**
 * What an Augment is granting, with each value editable in place.
 *
 * A percent on its own says nothing: "62%" of a band nobody can see is not a number anyone can
 * plan against. These are the resolved values, through `StatLines` — the same control gear and
 * jewel affixes use, over the engine's own `rollToExact` — so a line here cannot disagree with
 * the sidebar.
 *
 * **Typing a value sets the rarity as well as the roll.** The game's tooltip prints the number
 * and never the `perc` behind it, so reading an Augment off your own inventory means typing
 * what you can see; and because the six rarity bands tile 0-100 without overlapping, that
 * number names exactly one rarity. Entering it used to mean working out for yourself that
 * 11.52% More Physical Damage is a rare at 47, which is `SkillGemBlueprint`'s arithmetic run
 * backwards by hand.
 *
 * `AuraGem.GetAllStats` scales its flats to the **player's** level rather than to an item level
 * (an Augment is a gem in the character's own inventory), which is why the character's level is
 * what goes in as the scaling level.
 */
function AuraStatLines({
  aura,
  shownRoll,
  onChange,
}: {
  aura: AuraSetup;
  /** The roll to render at — the drag in progress where there is one. */
  shownRoll: number;
  onChange: (next: AuraSetup) => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const level = useBuild((s) => s.doc.character.level);

  const raw = entry(snapshot, CATEGORY.aura, aura.id)?.data["stats"];
  const mods = Array.isArray(raw) ? raw : [];

  /**
   * Every roll an Augment can have, across the whole rarity ladder.
   *
   * The slider beside the rarity dropdown stays inside the rarity it is set to, because that is
   * what a rarity *is* — the band the roll was drawn from. The value box is the other question
   * and reaches the whole ladder.
   */
  const ladder = gemRarities(world);
  const reachable =
    ladder.length === 0
      ? gemBand(world, aura.rarity)
      : {
          min: Math.min(...ladder.map((r) => r.min)),
          max: Math.max(...ladder.map((r) => r.max)),
        };

  /** The rarity whose band holds this roll. The bands do not overlap, so there is only one. */
  const rarityFor = (rollPercent: number): string | undefined =>
    ladder.find((r) => rollPercent >= r.min && rollPercent <= r.max)?.id ?? aura.rarity;

  if (mods.length === 0) return null;

  return (
    <div style={{ paddingLeft: 6 }}>
      <StatLines
        mods={mods.filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")}
        rollPercent={shownRoll}
        band={reachable}
        itemLevel={level}
        onRoll={(rollPercent) => {
          const rarity = rarityFor(rollPercent);
          onChange({ ...aura, rollPercent, ...(rarity === undefined ? {} : { rarity }) });
        }}
      />
    </div>
  );
}
