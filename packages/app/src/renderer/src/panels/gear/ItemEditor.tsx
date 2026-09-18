/**
 * Building one item the way the game builds one.
 *
 * Every control's options come from `@cte2/schema`'s `queries.ts` — the same module the
 * validator reads its rules from — so the editor cannot offer something the validator will
 * then reject, and neither can drift from the other.
 *
 * Three rules that look wrong until you read the Java they were ported from:
 *
 *  - `min_affixes` is an **exact** count, not a floor: common 1 through mythic 6.
 *  - the per-type ceiling is the **rounded-up** half, so legendary is 3 prefixes / 2 suffixes
 *    even though `maximumOfOneAffixType()` reports 2.
 *  - an affix carries **its own tier**, which is not the item's, and the roll band comes from
 *    that tier. A mythic item can hold a common-tier affix rolling 0–17%; never the reverse.
 *
 * ## Rolls are shown at the item's level, and are editable as the number you can see
 *
 * `modifierLine` is a display helper over the *un-levelled* data, which made the editor show
 * numbers no tooltip in the game ever prints — a `+2 to +4` affix reads `+3` here and `+147`
 * on the item, because everything on an item scales at the item's level. The lines below run
 * the engine's own `rollToExact` instead, so a stat line here is the number the character
 * sheet will use and can be typed in directly. Reading a roll *percent* off an item is
 * something no player can do; reading the value is the only thing they can do.
 *
 * ## Uniques are offered whatever the base is
 *
 * A player choosing Honourhome wants Honourhome, not "a chainmail helmet, and now narrow the
 * unique list to what fits it". So the picker lists every unique in the pack and selecting one
 * *moves the item to it*: `UniqueGear.base_gear` becomes the base and the unique rarity becomes
 * the rarity, because those are not independent choices — `validateUnique` rejects every other
 * combination, so offering them would only be offering a way to be wrong.
 */

