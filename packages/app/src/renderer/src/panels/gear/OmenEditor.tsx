/**
 * The omen — "Codex" in Craft to Exile 2's wording, which is what the lang table says and so
 * what this shows.
 *
 * Every other thing a character wears grants its stats the moment it is worn. An omen grants
 * **nothing** until enough of the rest of the loadout satisfies requirements it carries, and
 * then grants all of that bucket at once. So the editor's job is less "set these fields" than
 * "show why this is or is not paying out", which is what the tier list at the bottom is: each
 * bucket, the pieces it needs, whether you have them, and what it gives.
 *
 * The other thing worth making visible is that the stat percent is **not a roll**. There is no
 * slider here because there is nothing to slide: `OmenData.getStatPercent` derives it from how
 * hard the omen is to satisfy, so editing the requirements *is* editing the payout. The header
 * prints the derived number and flags it when it exceeds 100, which the game does not clamp.
 */

import { balance, parseRolledMods, rollToExact, statIndex } from "@cte2/engine";
import {
  CATEGORY,
  GEAR_RARITY_TYPES,
  affix,
  affixName,
  countOmenPieces,
  gearRarity,
  ids,
  omen as omenView,
  omenBuckets,
  omenCountsSlot,
  omenIds,
  omenMinLevel,
  omenStatPercent,
  slotName,
  statName,
  text,
  type AffixRoll,
  type Item,
  type OmenSetup,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { applyPatch, type Patch } from "../../state/patch.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, RollSlider, smart } from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";

/** The pack renames omens to "Codex"; `item.mmorpg.omen` is the key that says so. */
function omenWord(snapshot: Parameters<typeof text>[0]): string {
  return text(snapshot, "item.mmorpg.omen") ?? "Omen";
}

/** An omen's display name, e.g. `mmorpg.omen.blood` -> "Codex of Blood". */
function omenName(snapshot: Parameters<typeof text>[0], id: string): string {
  return text(snapshot, `mmorpg.omen.${id}`) ?? id;
}

export function OmenEditor({
  omen,
  gear,
  characterLevel,
  onChange,
  onRemove,
}: {
  omen: OmenSetup;
  /** The rest of the loadout, which is what decides what the omen is worth. */
  gear: readonly Item[];
  characterLevel: number;
  onChange: (omen: OmenSetup) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;

  const view = omenView(snapshot, omen.id);
  const options = useMemo<PickerOption[]>(
    () =>
      omenIds(snapshot).map((id) => {
        const v = omenView(snapshot, id);
        return {
          id,
          label: omenName(snapshot, id),
          hint: v === undefined ? "" : `lvl ${omenMinLevel(snapshot, v)}+`,
        };
      }),
    [snapshot],
  );

  const filled = countOmenPieces(snapshot, gear, omen, characterLevel);
  const buckets = omenBuckets(snapshot, omen);
  const percent = omenStatPercent(
    snapshot,
    omen.requires,
    (omen.slotRequirements ?? []).length,
    omen.rarity,
  );

  // `Patch` rather than `Partial`: the repo compiles with `exactOptionalPropertyTypes`, and
  // clearing a field means passing an explicit `undefined` for `applyPatch` to delete.
  const patch = (next: Patch<OmenSetup>): void => onChange(applyPatch(omen, next));

  return (
    <div className="card">
      <div className="row wrap mb-4">
        <Picker
          options={options}
          value={omen.id}
          onChange={(id) => id !== undefined && patch({ id })}
          width={210}
        />
        <select value={omen.rarity} onChange={(event) => patch({ rarity: event.target.value })}>
          {world.rarities.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}
            </option>
          ))}
        </select>
        <div className="field">
          <label>lvl</label>
          <NumberField
            value={omen.itemLevel}
            min={1}
            max={world.maxLevel}
            width={58}
            onChange={(itemLevel) => patch({ itemLevel })}
          />
        </div>
        <div className="grow" />
        <button onClick={onRemove}>Remove</button>
      </div>

      <div className="row wrap mb-4">
        <span className={`badge ${filled >= (buckets[0]?.pieces ?? 0) ? "good" : "warn"}`}>
          {filled} qualifying piece{filled === 1 ? "" : "s"} equipped
        </span>
        <span className="badge" title="Derived from the requirements, not rolled">
          stats at {percent}%
        </span>
        {percent > 100 && (
          <span
            className="badge warn"
            title={
              "ExactStatData.fromStatModifier does not clamp, so a percent above 100 puts these " +
              "stats above their declared maximum. The game does this too."
            }
          >
            above the declared maximum
          </span>
        )}
      </div>

      <div className="faint text-sm mb-4" style={{ lineHeight: 1.5 }}>
        An {omenWord(snapshot).toLowerCase()} grants nothing on its own. Raising a requirement
        raises the payout — <code>getStatPercent</code> is ten per required piece plus ten per
        slot requirement, times the rarity&apos;s <code>stat_multi</code> — but also raises what
        you have to wear to collect it. The <strong>mainhand never counts</strong>:
        <code>recalcGears</code> collects armour, the offhand and the jewellery curios only.
      </div>

      <Requirements omen={omen} patch={patch} />
      <SlotRequirements omen={omen} patch={patch} />
      <OmenAffixes omen={omen} view={view} patch={patch} />

      <div className="section-title">What it grants</div>
      {buckets.length === 0 ? (
        <div className="faint">Nothing — this omen is not in the snapshot.</div>
      ) : (
        buckets.map((bucket, index) => {
          const live = filled >= bucket.pieces;
          return (
            <div key={index} className="mb-3" style={{ opacity: live ? 1 : 0.5 }}>
              <div className="row">
                <span className={`badge ${live ? "good" : ""}`}>
                  {bucket.pieces} piece{bucket.pieces === 1 ? "" : "s"}
                </span>
                <span className="faint text-sm">
                  {live ? "active" : `needs ${bucket.pieces - filled} more`}
                </span>
              </div>
              <BucketStats
                mods={bucket.mods}
                statPercent={bucket.statPercent ?? 0}
                affixRoll={bucket.affix}
                itemLevel={omen.itemLevel}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

/** `OmenData.rarities` — how many pieces of each `GearRarityType` are needed. */
function Requirements({
  omen,
  patch,
}: {
  omen: OmenSetup;
  patch: (next: Patch<OmenSetup>) => void;
}): ReactNode {
  const requires = omen.requires ?? {};

  const set = (type: string, count: number): void => {
    const next = { ...requires };
    if (count <= 0) delete next[type];
    else next[type] = count;
    patch({ requires: Object.keys(next).length === 0 ? undefined : next });
  };

  return (
    <>
      <div className="section-title">
        Pieces required <span className="faint">(by rarity type, not by rarity)</span>
      </div>
      {GEAR_RARITY_TYPES.map((type) => (
        <div key={type} className="row" style={{ marginBottom: 3 }}>
          <span style={{ width: 82 }}>{type}</span>
          <NumberField
            value={requires[type] ?? 0}
            min={0}
            max={9}
            width={52}
            onChange={(count) => set(type, Math.round(count))}
          />
          <span className="faint text-sm">
            {type === "NORMAL"
              ? "common through mythic"
              : type === "RUNED"
                ? "runeword items"
                : "unique items"}
          </span>
        </div>
      ))}
    </>
  );
}

/** `OmenData.slot_req` — a slot that must hold a given rarity type, or its piece is void. */
function SlotRequirements({
  omen,
  patch,
}: {
  omen: OmenSetup;
  patch: (next: Patch<OmenSetup>) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const reqs = omen.slotRequirements ?? [];

  // `Omen.getRandomSlotReq` filters weapons out — "they're a lot of times swapped" — and the
  // counter never reads the mainhand anyway, so a weapon here could never be satisfied.
  const slots = useMemo(
    () => ids(snapshot, CATEGORY.gearSlot).filter((id) => omenCountsSlot(snapshot, id)).sort(),
    [snapshot],
  );

  const slotOptions = useMemo<PickerOption[]>(
    () => slots.map((id) => ({ id, label: slotName(snapshot, id) })),
    [slots, snapshot],
  );

  const update = (next: { slot: string; rarityType: string }[]): void =>
    patch({ slotRequirements: next.length === 0 ? undefined : next });

  return (
    <>
      <div className="section-title">
        Slot requirements{" "}
        <span className="faint">({reqs.length} — these disqualify a piece, they do not add one)</span>
      </div>
      {reqs.map((req, index) => (
        <div key={index} className="row" style={{ marginBottom: 3 }}>
          <select
            value={req.slot}
            onChange={(event) =>
              update(reqs.map((r, i) => (i === index ? { ...r, slot: event.target.value } : r)))
            }
          >
            {slots.map((id) => (
              <option key={id} value={id}>
                {slotName(snapshot, id)}
              </option>
            ))}
          </select>
          <span className="faint">must be</span>
          <select
            value={req.rarityType}
            onChange={(event) =>
              update(reqs.map((r, i) => (i === index ? { ...r, rarityType: event.target.value } : r)))
            }
          >
            {GEAR_RARITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <button onClick={() => update(reqs.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}
      {/* `slots[0]` was whichever gear slot sorted first — so "Add slot requirement" silently
          claimed the omen required a Belt, and an omen nobody edited further carried it. */}
      <AddPicker
        label="Add slot requirement"
        placeholder="Which slot?"
        options={slotOptions}
        width={220}
        onAdd={(slot) => update([...reqs, { slot, rarityType: "NORMAL" }])}
      />
    </>
  );
}

/**
 * `OmenData.aff` — the corruption affixes, each unlocking one piece earlier than the last.
 *
 * The pool is the omen's own `affix_types`, which is `chaos_stat` throughout this pack. It is
 * not filtered by any base's tags, because an omen is not gear and has none.
 */
function OmenAffixes({
  omen,
  view,
  patch,
}: {
  omen: OmenSetup;
  view: ReturnType<typeof omenView>;
  patch: (next: Patch<OmenSetup>) => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const affixes = omen.affixes ?? [];

  // An omen has no base gear type, so `affixesFor` cannot filter by tags — take every affix of
  // the declared types and let the validator judge the rest.
  const pool = useMemo(() => {
    const types = view?.affixTypes ?? ["chaos_stat"];
    const out: string[] = [];
    for (const id of ids(snapshot, CATEGORY.affix)) {
      const a = affix(snapshot, id);
      if (a !== undefined && types.includes(a.type)) out.push(id);
    }
    return out.sort();
  }, [snapshot, view]);

  const options = useMemo<PickerOption[]>(
    () => pool.map((id) => ({ id, label: affixName(snapshot, id) })),
    [pool, snapshot],
  );

  const tiers = useMemo(
    () =>
      ids(snapshot, CATEGORY.gearRarity)
        .map((id) => gearRarity(snapshot, id))
        .filter((r) => r !== undefined && !r.isUniqueItem)
        .map((r) => r!.id)
        .sort(),
    [snapshot],
  );

  const update = (next: AffixRoll[]): void =>
    patch({ affixes: next.length === 0 ? undefined : next });

  return (
    <>
      <div className="section-title">
        Corruption affixes <span className="faint">({affixes.length} — each unlocks one piece earlier)</span>
      </div>
      {affixes.map((roll, index) => {
        // Omen affixes carry a tier like an item's do; the fallback covers only the optional
        // field, which exists for tierless implicits.
        const band =
          (roll.tier === undefined ? undefined : world.rarity(roll.tier)?.statPercents) ??
          { min: 0, max: 100 };
        return (
          <div key={index} className="row mb-2">
            <Picker
              options={options}
              value={roll.affixId}
              onChange={(id) =>
                id !== undefined && update(affixes.map((r, i) => (i === index ? { ...r, affixId: id } : r)))
              }
              width={200}
            />
            <select
              value={roll.tier}
              onChange={(event) => {
                const tier = event.target.value;
                const next = world.rarity(tier)?.statPercents ?? { min: 0, max: 100 };
                update(
                  affixes.map((r, i) =>
                    i === index
                      ? { ...r, tier, rollPercent: Math.min(Math.max(r.rollPercent, next.min), next.max) }
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
              min={band.min}
              max={band.max}
              onChange={(rollPercent) =>
                update(affixes.map((r, i) => (i === index ? { ...r, rollPercent } : r)))
              }
            />
            <button onClick={() => update(affixes.filter((_, i) => i !== index))}>✕</button>
          </div>
        );
      })}
      {/* `pool[0]` was whichever affix the registry ordered first. The tier and roll it arrives
          with are the same ones the row's own controls start at: the first legal tier, at the
          floor of that tier's band — `tier: "common"` and `rollPercent: 0` were literals, and
          nothing guarantees this pack has a rarity called `common` or that its band starts at 0. */}
      <AddPicker
        label="Add affix"
        placeholder="Which corruption?"
        options={options}
        width={240}
        onAdd={(affixId) => {
          const tier = tiers[0] ?? "common";
          const band = world.rarity(tier)?.statPercents ?? { min: 0, max: 100 };
          update([...affixes, { affixId, tier, rollPercent: band.min }]);
        }}
      />
    </>
  );
}

/** One bucket's stats, resolved through the engine so they match the sheet. */
function BucketStats({
  mods,
  statPercent,
  affixRoll,
  itemLevel,
}: {
  mods: readonly Record<string, unknown>[] | undefined;
  statPercent: number;
  affixRoll: AffixRoll | undefined;
  itemLevel: number;
}): ReactNode {
  const { snapshot } = useWorld();

  const lines = useMemo(() => {
    const index = statIndex(snapshot);
    const bal = balance(snapshot);
    const source = mods ?? affix(snapshot, affixRoll?.affixId ?? "")?.stats ?? [];
    const percent = mods !== undefined ? statPercent : (affixRoll?.rollPercent ?? 0);

    return parseRolledMods(source as Record<string, unknown>[]).map((mod) => {
      const exact = rollToExact(mod, percent, itemLevel, index.shapeOf(mod.statId), bal);
      const name = statName(snapshot, mod.statId);
      const suffix = mod.type === "PERCENT" ? `% Increased ${name}` : mod.type === "MORE" ? `% More ${name}` : ` ${name}`;
      return `${exact.value >= 0 ? "+" : ""}${smart(exact.value)}${suffix}`;
    });
  }, [snapshot, mods, statPercent, affixRoll, itemLevel]);

  if (lines.length === 0) {
    return (
      <div className="faint text-sm" style={{ paddingLeft: 8 }}>
        no stats
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: 8 }}>
      {lines.map((line, index) => (
        <div key={index} className="text-sm" style={{ color: "var(--good)" }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export { omenName, omenWord };
