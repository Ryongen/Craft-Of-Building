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
 * The other thing worth making visible is that **nothing on an omen is rolled**. There is no
 * slider anywhere here because there is nothing to slide: `OmenData.getStatPercent` derives one
 * percent from how hard the omen is to satisfy, and every stat the omen grants resolves at it —
 * its own mods and its corruption affixes alike, since `OmenBlueprint` writes that same number
 * into each `AffixData.p` instead of drawing from the tier's band. So editing the requirements
 * *is* editing the payout, and it is the only thing that is. The header prints the derived
 * number and flags it when it exceeds 100, which the game does not clamp.
 *
 * The affix rows had a tier dropdown and a roll slider, which is the gear editor's shape and
 * the wrong one: both fields are the omen's, not the affix's, and a slider offering 86..100 on
 * a mythic omen whose real percent is 125 was offering numbers the game cannot produce. They
 * are shown as derived now, and {@link syncAffixes} rewrites what the document stores whenever
 * a requirement or the rarity moves, the way `UpgradeOmenRarityItemMod` does.
 */

import { balance, parseRolledMods, rollToExact, statIndex } from "@cte2/engine";
import {
  CATEGORY,
  GEAR_RARITY_TYPES,
  affix,
  affixName,
  countOmenPieces,
  ids,
  omenAffixRoll,
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
import type { Snapshot } from "@cte2/extractor";
import { useMemo, type ReactNode } from "react";

import { applyPatch, type Patch } from "../../state/patch.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField, smart } from "../../ui/fields.js";
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
  //
  // Every edit goes through `syncAffixes`, because three of the fields on this form are inputs
  // to what the affixes store.
  const patch = (next: Patch<OmenSetup>): void =>
    onChange(syncAffixes(snapshot, applyPatch(omen, next)));

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
      <OmenAffixes omen={omen} view={view} percent={percent} patch={patch} />

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
                statPercent={bucket.statPercent}
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

/**
 * Rewrite every stored affix tier and roll from the omen they belong to.
 *
 * `UpgradeOmenRarityItemMod` is the precedent and says why this is not tidying:
 *
 *     omen.rar = newRar.GUID();
 *     int newPerc = OmenData.getStatPercent(omen.rarities, omen.slot_req, newRar);
 *     for (AffixData aff : omen.aff) {
 *         aff.rar = newRar.GUID();
 *         aff.p = newPerc;
 *     }
 *
 * The rarity and the requirements are not properties of the omen that its affixes happen to
 * sit beside — they are the two things those affixes are computed from, and the game rewrites
 * the stored copies the moment either moves. `omenBuckets` re-derives regardless, so nothing
 * the planner shows depends on this; what it buys is that the saved document, and anything
 * reading it later, says the same thing the game would have saved.
 */
function syncAffixes(snapshot: Snapshot, setup: OmenSetup): OmenSetup {
  const affixes = setup.affixes;
  if (affixes === undefined || affixes.length === 0) return setup;
  const percent = omenStatPercent(
    snapshot,
    setup.requires,
    (setup.slotRequirements ?? []).length,
    setup.rarity,
  );
  return { ...setup, affixes: affixes.map((roll) => omenAffixRoll(roll, setup, percent)) };
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
 *
 * The only thing the player chooses about one of these is **which affix it is**. Its tier is
 * the omen's rarity and its magnitude is the omen's derived percent, so both are printed
 * rather than offered.
 */
function OmenAffixes({
  omen,
  view,
  percent,
  patch,
}: {
  omen: OmenSetup;
  view: ReturnType<typeof omenView>;
  /** The derived `getStatPercent`, which is also every affix's roll. */
  percent: number;
  patch: (next: Patch<OmenSetup>) => void;
}): ReactNode {
  const { snapshot } = useWorld();
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

  const update = (next: AffixRoll[]): void =>
    patch({ affixes: next.length === 0 ? undefined : next });

  return (
    <>
      <div className="section-title">
        Corruption affixes <span className="faint">({affixes.length} — each unlocks one piece earlier)</span>
      </div>
      {affixes.map((roll, index) => (
        <div key={index} className="row mb-2">
          <Picker
            options={options}
            value={roll.affixId}
            onChange={(id) =>
              id !== undefined && update(affixes.map((r, i) => (i === index ? { ...r, affixId: id } : r)))
            }
            width={200}
          />
          {/* Both of these were controls. `adata.rar = rar.GUID()` and
              `adata.p = OmenData.getStatPercent(...)` — the omen fills them in, so the row
              reports them and the two omen fields above are where they are changed. */}
          <span className="badge" title="AffixData.rar — an omen's affix takes the omen's rarity">
            {omen.rarity}
          </span>
          <span className="badge" title="AffixData.p — the same derived percent as the omen's own mods">
            at {percent}%
          </span>
          <div className="grow" />
          <button onClick={() => update(affixes.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}
      {/* `pool[0]` was whichever affix the registry ordered first. The tier and roll it arrives
          with are not a starting point to adjust — they are the only ones the affix can have,
          so they come from the omen rather than from literals that assumed a rarity called
          `common` and a band starting at 0. */}
      <AddPicker
        label="Add affix"
        placeholder="Which corruption?"
        options={options}
        width={240}
        onAdd={(affixId) =>
          update([...affixes, omenAffixRoll({ affixId, rollPercent: percent }, omen, percent)])
        }
      />
    </>
  );
}

/**
 * One bucket's stats, resolved through the engine so they match the sheet.
 *
 * Both kinds of bucket resolve at the same `statPercent`, because an omen has one percent:
 * `OmenSet` maps its own mods through `ToExactStat(perc, lvl)` and each affix through
 * `GetAllStats(lvl)`, whose `p` the blueprint set to that same `perc`.
 */
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

    return parseRolledMods(source as Record<string, unknown>[]).map((mod) => {
      const exact = rollToExact(mod, statPercent, itemLevel, index.shapeOf(mod.statId), bal);
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