import type { Snapshot } from "@cte2/extractor";
import { checkRequirements } from "@cte2/engine";
import {
  affix,
  affixCount,
  affixName,
  allUniques,
  allowedAffixTiers,
  baseGearType,
  gearTypeName,
  gem,
  gemName,
  isTwoHanded,
  enchantCompats,
  enchantName,
  maxOfOneAffixType,
  modifierLine,
  rune,
  runeName,
  runeword,
  runewordMatches,
  runewordName,
  runewordsForItem,
  slotFamily,
  socketFamilyOfBase,
  statName,
  statsForFamily,
  unique as uniqueView,
  uniqueName,
  uniqueRarityId,
  type AffixRoll,
  type AffixType,
  type EnchantCompatView,
  type Item,
  type RunewordView,
  type SocketFamily,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { applyPatch, type Patch } from "../../state/patch.js";
import { useWorld } from "../../state/snapshot.js";
import {
  BAND_ENDS,
  NumberField,
  RollSlider,
  bandEnd,
  smart,
  type BandEnd,
} from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { modDetail, modKeywords } from "../../ui/mods.js";
import { StatLines } from "../../ui/StatLines.js";


/**
 * What the character needs before this piece goes on, with what they have beside it.
 *
 * `GearItemData.canPlayerWear` refuses the equip outright, so an unwearable item never reaches
 * the stat calculation in game. This deliberately does **not** do that: a planner whose answer
 * to "what if I wore this" is to silently drop the item is answering a different question. The
 * stats stay in and the shortfall is named in red, which is also what the game's own tooltip
 * does with `getReqDifference` before you pick the thing up.
 *
 * Both numbers are the item's rather than the character's: `meetsReq(this.getLevel(), data)`
 * passes the **item** level, so a level 40 axe asks for 32 strength whoever is holding it.
 */
function Requirements({ item }: { item: Item }): ReactNode {
  const { snapshot } = useWorld();
  const stats = useDerived().stats;
  const level = useBuild((s) => s.doc.character.level);

  const checks = useMemo(
    () => checkRequirements(snapshot, item, stats),
    [snapshot, item, stats],
  );
  // The other half of `canPlayerWear`, and the one people meet first.
  const overLevel = item.itemLevel > level;
  if (checks.length === 0 && !overLevel) return null;

  const short = checks.filter((c) => !c.met);

  return (
    <div className="row wrap gap-5 mb-4">
      <span className="faint text-sm">
        Requires
      </span>
      {overLevel && (
        <span
          className="badge bad"
          title={`GearItemData.canPlayerWear: \`if (this.getLevel() > data.getLevel()) return false\`. This item is level ${item.itemLevel} and the character is ${level}.`}
        >
          character level {item.itemLevel}
        </span>
      )}
      {checks.map((check) => (
        <span
          key={check.statId}
          className={check.met ? "badge" : "badge bad"}
          title={
            `${statName(snapshot, check.statId)} ${smart(check.have)} of ${check.required}` +
            (check.scaled
              ? `\nScaled to the item's level (${item.itemLevel}) through STAT_REQ_SCALING.`
              : "\nA flat requirement — it does not scale with level.") +
            (check.met ? "" : `\nShort by ${smart(check.required - check.have)}.`)
          }
        >
          {check.met ? "\u2714" : "\u2718"} {statName(snapshot, check.statId)} {check.required}
          <span className="faint"> (have {Math.floor(check.have)})</span>
        </span>
      ))}
      {short.length > 0 && (
        <span className="faint text-sm">
          unmet — the game would refuse the equip; these stats are still counted here
        </span>
      )}
    </div>
  );
}

type AffixGroup = {
  key: "implicits" | "prefixes" | "suffixes" | "corruptions";
  type: AffixType;
  label: string;
};

/**
 * The affix lists every item carries, unique or not.
 *
 * A unique is not exempt from these. `GearCreationUtils.CreateData` rolls the unique's own
 * stats and then runs `gear.baseStats.RerollFully(gear)` and `gear.imp.RerollFully(gear)` on
 * the same item (GearCreationUtils.java:74-76), so a unique has base stats and an implicit
 * exactly like a rare does — in game, Honourhome shows "+135 Armor / +270 Magic Shield" and an
 * "Implicit Stats: +7% Health Regen" block. Hiding these on uniques made those stats
 * unreachable in a build, not merely unset.
 */
const COMMON_AFFIX_GROUPS: AffixGroup[] = [
  { key: "implicits", type: "implicit", label: "Implicits" },
  { key: "corruptions", type: "chaos_stat", label: "Corruptions" },
];

/** Prefixes and suffixes, which a unique carries `unique_stats` instead of. */
const ROLLED_AFFIX_GROUPS: AffixGroup[] = [
  { key: "prefixes", type: "prefix", label: "Prefixes" },
  { key: "suffixes", type: "suffix", label: "Suffixes" },
];

/**
 * What quality does, in the one place a player can ask.
 *
 * It is worth spelling out because the number is *not* a multiplier and does not touch affixes:
 * `BaseStatsData.GetAllStats` does `int p = (int) (this.p + gear.getQualityBaseStatsBonus(stack))`
 * and nothing else reads it, so 20 quality is 20 percentage points on the base stat roll and
 * exactly zero on everything else the item carries.
 */
const QUALITY_TITLE =
  "CustomItemData.KEYS.QUALITY — added to the base stat roll percent, and only that: " +
  "`int p = (int) (this.p + gear.getQualityBaseStatsBonus(stack))` in BaseStatsData.GetAllStats. " +
  "Affixes, implicits, runes and sockets are untouched.";

export function ItemEditor({
  item,
  slotId,
  onChange,
  onRemove,
}: {
  item: Item;
  slotId: string;
  onChange: (item: Item) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;

  const bases = world.basesFor(slotId);
  const base = baseGearType(snapshot, item.base);
  const rarity = world.rarity(item.rarity);
  // Every unique in the pack, not just this base's. Picking one moves the item to it.
  const uniques = useMemo(() => allUniques(snapshot), [snapshot]);

  const baseOptions = useMemo<PickerOption[]>(
    () => bases.map((b) => ({ id: b.id, label: gearTypeName(snapshot, b.id), keywords: b.tags.join(" ") })),
    [bases, snapshot],
  );

  const uniqueOptions = useMemo<PickerOption[]>(
    () =>
      uniques.map((u) => {
        // What the unique actually grants, for the hover. A player knows Honourhome by name and
        // by what it does; the base it happens to sit on is a consequence of picking it, not
        // the thing being picked, which is why that stays a dim hint and the id stays off the
        // row entirely.
        const detail = modDetail(snapshot, u.uniqueStats);
        return {
          id: u.id,
          label: uniqueName(snapshot, u.id),
          // The base is a consequence of the choice rather than a filter on it, so name it in
          // the hint — picking one is going to change the item's base out from under you.
          hint: `${u.baseGear === undefined ? "?" : gearTypeName(snapshot, u.baseGear)} · lvl ${u.minDropLvl}`,
          keywords: `${u.id} ${u.baseGear ?? ""}`,
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    [uniques, snapshot],
  );

  const tierOptions = useMemo(
    () => (rarity === undefined ? [] : allowedAffixTiers(snapshot, rarity)),
    [snapshot, rarity],
  );

  const patch = (next: Patch<Item>): void => {
    const merged = applyPatch(item, next);
    // Empty arrays go too: a hand-authored document says nothing rather than `"runes": []`.
    for (const key of Object.keys(merged) as (keyof Item)[]) {
      const value = merged[key];
      if (Array.isArray(value) && value.length === 0) delete merged[key];
    }
    onChange(merged);
  };

  const isUnique = item.unique !== undefined;
  const expectedAffixes = rarity === undefined ? 0 : affixCount(rarity);
  const perTypeMax = rarity === undefined ? 0 : maxOfOneAffixType(rarity);
  const actualAffixes = (item.prefixes?.length ?? 0) + (item.suffixes?.length ?? 0);

  /**
   * Top the item up to the affix count its rarity demands.
   *
   * Affixes are taken off the pool in order and never repeated — the same affix twice is an item
   * the game will not roll — and the per-type cap is honoured, which is what stops a four-affix
   * rare from becoming four prefixes.
   *
   * `at` is which end of the tier's band the new affixes arrive on. It used to be the floor and
   * nothing else, which made a filled item not merely unrolled but the *worst* version of itself
   * — and "what would this base look like at average rolls" is the question you fill an item to
   * answer.
   */
  const fillAffixes = (at: BandEnd): void => {
    const tier = tierOptions[0] ?? "common";
    const rollPercent = bandEnd(bandFor(world, tier), at);
    const next = {
      prefix: [...(item.prefixes ?? [])],
      suffix: [...(item.suffixes ?? [])],
    };

    let missing = expectedAffixes - actualAffixes;
    for (const type of ["prefix", "suffix"] as const) {
      if (missing <= 0) break;
      const taken = new Set(next[type].map((roll) => roll.affixId));
      for (const affix of world.affixPool(item.base, type)) {
        if (missing <= 0 || next[type].length >= perTypeMax) break;
        if (taken.has(affix.id)) continue;
        next[type].push({ affixId: affix.id, tier, rollPercent });
        taken.add(affix.id);
        missing -= 1;
      }
    }

    patch({ prefixes: next.prefix, suffixes: next.suffix });
  };

  return (
    <div className="card">
      <div className="row wrap mb-4">
        <Picker
          options={baseOptions}
          value={item.base}
          onChange={(id) =>
            id !== undefined &&
            // Changing the base invalidates every roll: base stats, affix pools and tags all
            // move. Clearing is honest; silently keeping impossible affixes is not. Quality
            // rides along because it is not a roll and no pool bounds it — it is a number the
            // currency put on the stack, legal on any base.
            onChange({
              base: id,
              rarity: item.rarity,
              itemLevel: item.itemLevel,
              ...(item.quality === undefined ? {} : { quality: item.quality }),
            })
          }
          width={200}
        />

        <select
          value={item.rarity}
          onChange={(event) => patch({ rarity: event.target.value })}
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
            value={item.itemLevel}
            min={1}
            max={world.maxLevel}
            width={58}
            onChange={(itemLevel) => patch({ itemLevel })}
          />
        </div>

        {/*
          Quality is stored beside the item rather than on it (`CustomItemData.KEYS.QUALITY`,
          the short key `ql`), which is why it is up here with ilvl and not in a roll list. It
          is offered on every base, including the four that have no base stats for it to act on
          — the game lets you sharpen a ring too, and hiding the control is what made it look
          like the editor had no quality at all.
        */}
        <div className="field">
          <label title={QUALITY_TITLE}>quality</label>
          <NumberField
            value={item.quality ?? 0}
            min={0}
            max={world.maxQuality}
            width={58}
            onChange={(quality) => patch({ quality: quality === 0 ? undefined : quality })}
          />
          <span className="faint text-xs">%</span>
        </div>

        {/*
          Four bases in the pack have no `base_stats` at all — `ring`, `necklace`, `head` and
          `elytra` — and quality is the only item property whose entire effect is on that list.
          The currency applies happily and the tooltip prints "Quality: 12%", so an inert number
          is a thing a real item can carry; it just buys nothing, and silence here would read as
          the planner having missed it.
        */}
        {(item.quality ?? 0) > 0 && base !== undefined && base.baseStats.length === 0 && (
          <span
            className="badge warn"
            title={`\`${item.base}\` declares no base stats, and quality is added to the base stat roll and nowhere else.`}
          >
            no base stats — quality does nothing here
          </span>
        )}

        <div className="grow" />
        <button onClick={onRemove}>Remove</button>
      </div>

      {base === undefined && (
        <div className="notice">
          <code>{item.base}</code> is not a base in this snapshot.
        </div>
      )}

      {/* Everything on an item scales at the *item's* level, and an item above the character's
          level contributes nothing at all — both are the mod's rules, and both surprise people. */}
      {base !== undefined && (
        <div className="row wrap mb-4">
          {isTwoHanded(snapshot, base.id) && (
            <span
              className="badge warn"
              title={
                "Better Combat returns an empty offhand while a two-handed weapon is held " +
                "(PlayerEntityMixin.getEquippedStack_Pre), so an offhand item grants nothing at all."
              }
            >
              two-handed — no offhand
            </span>
          )}
          <span className="faint text-sm">
            {base.tags.join(", ")}
          </span>
        </div>
      )}

      <div className="row wrap mb-4">
        <label className="faint">Unique</label>
        <Picker
          options={uniqueOptions}
          value={item.unique}
          allowClear
          placeholder="any unique…"
          onChange={(id) => {
            if (id === undefined) {
              patch({ unique: undefined, uniqueRolls: undefined });
              return;
            }
            const view = uniqueView(snapshot, id);
            if (view === undefined) return;
            // A unique's base and rarity are not separate choices: `validateUnique` errors on
            // `unique-base-mismatch` and `unique-on-non-unique-rarity`, so the only legal
            // answer is to move the item wholesale. Affixes go because the base moved and the
            // pools with it; prefixes and suffixes go because a unique carries `unique_stats`
            // instead, and mixing the two describes an item the game cannot make.
            onChange({
              base: view.baseGear ?? item.base,
              rarity: uniqueRarityId(snapshot, view) ?? item.rarity,
              // `min_drop_lvl` is a floor, not the level — keep the item's own where it is
              // already legal, and raise it to the floor where it is not.
              itemLevel: Math.max(item.itemLevel, view.minDropLvl),
              unique: id,
              // Quality survives for the same reason it survives a base change: no rule ties it
              // to the base or the rarity, and a unique has base stats for it to act on.
              ...(item.quality === undefined ? {} : { quality: item.quality }),
            });
          }}
          width={260}
        />
        {item.unique !== undefined && (
          <span className="faint text-sm">
            base and rarity follow the unique
          </span>
        )}
      </div>

      <Requirements item={item} />

      {isUnique && <UniqueRolls item={item} patch={patch} />}

      <BaseRolls item={item} patch={patch} />

      {!isUnique && rarity !== undefined && (
        <div className="row" style={{ margin: "10px 0 4px" }}>
          <span className="faint">
            {actualAffixes} of {expectedAffixes} affixes
          </span>
          {/*
            One message used to cover both directions. It fired on `!==` and read "{rarity} is
            exactly N, not a minimum" — which is the correction for an item carrying *too many*
            affixes, shown to someone who had too few. Two conditions, two sentences.
          */}
          {actualAffixes < expectedAffixes && (
            <span className="badge bad">
              {expectedAffixes - actualAffixes} short — a {rarity.id} rolls exactly{" "}
              {expectedAffixes}
            </span>
          )}
          {actualAffixes > expectedAffixes && (
            <span className="badge bad">
              {actualAffixes - expectedAffixes} too many — {expectedAffixes} is exact, not a minimum
            </span>
          )}
          <span className="faint">· max {perTypeMax} of one type</span>
          {/*
            The editor already knew the number it wanted and already warned when you had not
            reached it; it just made you get there one picker at a time. Filling is the same
            arithmetic the warning is: prefixes first up to the per-type cap, then suffixes.

            Each is added at its band *minimum*, deliberately — a filled item is a starting point
            to roll from rather than a claim about what you own, and the `min`/`avg`/`max`
            buttons on each list are one more click away.
          */}
          {actualAffixes < expectedAffixes && (
            <>
              <span className="faint text-sm" style={{ marginLeft: 6 }}>
                fill to {expectedAffixes} at
              </span>
              {BAND_ENDS.map((end) => (
                <button
                  key={end}
                  className="nudge word"
                  title={`Add ${expectedAffixes - actualAffixes} more affix(es) at the ${end} of their band`}
                  onClick={() => fillAffixes(end)}
                >
                  {end}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <RollEverything item={item} patch={patch} />

      {(isUnique ? COMMON_AFFIX_GROUPS : [...COMMON_AFFIX_GROUPS, ...ROLLED_AFFIX_GROUPS]).map(
        (group) => (
          <AffixList
            key={group.key}
            label={group.label}
            type={group.type}
            baseId={item.base}
            itemLevel={item.itemLevel}
            tiers={tierOptions}
            rolls={item[group.key] ?? []}
            max={group.key === "prefixes" || group.key === "suffixes" ? perTypeMax : undefined}
            onChange={(rolls) => patch({ [group.key]: rolls } as Patch<Item>)}
          />
        ),
      )}

      {!isUnique && (
        <AffixList
          label="Enchant"
          type="enchant"
          baseId={item.base}
          itemLevel={item.itemLevel}
          tiers={tierOptions}
          rolls={item.enchant === undefined ? [] : [item.enchant]}
          max={1}
          onChange={(rolls) => patch({ enchant: rolls[0] })}
        />
      )}

      <Enchantments item={item} patch={patch} />

      <Sockets item={item} patch={patch} />
    </div>
  );
}

/**
 * Vanilla enchantments, and the Mine and Slash stats the pack converts them into.
 *
 * This is `mmorpg_stat_compat`'s enchantment half, which the engine has implemented in full —
 * `getEnchantCompatResult`, both clamps — and which nothing in the app could reach, because
 * `Item.enchantments` had no control anywhere. The schema carried it, the companion mod
 * exported it, and a build entered by hand could not say that the chestplate has Protection IV.
 * 27 of the pack's 72 compat entries are enchantments, so that was not a small corner.
 *
 * ## What the numbers beside each row mean
 *
 * `conversion` per level, then **two** clamps, and they are different limits:
 *
 *  - `per_item_min/max` bounds what *this piece* may contribute. Protection is 2 per level
 *    capped at 12, so a single piece stops paying after Protection VI.
 *  - `minimum_cap/maximum_cap` bounds the **total over every equipped piece**, and that one is
 *    not this editor's to show: it depends on the rest of the character, so the row prints what
 *    this item is worth and the stat sheet holds the sum. Protection IV on four pieces and
 *    Protection XVI on one are genuinely different numbers, which is exactly why the clamps are
 *    not collapsed into one.
 *
 * Levels are not bounded by vanilla's maximum. An enchantment above its natural cap is an
 * ordinary thing to own in a modded pack, `getEnchantmentLevel` returns whatever is on the
 * stack, and the per-item clamp is what actually stops it mattering — so the field refuses
 * only what the game refuses, which is a level below 1.
 */
function Enchantments({
  item,
  patch,
}: {
  item: Item;
  patch: (next: Patch<Item>) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const compats = useMemo(() => enchantCompats(snapshot), [snapshot]);
  const byEnchant = useMemo(
    () => new Map(compats.map((c) => [c.enchantId, c])),
    [compats],
  );

  const on = Object.entries(item.enchantments ?? {});

  const set = (enchantId: string, level: number | undefined): void => {
    const next: Record<string, number> = { ...(item.enchantments ?? {}) };
    if (level === undefined) delete next[enchantId];
    else next[enchantId] = level;
    // An empty map is written as no map at all, the way every other list on an item is —
    // `"enchantments": {}` is not what a hand-authored document looks like.
    patch({ enchantments: Object.keys(next).length === 0 ? undefined : next });
  };

  const options = useMemo<PickerOption[]>(
    () =>
      compats.map((c) => ({
        id: c.enchantId,
        label: enchantName(c.enchantId),
        hint: statName(snapshot, c.statId),
        keywords: `${c.enchantId} ${c.statId} ${statName(snapshot, c.statId)}`,
        detail: enchantEffect(snapshot, c),
      })),
    [compats, snapshot],
  );

  return (
    <>
      <div className="section-title">
        Enchantments <span className="faint">({on.length})</span>
      </div>

      {on.map(([enchantId, level]) => {
        const compat = byEnchant.get(enchantId);
        return (
          <div className="row mb-3" key={enchantId}>
            <span style={{ width: 190 }} className="ellipsis" title={enchantId}>
              {enchantName(enchantId)}
            </span>
            <NumberField
              value={level}
              min={1}
              width={58}
              onChange={(next) => set(enchantId, next)}
            />
            {compat === undefined ? (
              <span
                className="badge warn"
                title={
                  "No `mmorpg_stat_compat` entry in this snapshot names this enchantment, so it " +
                  "converts into no stat at all. That is a legal thing to have on an item — most " +
                  "enchantments in the game convert into nothing — it simply changes no figure here."
                }
              >
                converts to nothing
              </span>
            ) : (
              <span className="faint text-sm">{enchantEffect(snapshot, compat, level)}</span>
            )}
            <div className="grow" />
            <button onClick={() => set(enchantId, undefined)}>✕</button>
          </div>
        );
      })}

      <AddPicker
        label="Add enchantment"
        placeholder="Which enchantment?"
        options={options.filter((o) => item.enchantments?.[o.id] === undefined)}
        width={280}
        onAdd={(enchantId) => set(enchantId, 1)}
      />
    </>
  );
}

/**
 * What one enchantment on *this piece* is worth, at a level or per level.
 *
 * The per-item clamp is applied and the total clamp deliberately is not: the second one is a
 * property of the whole equipped set, so quoting it beside one item would promise a number the
 * character may not get. `Math.trunc` rather than rounding, because the Java truncates —
 * `(int) (enchlvl * conversion)` — and a conversion of 0.5 at level 3 is 1, not 2.
 */
function enchantEffect(
  snapshot: Snapshot,
  compat: EnchantCompatView,
  level?: number,
): string {
  const name = statName(snapshot, compat.statId);
  const suffix = compat.modType === "PERCENT" ? "% increased" : compat.modType === "MORE" ? "% more" : "";
  if (level === undefined) {
    return `${compat.conversion > 0 ? "+" : ""}${smart(compat.conversion)}${suffix} ${name} per level` +
      ` (this piece caps at ${smart(compat.perItem.max)})`;
  }
  const raw = Math.trunc(level * compat.conversion);
  const clamped = Math.min(Math.max(raw, compat.perItem.min), compat.perItem.max);
  return `${clamped > 0 ? "+" : ""}${smart(clamped)}${suffix} ${name}${
    clamped !== raw ? ` (capped from ${smart(raw)} by this piece's limit)` : ""
  }`;
}

/**
 * Every roll on the item, in one click.
 *
 * The affix lists each grew a `roll all` of their own, which is the right control when you are
 * working on one list. It is the wrong one for the question this editor is actually asked:
 * *what is this base worth at perfect rolls* — answering that meant pressing `max` on the
 * implicits, the corruptions, the prefixes, the suffixes, each rune, the runeword, and dragging
 * every base stat by hand, which is six controls and a slider per base stat.
 *
 * Every band is the one that roll is actually bounded by, never a flat 0-100:
 *
 *  - base stats by the **rarity's** `base_stat_percents`, which is why a unique never rolls below
 *    75 and setting one to 0 would describe an item the game cannot produce;
 *  - each affix by **its own tier's** `stat_percents`, which is not the item's rarity and not the
 *    same band as its neighbour's — that is the whole reason this cannot be "set everything to
 *    100";
 *  - implicits, unique stats, runes and the runeword by 0-100, which is genuinely their range —
 *    `ImplicitStatsData` is the one gear part that does not override `getMinMax`, and
 *    `GearSocketsData.setRuneword` rolls `new MinMax(0, 100)`.
 *
 * One `patch` for the lot, so it is one undo step rather than fourteen.
 */
function RollEverything({
  item,
  patch,
}: {
  item: Item;
  patch: (next: Patch<Item>) => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const base = baseGearType(snapshot, item.base);
  const rarity = world.rarity(item.rarity);
  const unique = item.unique === undefined ? undefined : uniqueView(snapshot, item.unique);

  const baseBand = rarity?.baseStatPercents ?? { min: 0, max: 100 };
  const FULL = { min: 0, max: 100 };

  const rollList = (rolls: AffixRoll[] | undefined, at: BandEnd): AffixRoll[] | undefined =>
    rolls === undefined
      ? undefined
      : rolls.map((roll) => ({
          ...roll,
          // A tierless roll is an implicit, whose band is the full range rather than a tier's.
          rollPercent: bandEnd(roll.tier === undefined ? FULL : bandFor(world, roll.tier), at),
        }));

  const rollAll = (at: BandEnd): void => {
    const next: Patch<Item> = {};

    if (base !== undefined && base.baseStats.length > 0) {
      next.baseRolls = base.baseStats.map(() => bandEnd(baseBand, at));
    }
    for (const key of ["implicits", "prefixes", "suffixes", "corruptions"] as const) {
      const rolled = rollList(item[key], at);
      if (rolled !== undefined) next[key] = rolled;
    }
    if (item.enchant !== undefined) next.enchant = rollList([item.enchant], at)?.[0];
    if (unique !== undefined) {
      next.uniqueRolls = unique.uniqueStats.map(() => bandEnd(FULL, at));
    }
    if ((item.runes ?? []).length > 0) {
      next.runeRolls = (item.runes ?? []).map(() => bandEnd(FULL, at));
    }
    if (item.runeword !== undefined) next.runewordRoll = bandEnd(FULL, at);

    patch(next);
  };

  // Nothing to roll is not the same as everything already rolled, and a row of dead buttons over
  // an item with no rolls at all reads as broken.
  const rollable =
    (base?.baseStats.length ?? 0) > 0 ||
    unique !== undefined ||
    (item.runes ?? []).length > 0 ||
    item.runeword !== undefined ||
    (["implicits", "prefixes", "suffixes", "corruptions"] as const).some(
      (key) => (item[key] ?? []).length > 0,
    );
  if (!rollable) return null;

  return (
    <div className="row gap-3" style={{ margin: "6px 0 2px" }}>
      <span className="faint text-sm">roll this whole item at</span>
      {BAND_ENDS.map((end) => (
        <button
          key={end}
          className="nudge word"
          title={
            `Set every roll on this item — base stats, affixes, unique stats, runes and the ` +
            `runeword — to the ${end} of its own band. One undo step.`
          }
          onClick={() => rollAll(end)}
        >
          {end}
        </button>
      ))}
    </div>
  );
}

function BaseRolls({ item, patch }: { item: Item; patch: (next: Patch<Item>) => void }): ReactNode {
  const { snapshot, rarity: rarityOf } = useWorld();
  const base = baseGearType(snapshot, item.base);
  const rarity = rarityOf(item.rarity);
  if (base === undefined || base.baseStats.length === 0) return null;

  // An unset roll shows the band's floor, not 0: `BaseStatsData.getMinMax` bounds the base
  // roll by the rarity's `base_stat_percents`, so a unique never rolls below 75 and a slider
  // resting at 0 would describe an item the game cannot produce. The engine takes the same
  // floor when `baseRolls` is absent, so the two agree.
  const band = rarity?.baseStatPercents ?? { min: 0, max: 100 };
  const rolls = item.baseRolls ?? base.baseStats.map(() => band.min);

  /**
   * Quality is added to the roll before the band is resolved, and it is the *only* thing on the
   * item that behaves this way:
   *
   *     int p = (int) (this.p + gear.getQualityBaseStatsBonus(stack));
   *
   * — BaseStatsData.GetAllStats. So the slider keeps showing the stored roll inside the rarity's
   * band, which is what the document holds and what `baseRolls` means, while the value beside it
   * is resolved at `roll + quality`, which is what the character sheet uses. Showing the value at
   * the stored roll alone would print a number that appears nowhere in the game, and rolling
   * quality into `baseRolls` would lose the distinction the schema keeps them separate for.
   */
  const quality = item.quality ?? 0;
  const effective = { min: band.min + quality, max: band.max + quality };

  const setRoll = (index: number, value: number): void => {
    const next = [...rolls];
    while (next.length < base.baseStats.length) next.push(band.min);
    next[index] = value;
    patch({ baseRolls: next });
  };

  return (
    <>
      <div className="section-title">
        Base stats <span className="faint">(band {band.min}–{band.max}%)</span>
        {quality > 0 && (
          <span className="faint" title={QUALITY_TITLE}>
            {" "}
            +{quality}% quality → {effective.min}–{effective.max}%
          </span>
        )}
      </div>
      {base.baseStats.map((mod, index) => {
        const roll = rolls[index] ?? band.min;
        return (
          <div key={index} className="mb-2">
            <div className="row">
              <RollSlider
                value={roll}
                min={band.min}
                max={band.max}
                ends
                onChange={(value) => setRoll(index, value)}
              />
            </div>
            <StatLines
              mods={[mod]}
              rollPercent={roll + quality}
              band={effective}
              itemLevel={item.itemLevel}
              // `ValueField` solves the typed value back to a percent in the band it was given,
              // which is the quality-inclusive one — so the stored roll is that answer less the
              // quality the player did not roll for.
              onRoll={(value) => setRoll(index, value - quality)}
            />
          </div>
        );
      })}
    </>
  );
}

function UniqueRolls({ item, patch }: { item: Item; patch: (next: Patch<Item>) => void }): ReactNode {
  const { snapshot } = useWorld();
  // Look the unique up by id rather than through the base's list: the picker can set a unique
  // whose base is only just being applied, and a lookup keyed on the old base would miss it.
  const view = item.unique === undefined ? undefined : uniqueView(snapshot, item.unique);
  if (view === undefined) return null;

  const rolls = item.uniqueRolls ?? view.uniqueStats.map(() => 0);
  // `UniqueGearData` rolls its stats over the full range — there is no tier narrowing it, and
  // `unique.stat_percents` is 0-100 in this pack.
  const band = { min: 0, max: 100 };

  const setRoll = (index: number, value: number): void => {
    const next = [...rolls];
    while (next.length < view.uniqueStats.length) next.push(0);
    next[index] = value;
    patch({ uniqueRolls: next });
  };

  return (
    <>
      <div className="section-title">
        {uniqueName(snapshot, view.id)} <span className="faint">— unique stats</span>
      </div>
      {view.uniqueStats.map((mod, index) => {
        const roll = rolls[index] ?? 0;
        return (
          <div key={index} className="mb-2">
            <div className="row">
              <RollSlider
                value={roll}
                min={band.min}
                max={band.max}
                showBand={false}
                ends
                onChange={(value) => setRoll(index, value)}
              />
            </div>
            <StatLines
              mods={[mod]}
              rollPercent={roll}
              band={band}
              itemLevel={item.itemLevel}
              onRoll={(value) => setRoll(index, value)}
            />
          </div>
        );
      })}
    </>
  );
}

function AffixList({
  label,
  type,
  baseId,
  itemLevel,
  tiers,
  rolls,
  max,
  onChange,
}: {
  label: string;
  type: AffixType;
  baseId: string;
  /** Everything on an item resolves at the item's level, not the character's. */
  itemLevel: number;
  tiers: string[];
  rolls: AffixRoll[];
  max?: number | undefined;
  onChange: (rolls: AffixRoll[]) => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const pool = world.affixPool(baseId, type);

  /**
   * The pool, named by what it does rather than by what it is called in the data.
   *
   * `affixLabel` is the player-facing name — "of the Yeti" — and on its own it says nothing
   * about which of four cold suffixes this is. The hover carries the modifier lines at a top
   * roll, and the search corpus carries every stat id and stat name, so typing "resist" or
   * "bleed" narrows the list the way typing a name does.
   */
  const options = useMemo<PickerOption[]>(
    () =>
      pool.map((a) => {
        const detail = modDetail(snapshot, a.stats);
        return {
          id: a.id,
          label: affixLabel(snapshot, a.id),
          keywords: modKeywords(snapshot, a.stats),
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    [pool, snapshot],
  );

  const defaultTier = tiers[0] ?? "common";

  return (
    <>
      <div className="section-title">
        {label} <span className="faint">({rolls.length}{max !== undefined ? ` / ${max}` : ""})</span>
      </div>

      {rolls.map((roll, index) => (
        <AffixRow
          key={`${roll.affixId}-${index}`}
          roll={roll}
          options={options}
          itemLevel={itemLevel}
          tiers={tiers}
          tiered={type !== "implicit"}
          onChange={(next) => onChange(rolls.map((r, i) => (i === index ? next : r)))}
          onRemove={() => onChange(rolls.filter((_, i) => i !== index))}
        />
      ))}

      <div className="row wrap gap-3">
        {/* This was `pool[0]` — whichever affix the registry happened to order first, added
            silently. `ui/AddPicker` is the fix; the new roll still starts at the band floor, and
            the three buttons beside it are how you move it. */}
        <AddPicker
          label={`Add ${label.toLowerCase().replace(/e?s$/, "")}`}
          placeholder={`Which ${type}?`}
          options={options}
          width={280}
          disabled={pool.length === 0 || (max !== undefined && rolls.length >= max)}
          {...(pool.length === 0 ? { title: `No ${type} can roll on this base` } : {})}
          onAdd={(affixId) =>
            onChange([
              ...rolls,
              type === "implicit"
                ? { affixId, rollPercent: 0 }
                : { affixId, tier: defaultTier, rollPercent: bandFor(world, defaultTier).min },
            ])
          }
        />

        {/*
          Every affix in this list at once. Building a level-94 rare by hand meant dragging a
          slider per affix, and the editor starts every one of them at its band minimum — so the
          default item was not merely unrolled, it was the worst possible version of itself.

          The band is the tier's, not 0-100: `bandFor` is what bounds a roll on a tiered affix,
          and setting 100 on a tier whose band tops out at 70 is an item the game cannot produce.

          `bandEnd` rather than a local midpoint: `RollEverything` and each row's own buttons set
          rolls the same way, and three ideas of what "average" means is three items.
        */}
        {rolls.length > 0 && (
          <>
            <span className="faint text-sm" style={{ alignSelf: "center" }}>
              roll all
            </span>
            {BAND_ENDS.map((end) => (
              <button
                key={end}
                className="nudge word"
                title={`Set every ${label.toLowerCase().replace(/e?s$/, "")} on this item to the ${end} of its tier's band`}
                onClick={() =>
                  onChange(
                    rolls.map((roll) => ({
                      ...roll,
                      rollPercent: bandEnd(
                        roll.tier === undefined ? { min: 0, max: 100 } : bandFor(world, roll.tier),
                        end,
                      ),
                    })),
                  )
                }
              >
                {end}
              </button>
            ))}
          </>
        )}
      </div>
      {pool.length === 0 && (
        <span className="faint text-sm" style={{ marginLeft: 8 }}>
          no {type} can roll on this base
        </span>
      )}
    </>
  );
}

function AffixRow({
  roll,
  options,
  itemLevel,
  tiers,
  tiered,
  onChange,
  onRemove,
}: {
  roll: AffixRoll;
  options: PickerOption[];
  itemLevel: number;
  tiers: string[];
  /** False for implicits, the one affix the game stores without a tier. */
  tiered: boolean;
  onChange: (roll: AffixRoll) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const view = affix(snapshot, roll.affixId);
  const band = bandFor(world, roll.tier);

  /**
   * Every roll this affix could have on this item, across all the tiers its rarity allows.
   *
   * The *slider* stays bounded by the tier it is set to, because dragging is how you move a
   * roll within a tier and a slider that silently re-tiered under the cursor would be a trap.
   * Typing a **value** is the opposite question — "my item says +47 Armor" — and the tier is
   * part of the answer rather than a constraint on it. So the box reaches the whole ladder and
   * `tierFor` works out which rung the number landed on.
   *
   * The six bands tile 0-100 without overlapping (common 0-17 through mythic 86-100), so a roll
   * percent names exactly one tier and there is nothing to disambiguate.
   */
  const reachable = useMemo(() => {
    if (!tiered || tiers.length === 0) return band;
    const bands = tiers.map((tier) => bandFor(world, tier));
    return {
      min: Math.min(...bands.map((b) => b.min)),
      max: Math.max(...bands.map((b) => b.max)),
    };
  }, [tiered, tiers, world, band]);

  /** The allowed tier whose band holds this roll, or the current one when none does. */
  const tierFor = (rollPercent: number): string | undefined => {
    if (!tiered) return roll.tier;
    const found = tiers.find((tier) => {
      const b = bandFor(world, tier);
      return rollPercent >= b.min && rollPercent <= b.max;
    });
    return found ?? roll.tier;
  };

  return (
    <div className="mb-3">
      <div className="row">
        <Picker
          options={options}
          value={roll.affixId}
          onChange={(id) => id !== undefined && onChange({ ...roll, affixId: id })}
          width={230}
        />
        {tiered && (
          <select
            value={roll.tier ?? tiers[0] ?? "common"}
            onChange={(event) => {
              const tier = event.target.value;
              const next = bandFor(world, tier);
              // The band moves with the tier and they never overlap, so a roll kept across a
              // tier change would always be out of band. Clamp instead of leaving it illegal.
              onChange({
                ...roll,
                tier,
                rollPercent: Math.min(Math.max(roll.rollPercent, next.min), next.max),
              });
            }}
            title="The affix's own tier, which is not the item's — the roll band comes from this"
          >
            {tiers.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        )}
        <RollSlider
          value={roll.rollPercent}
          min={band.min}
          max={band.max}
          ends
          onChange={(rollPercent) => onChange({ ...roll, rollPercent })}
        />
        <button onClick={onRemove}>✕</button>
      </div>
      {view !== undefined && (
        <StatLines
          mods={view.stats}
          rollPercent={roll.rollPercent}
          band={reachable}
          itemLevel={itemLevel}
          // Typing a value re-tiers as well as re-rolls, so reading a number off an item in
          // game and typing it in lands on the affix the game actually produced rather than
          // on the nearest thing the tier you happened to have selected could manage.
          onRoll={(rollPercent) => {
            const tier = tierFor(rollPercent);
            onChange({ ...roll, rollPercent, ...(tier === undefined ? {} : { tier }) });
          }}
        />
      )}
    </div>
  );
}

/**
 * Gems, runes and the runeword the runes spell.
 *
 * Four rules the previous version of this got wrong, all of them from `GearSocketsData` and the
 * two currency items that fill it:
 *
 *  - **gems and runes share one list.** `GearSocketsData.so` holds both and `getEmptySockets()`
 *    is `getTotalSockets() - getSocketedGemsCount()` over the pair, so `sockets.max` is a budget
 *    for the two together. Two separate caps let an item hold twice what it has room for.
 *  - **runed gear takes no gems at all.** `max_gems` on the `runeword` rarity is 0, and
 *    `GemItem.canBeModified` reads that as an outright refusal (RARITY_CANT_HAVE_ANY_GEMS)
 *    rather than as a cap — which is the whole trade a runed base makes.
 *  - **runes and runewords roll.** `SocketData.p` per rune and `GearSocketsData.rp` once for the
 *    runeword, both `new MinMax(0, 100).random()`. The document has carried both fields for a
 *    while and the editor offered neither, so every one of them sat at its floor.
 *  - **a runeword is what the runes spell**, not a label. Picking one from the list fills the
 *    runes in, because that is the only way to get one in game: you insert runes and the game
 *    hands you the longest runeword they complete.
 */
function Sockets({ item, patch }: { item: Item; patch: (next: Patch<Item>) => void }): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const rarity = world.rarity(item.rarity);

  const sockets = item.sockets ?? [];
  const runes = item.runes ?? [];
  const runeRolls = item.runeRolls ?? [];
  // `Gem.getFor(fam)` / `Rune.getFor(fam)`: an offhand takes the armour list, because `OffHand`
  // matches neither of the first two branches.
  const family = socketFamilyOfBase(snapshot, item.base);
  const slotId = baseGearType(snapshot, item.base)?.gearSlot;
  const isOffhand = slotId !== undefined && slotFamily(snapshot, slotId) === "OffHand";

  const gemOptions = useMemo<PickerOption[]>(
    () =>
      world.gemIds.map((id) => {
        const view = gem(snapshot, id);
        const lines = view === undefined ? [] : socketLines(snapshot, statsForFamily(view, family));
        return {
          id,
          label: gemName(snapshot, id),
          hint: lines.join(" · "),
          keywords: `${id} ${view?.gemType ?? ""}`,
        };
      }),
    [world.gemIds, snapshot, family],
  );

  const runeOptions = useMemo<PickerOption[]>(
    () =>
      world.runeIds.map((id) => {
        const view = rune(snapshot, id);
        const lines = view === undefined ? [] : socketLines(snapshot, statsForFamily(view, family));
        return {
          id,
          // A rune with no line for this family cannot be inserted at all — `Chats.NOT_FAMILY`.
          label:
            lines.length === 0
              ? `${runeName(snapshot, id)} — nothing for this slot`
              : runeName(snapshot, id),
          hint: lines.join(" · "),
          keywords: id,
        };
      }),
    [world.runeIds, snapshot, family],
  );

  const runewords = useMemo(
    () => runewordsForItem(snapshot, item.base, rarity),
    [snapshot, item.base, rarity],
  );

  if (rarity === undefined) return null;

  const filled = sockets.length + runes.length;
  const free = rarity.sockets.max - filled;
  const gemsAllowed = rarity.maxGems > 0;

  const setRuneRoll = (index: number, value: number): void => {
    const next = [...runeRolls];
    while (next.length < runes.length) next.push(0);
    next[index] = value;
    patch({ runeRolls: next });
  };

  /**
   * Taking a runeword fills its runes in, replacing whatever was there.
   *
   * `RuneItem` only ever sets a runeword as a *consequence* of the runes present, so a runeword
   * without its runes describes an item the game cannot make — and the validator says so. The
   * rolls go with them: a rune already socketed keeps the roll it had, and a new one starts at
   * its floor like every other unrecorded roll in this editor.
   */
  const applyRuneword = (id: string | undefined): void => {
    if (id === undefined) {
      patch({ runeword: undefined, runewordRoll: undefined });
      return;
    }
    const view = runeword(snapshot, id);
    if (view === undefined) return;
    const kept = view.runes.map((runeId) => {
      const at = runes.indexOf(runeId);
      return at === -1 ? 0 : runeRolls[at] ?? 0;
    });
    patch({ runeword: id, runes: view.runes, runeRolls: kept, runewordRoll: item.runewordRoll ?? 0 });
  };

  return (
    <>
      <div className="section-title">
        Sockets{" "}
        <span className="faint">
          ({filled} of {rarity.sockets.max} filled
          {gemsAllowed ? `, up to ${rarity.maxRunes} rune${rarity.maxRunes === 1 ? "" : "s"}` : ", runes only"})
        </span>
      </div>

      <div
        className="faint text-sm mb-3"
        title="GearSocketsData.so holds gems and runes in one list; getEmptySockets() subtracts the whole list."
      >
        Gems and runes share the same sockets. This slot reads each socketable&apos;s{" "}
        <code>{FAMILY_STAT_LIST[family]}</code> line
        {/* `getFor(fam)` has no `OffHand` branch, so an offhand really does take the armour
            list — worth saying, but only when you are looking at one. */}
        {isOffhand ? " — an offhand takes the armour list, because `getFor` has no branch for it" : ""}.
      </div>

      {!gemsAllowed && (
        <div className="notice">
          <strong>{rarity.id}</strong> has <code>max_gems: 0</code>, so no gem can go in one of
          these at all — <code>GemItem.canBeModified</code> refuses outright rather than capping.
          Runed gear takes runes.
        </div>
      )}

      {sockets.map((gemId, index) => (
        <div key={index} className="mb-2">
          <div className="row">
            <Picker
              options={gemOptions}
              value={gemId}
              onChange={(id) =>
                id !== undefined && patch({ sockets: sockets.map((g, i) => (i === index ? id : g)) })
              }
              width={200}
            />
            {/* A gem has no roll: `Gem.getFor(fam).toExactStat(lvl)` takes no percent, unlike
                the rune beside it. Saying so is better than an absent control. */}
            <span className="faint text-sm">
              fixed — a gem does not roll
            </span>
            <span className="grow" />
            <button onClick={() => patch({ sockets: sockets.filter((_, i) => i !== index) })}>✕</button>
          </div>
          <SocketStats
            mods={gemStats(snapshot, gemId, family)}
            rollPercent={100}
            itemLevel={item.itemLevel}
          />
        </div>
      ))}

      <div className="row wrap mb-4">
        {/* `world.gemIds[0]` used to be socketed on the spot — a gem nobody chose, which then
            had to be found and changed in the row it created. The options are the same list that
            row would have offered, hints included. */}
        <AddPicker
          label="Add gem"
          placeholder="Which gem?"
          options={gemOptions}
          width={260}
          disabled={!gemsAllowed || free <= 0 || sockets.length >= rarity.maxGems}
          {...(!gemsAllowed
            ? { title: `${rarity.id} cannot hold a gem` }
            : free <= 0
              ? { title: `All ${rarity.sockets.max} socket(s) are filled` }
              : {})}
          onAdd={(id) => patch({ sockets: [...sockets, id] })}
        />
      </div>

      {runes.map((runeId, index) => (
        <div key={index} className="mb-2">
          <div className="row">
            <Picker
              options={runeOptions}
              value={runeId}
              onChange={(id) =>
                id !== undefined && patch({ runes: runes.map((r, i) => (i === index ? id : r)) })
              }
              width={200}
            />
            {/* `SocketData.p` — rolled when the rune goes in, and raised rather than re-rolled
                if you insert the same rune again. */}
            <RollSlider
              value={runeRolls[index] ?? 0}
              min={0}
              max={100}
              showBand={false}
              onChange={(value) => setRuneRoll(index, value)}
            />
            <button
              onClick={() =>
                patch({
                  runes: runes.filter((_, i) => i !== index),
                  runeRolls: runeRolls.filter((_, i) => i !== index),
                  // The runeword was what these runes spelled; dropping one unspells it.
                  ...(item.runeword === undefined ? {} : { runeword: undefined, runewordRoll: undefined }),
                })
              }
            >
              ✕
            </button>
          </div>
          <SocketStats
            mods={runeStats(snapshot, runeId, family)}
            rollPercent={runeRolls[index] ?? 0}
            itemLevel={item.itemLevel}
            onRoll={(value) => setRuneRoll(index, value)}
          />
        </div>
      ))}

      <div className="row wrap mb-4">
        <AddPicker
          label="Add rune"
          placeholder="Which rune?"
          options={runeOptions}
          width={260}
          disabled={free <= 0 || runes.length >= rarity.maxRunes}
          {...(free <= 0 ? { title: `All ${rarity.sockets.max} socket(s) are filled` } : {})}
          onAdd={(id) => patch({ runes: [...runes, id], runeRolls: [...runeRolls, 0] })}
        />
        {free <= 0 && (
          <span className="faint text-sm">
            {rarity.sockets.max} socket{rarity.sockets.max === 1 ? "" : "s"}, all filled
          </span>
        )}
      </div>

      {rarity.canHaveRunewords && (
        <Runewords
          item={item}
          runewords={runewords}
          runes={runes}
          onPick={applyRuneword}
          onRoll={(runewordRoll) => patch({ runewordRoll })}
        />
      )}
    </>
  );
}

/**
 * The runewords this base could carry, and the one it does.
 *
 * Listed rather than searched: there are 60 in the pack and only a handful fit any one slot, so
 * the whole compatible set fits on screen. Each row shows its recipe, because the recipe is the
 * item — picking one is picking those runes in that order.
 */
function Runewords({
  item,
  runewords,
  runes,
  onPick,
  onRoll,
}: {
  item: Item;
  runewords: RunewordView[];
  runes: readonly string[];
  onPick: (id: string | undefined) => void;
  onRoll: (rollPercent: number) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const chosen = item.runeword === undefined ? undefined : runeword(snapshot, item.runeword);

  return (
    <>
      <div className="section-title">
        Runewords <span className="faint">({runewords.length} fit this slot)</span>
      </div>

      {runewords.length === 0 ? (
        <div className="faint text-sm">
          No runeword in the pack lists this base&apos;s slot — <code>RuneWord.canApplyOnItem</code>{" "}
          matches the base&apos;s <code>gear_slot</code> against the runeword&apos;s own{" "}
          <code>slots</code>.
        </div>
      ) : (
        <div className="row wrap gap-2 mb-3">
          {runewords.map((view) => {
            const active = view.id === item.runeword;
            return (
              <button
                key={view.id}
                className={active ? "primary" : ""}
                title={
                  `${view.runes.join(" + ")}\n` +
                  `Socketed in that order — hasMatchingRunesToCreate is a substring test over the ` +
                  `concatenated rune ids, so the order is part of the recipe.\n` +
                  `Picking this replaces the runes in this item.`
                }
                onClick={() => onPick(active ? undefined : view.id)}
              >
                {runewordName(snapshot, view.id)}{" "}
                <span className="faint text-xs">
                  {view.runes.join("·")}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {chosen !== undefined && (
        <>
          {!runewordMatches(chosen, runes) && (
            <div className="notice">
              The runes in this item do not spell{" "}
              <strong>{runewordName(snapshot, chosen.id)}</strong>. It needs{" "}
              <code>{chosen.runes.join(" + ")}</code> socketed consecutively and in that order.
            </div>
          )}
          <div className="row mt-2">
            <span className="faint text-sm">
              {runewordName(snapshot, chosen.id)} roll
            </span>
            {/* `GearSocketsData.setRuneword`: `rp = new MinMax(0, 100).random()`. One roll for
                the whole runeword, separate from every rune's own. */}
            <RollSlider
              value={item.runewordRoll ?? 0}
              min={0}
              max={100}
              showBand={false}
              onChange={onRoll}
            />
          </div>
          <SocketStats
            mods={chosen.stats}
            rollPercent={item.runewordRoll ?? 0}
            itemLevel={item.itemLevel}
            onRoll={onRoll}
          />
        </>
      )}
    </>
  );
}

/** Which field of a gem or rune record a slot family reads. */
const FAMILY_STAT_LIST: Record<SocketFamily, string> = {
  Weapon: "on_weapons_stats",
  Jewelry: "on_jewelry_stats",
  Armor: "on_armor_stats",
};

/** A socketable's stat lines at the item's level — the same `StatLines` gear affixes use. */
function SocketStats({
  mods,
  rollPercent,
  itemLevel,
  onRoll,
}: {
  mods: readonly Record<string, unknown>[];
  rollPercent: number;
  itemLevel: number;
  onRoll?: ((rollPercent: number) => void) | undefined;
}): ReactNode {
  if (mods.length === 0) {
    return (
      <div className="faint text-sm" style={{ paddingLeft: 6 }}>
        nothing for this slot family
      </div>
    );
  }
  return (
    <StatLines
      mods={mods}
      rollPercent={rollPercent}
      band={{ min: 0, max: 100 }}
      itemLevel={itemLevel}
      onRoll={onRoll}
    />
  );
}

function gemStats(snapshot: Snapshot, gemId: string, family: SocketFamily): Record<string, unknown>[] {
  const view = gem(snapshot, gemId);
  return view === undefined ? [] : statsForFamily(view, family);
}

function runeStats(snapshot: Snapshot, runeId: string, family: SocketFamily): Record<string, unknown>[] {
  const view = rune(snapshot, runeId);
  return view === undefined ? [] : statsForFamily(view, family);
}

/**
 * One-line summaries for a picker's hint, at the top of the band.
 *
 * `modifierLine` is the un-levelled wording, which is exactly right here: the hint is "what does
 * this rune do", not "what would it be worth on this item". The resolved numbers appear under the
 * socket once it is filled.
 */
function socketLines(snapshot: Snapshot, mods: readonly Record<string, unknown>[]): string[] {
  return mods.map((mod) => modifierLine(snapshot, mod, 100));
}

function affixLabel(snapshot: Parameters<typeof affix>[0], affixId: string): string {
  const view = affix(snapshot, affixId);
  // Only 225 of 489 affixes are named in lang, and the unnamed ones are rendered by their
  // stat lines in game. A pool entry with no name is useless, so it borrows its first line.
  const first = view?.stats[0];
  const line = first === undefined ? undefined : modifierLine(snapshot, first, 100);
  const name = affixName(snapshot, affixId);
  return line === undefined ? name : `${name} — ${line}`;
}

/**
 * The band a roll is drawn from.
 *
 * `undefined` is the implicit case and is not a fallback: `ImplicitStatsData` does not override
 * `IGearPartTooltip.getMinMax`, so it keeps that interface's `new MinMax(0, 100)` where
 * `BaseStatsData` narrows to the rarity's own percents. An implicit on a common item rolls the
 * same range as one on a mythic.
 */
function bandFor(
  world: ReturnType<typeof useWorld>,
  tierId: string | undefined,
): { min: number; max: number } {
  if (tierId === undefined) return { min: 0, max: 100 };
  return world.rarity(tierId)?.statPercents ?? { min: 0, max: 100 };
}
