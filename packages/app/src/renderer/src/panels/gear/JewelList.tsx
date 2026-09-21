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
 *
 * ## The three lists a jewel has
 *
 * `JewelItemData` keeps `affixes`, `cor` and `auraStats`, and until recently this editor drew
 * the first one. A captured Abyssal Eye therefore opened onto a window that showed a single
 * rolled affix and hid the corruption and all three Augment lines — the parts that *are* the
 * eye — and there was no way to enter one by hand at all. Each list gets its own section, with
 * the game's own rule on how many it may hold.
 */

import {
  DEFAULT_JEWEL_STYLE,
  JEWEL_STYLES,
  MAX_EYE_AURA_STATS,
  MAX_JEWEL_CORRUPTIONS,
  WATCHER_EYE_UNIQUE,
  affix,
  affixName,
  allowedAffixTiers,
  auraName,
  gearRarity,
  isAuraEnabled,
  jewelAffixesFor,
  jewelCorruptionAffixes,
  jewelName,
  modifierLine,
  underAugmentLabel,
  watcherEyeAffixes,
  type AffixRoll,
  type Jewel,
} from "@cte2/schema";
import type { Snapshot } from "@cte2/extractor";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { Accordion } from "../../ui/Accordion.js";
import { NumberField, RollSlider, useRollDraft } from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { exactModSummary, modDetail, modKeywords } from "../../ui/mods.js";
import { StatLines } from "../../ui/StatLines.js";
import { RarityBadge } from "../../ui/RarityBadge.js";
import { useJewelTooltip } from "../../ui/ItemTooltip.js";

/** One `StatsWhileUnderAuraData` — an Abyssal Eye's conditional line, as the document holds it. */
type AuraStatRoll = NonNullable<Jewel["auraStats"]>[number];

/** `JewelSocketStat`'s GUID, which is also the id of the talent that grants it. */
const JEWEL_SOCKET_STAT = "jewel_socket";

/**
 * One affix as a row in a picker: named, with what it grants beside it.
 *
 * The first stat is in the label because a jewel's *name* does not distinguish one from another
 * — every Viridian Jewel is called that — so what it grants has to. The rest go on the hover,
 * and every stat id and stat name goes in the search corpus, so an affix with three mods is
 * findable by any of them rather than only by the one that happened to be printed.
 *
 * Shared by all three pools. They differ in what they contain, never in how a row reads.
 */
function affixOption(
  snapshot: Snapshot,
  id: string,
  stats: readonly Record<string, unknown>[],
): PickerOption {
  const detail = modDetail(snapshot, stats);
  return {
    id,
    label: `${affixName(snapshot, id)} — ${
      stats[0] === undefined ? "no stats" : modifierLine(snapshot, stats[0], 100)
    }`,
    keywords: modKeywords(snapshot, stats),
    ...(detail === undefined ? {} : { detail }),
  };
}

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

  /**
   * The affix pool, per play style — three of them, because the style narrows it.
   *
   * `JewelItemData.generateAffixes` rolls from `any_jewel` plus the style's own tag, so a
   * Viridian jewel can carry 44 of the pack's 53 `jewel` affixes and a Meteorite or Stardust
   * one 45. Offering all 53 regardless, as this used to, let the editor build a jewel the game
   * cannot drop. Built once for all three rather than per card, so eight jewels do not rebuild
   * eight identical lists.
   */
  const pools = useMemo<Record<string, PickerOption[]>>(() => {
    const built: Record<string, PickerOption[]> = {};
    for (const style of JEWEL_STYLES) {
      built[style] = jewelAffixesFor(snapshot, style)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => affixOption(snapshot, a.id, a.stats));
    }
    return built;
  }, [snapshot]);

  /**
   * The other two pools, which the style does not narrow.
   *
   * `JewelItemData.corrupt` and the eye branch of `JewelBlueprint.createData` both filter on
   * the affix type alone — no tag requirement is consulted — so a Meteorite and a Stardust
   * jewel draw corruptions and Augment lines from the same two lists. One build for the whole
   * panel, like the style pools above.
   */
  const corruptionPool = useMemo<PickerOption[]>(
    () => jewelCorruptionAffixes(snapshot).map((a) => affixOption(snapshot, a.id, a.stats)),
    [snapshot],
  );

  /**
   * The Augment lines, labelled by the Augment each one waits on and never by the affix.
   *
   * Not {@link affixOption}, because an eye affix has no usable name: the pack's lang gives 24
   * of the 33 the literal string "Unused" and leaves the other 9 unnamed, which is consistent
   * rather than broken — the game never prints one. What it prints is the Augment's heading and
   * the stats, so that is what the row says. The affix id goes in the search corpus, so the
   * list is still reachable from the data.
   */
  const eyePool = useMemo<PickerOption[]>(
    () =>
      watcherEyeAffixes(snapshot)
        .map((a) => {
          const detail = modDetail(snapshot, a.stats);
          const augment = auraName(snapshot, a.eyeAuraReq);
          return {
            id: a.id,
            label: `${augment} — ${
              a.stats[0] === undefined ? "no stats" : modifierLine(snapshot, a.stats[0], 100)
            }`,
            keywords: `${modKeywords(snapshot, a.stats)} ${augment} ${a.eyeAuraReq} ${a.id}`,
            ...(detail === undefined ? {} : { detail }),
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [snapshot],
  );

  /**
   * The Augments the build is running, so a line can be badged live or dormant where it is
   * edited rather than only on the hover card. `isAuraEnabled` because an Augment switched off
   * reserves nothing and grants nothing — including these.
   */
  const aurasOn = useMemo(
    () => new Set((doc.auras ?? []).filter(isAuraEnabled).map((aura) => aura.id)),
    [doc.auras],
  );

  /** Whether the snapshot has any jewel affix at all — if not, "Add jewel" has nothing to add. */
  const anyAffixes = JEWEL_STYLES.some((style) => (pools[style] ?? []).length > 0);

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
          pool={pools[jewel.style ?? DEFAULT_JEWEL_STYLE] ?? []}
          corruptionPool={corruptionPool}
          eyePool={eyePool}
          aurasOn={aurasOn}
          unsocketed={index >= sockets}
          onChange={(next) => updateJewel(index, next)}
          onRemove={() => removeJewel(index)}
        />
      ))}

      <button
        disabled={!anyAffixes || jewels.length >= sockets}
        title={
          jewels.length >= sockets
            ? `All ${sockets} jewel socket(s) are used. Allocate another jewel_socket talent to add one.`
            : undefined
        }
        // The style is written out rather than left to default, so the card's picker shows a
        // real value and the document says which of the three jewels this is.
        onClick={() =>
          addJewel({ rarity: "rare", itemLevel: doc.character.level, style: DEFAULT_JEWEL_STYLE })
        }
      >
        Add jewel
      </button>
    </>
  );
}

/**
 * One jewel, collapsed to a row that says what it is worth.
 *
 * The title is the name the game gives it — Meteorite, Viridian or Stardust Jewel, by play
 * style, or "Abyssal Eye, Divine Jewel" once it carries aura stats (`JewelItemData.getItem()`).
 * That names the *kind*, not the copy: three Viridian Jewels are all called that, so the
 * position still numbers the row and what the jewel grants still sits beside it. Expanded, one
 * jewel is four controls plus a block per affix, and a character with four of them filled the
 * Items tab's left column entirely; collapsed, the list answers "what am I wearing" in four
 * lines and still opens onto the editor.
 *
 * Hovering a collapsed row draws the game's own item window — `ui/ItemTooltip`'s `JewelWindow`,
 * the same card gear gets. The summary on the row is one line and has to fit beside four
 * badges, so it truncates on any jewel worth wearing; the card is the whole thing, headed and
 * coloured the way the game heads and colours it, without opening the editor to read it.
 */
function JewelCard({
  jewel,
  nth,
  pool,
  corruptionPool,
  eyePool,
  aurasOn,
  unsocketed,
  onChange,
  onRemove,
}: {
  jewel: Jewel;
  /** Its place in the list, 1-based — jewels of one style share a name, so this disambiguates. */
  nth: number;
  pool: PickerOption[];
  /** Every `jewel_corruption` affix — the style does not narrow this one. */
  corruptionPool: PickerOption[];
  /** Every `watcher_eye` affix, labelled by the Augment it waits on. */
  eyePool: PickerOption[];
  /** The Augments the build is running, so a line can be badged live where it is edited. */
  aurasOn: ReadonlySet<string>;
  /** Past the last socket — the game unequips it, so the engine counts none of it. */
  unsocketed: boolean;
  onChange: (jewel: Jewel) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const rarity = world.rarity(jewel.rarity);
  const affixes = jewel.affixes ?? [];
  const corruptions = jewel.corruptions ?? [];
  const auraStats = jewel.auraStats ?? [];
  const [open, setOpen] = useState(false);

  /**
   * The in-game card, on hover — the whole point of a collapsed row.
   *
   * The one-line summary below says what the jewel grants and nothing about how; the card says
   * it the way the game says it, split into the jewel's own stats, its corruptions and its
   * aura lines, at the rolls the sheet is using. It is why opening a jewel to read it is no
   * longer the only way.
   */
  const tooltip = useJewelTooltip(jewel);

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

  /**
   * Affixes this jewel carries that its style cannot roll.
   *
   * Changing the style keeps the affixes rather than quietly dropping them — a roll the player
   * entered is data, and this file's rule is that nothing is defaulted away in silence. The
   * validator already reports each one; the badge is here so the count is visible next to the
   * control that caused it.
   *
   * Only `jewel`-type affixes are counted. `affixes` also holds the `crafted_jewel_unique`
   * ones a Watcher's Eye picks up through `CraftedUniqueJewelData.upgradeUnique`, and those
   * are drawn from the `crafted_jewel_unique` tag rather than from the style's pool — counting
   * them put a "3 off-style" badge on a perfectly legal Abyssal Eye.
   */
  const stranded = useMemo(
    () =>
      affixes.filter(
        (roll) =>
          affix(snapshot, roll.affixId)?.type === "jewel" &&
          !pool.some((option) => option.id === roll.affixId),
      ).length,
    [affixes, pool, snapshot],
  );

  /** How many of the eye's lines are firing right now — the rest wait on an unsocketed Augment. */
  const liveAuraStats = auraStats.filter((line) =>
    aurasOn.has(augmentOf(snapshot, line.affixId)),
  ).length;

  const setAffixes = (next: AffixRoll[]): void => {
    const merged: Jewel = { ...jewel };
    if (next.length === 0) delete merged.affixes;
    else merged.affixes = next;
    onChange(merged);
  };

  const setCorruptions = (next: AffixRoll[]): void => {
    const merged: Jewel = { ...jewel };
    if (next.length === 0) delete merged.corruptions;
    else merged.corruptions = next;
    onChange(merged);
  };

  /**
   * The Augment lines, and the unique marker that travels with them.
   *
   * `JewelBlueprint.createData` writes both together on an eye:
   *
   *     data.uniq = new CraftedUniqueJewelData();
   *     data.uniq.id = CraftedUniqueJewelData.WATCHER_EYE;
   *     while (data.auraStats.size() < auraAffixes) { ... }
   *
   * so a jewel with aura lines and no marker is not something the game produces. Nothing in
   * the engine reads `unique` on a jewel — the name comes from `auraStats` and the stats come
   * from the affixes — but a document written here is pasted into fixtures beside captured
   * ones, and the two should not differ in a field the game always sets. Added with the first
   * line, removed with the last, and only ever the marker: a real crafted unique the player
   * put there is left alone.
   */
  const setAuraStats = (next: AuraStatRoll[]): void => {
    const merged: Jewel = { ...jewel };
    if (next.length === 0) {
      delete merged.auraStats;
      if (merged.unique?.id === WATCHER_EYE_UNIQUE) delete merged.unique;
    } else {
      merged.auraStats = next;
      if (merged.unique === undefined) merged.unique = { id: WATCHER_EYE_UNIQUE, rollPercent: 0 };
    }
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
      {/*
        The card is offered on the collapsed row only. Open, the editor below already says
        everything it says, and a card pinned to the pointer would be sitting on top of the
        controls the pointer is on its way to.

        `tooltip.clear()` on the click is not belt and braces: flipping `open` removes these
        handlers, so the `onMouseLeave` that would normally take the card down never fires and
        it hangs over the editor that just appeared. Same failure `useItemTooltip` documents
        for a row that unmounts under the cursor, reached a different way.
      */}
      <div
        className="collapsible-head"
        onClick={() => {
          tooltip.clear();
          setOpen(!open);
        }}
        {...(open ? {} : tooltip.props)}
      >
        <span className="faint caret">{open ? "▾" : "▸"}</span>
        <strong>{jewelName(snapshot, jewel)}</strong>
        <span className="faint text-sm">#{nth}</span>
        <RarityBadge rarity={jewel.rarity} />
        <span className="badge">ilvl {jewel.itemLevel}</span>
        {unsocketed && (
          <span className="badge bad" title="Past the jewel_socket count — the game unequips it">
            no socket
          </span>
        )}
        {stranded > 0 && (
          <span
            className="badge bad"
            title={`${stranded} affix(es) cannot roll on a ${jewelName(snapshot, jewel)}. Change the style back or replace them.`}
          >
            {stranded} off-style
          </span>
        )}
        {/* An eye's whole value is in the conditional lines, and the one-line summary below
            cannot show them: they are not in `affixes`. So the row says how many there are and
            how many are firing, which is the question the card answers in full. */}
        {auraStats.length > 0 && (
          <span
            className="badge"
            title="Augment effects — each fires only while its own Augment is socketed"
          >
            {liveAuraStats} of {auraStats.length} Augment{auraStats.length === 1 ? "" : "s"}
          </span>
        )}
        {/* Every jewel of a style shares its name, so what it grants is what tells two apart.
            The rest of it is on the hover card, which carries no `title` of its own: a native
            tooltip and the item window would both answer the same hover, one of them late and
            in the wrong typeface. */}
        <span className="faint grow ellipsis text-sm">
          {summary.length === 0 ? "no affixes" : summary}
        </span>
        <button
          title="Remove this jewel"
          onClick={(event) => {
            event.stopPropagation();
            // The row is about to unmount under the cursor, so its `onMouseLeave` never fires.
            tooltip.clear();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>
      {tooltip.node}

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
        {/*
          `JewelItemData.style`. It picks the item — and so the name — and it narrows the affix
          pool to `any_jewel` plus its own tag, which is why the picker below shrinks when this
          changes. The options name the jewel each style would produce rather than showing the
          bare `str`/`dex`/`int`, since the name is what the player recognises. Still offered on
          an Abyssal Eye, whose own name comes from its Augment lines instead: the style is no
          longer visible in the title there but it still governs the pool.
        */}
        <div className="field">
          <label>style</label>
          <select
            value={jewel.style ?? DEFAULT_JEWEL_STYLE}
            onChange={(event) => onChange({ ...jewel, style: event.target.value })}
            title="PlayStyle — decides which jewel this is and which affixes may roll on it"
          >
            {JEWEL_STYLES.map((style) => (
              <option key={style} value={style}>
                {style} — {jewelName(snapshot, { ...jewel, style, auraStats: [] })}
              </option>
            ))}
          </select>
        </div>
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

      {/*
        The Abyssal Eye's own list, and the reason this editor has sections at all.

        Open by default once the jewel has one, because at that point it *is* the item — the
        rolled affix above is the incidental part. Folded on an ordinary jewel, where it is an
        offer rather than a list.
      */}
      <Accordion
        title="Augment effects"
        count={auraStats.length}
        defaultOpen={auraStats.length > 0}
        summary={
          auraStats.length === 0
            ? "makes this an Abyssal Eye"
            : `${liveAuraStats} of ${auraStats.length} firing`
        }
      >
        <div className="notice">
          An <strong>Abyssal Eye</strong> carries one to three lines that each fire only while a
          particular Augment is socketed — <code>StatsWhileUnderAuraData</code>, gated by the
          affix's own <code>eye_aura_req</code>. Which Augment is a property of the line you pick
          here, so the picker names it first. The game drops them off uber bosses as
          unique-rarity Stardust (<code>int</code>) jewels with one line per boss tier, and each
          line rolls anywhere in 0-100 with no tier and no rarity band.
        </div>

        {auraStats.map((line, index) => (
          <JewelAuraRow
            key={index}
            line={line}
            pool={eyePool}
            aurasOn={aurasOn}
            // A line the jewel already carries is not offered again: `createData` re-rolls
            // until `noneMatch`, and all 33 eye affixes are `only_one_per_item`. Its own is
            // kept in its picker, or the row would show a blank.
            taken={auraStats.filter((_, i) => i !== index).map((other) => other.affixId)}
            onChange={(next) =>
              setAuraStats(auraStats.map((l, i) => (i === index ? { ...l, ...next } : l)))
            }
            onRemove={() => setAuraStats(auraStats.filter((_, i) => i !== index))}
          />
        ))}

        <AddPicker
          label="Add Augment effect"
          placeholder="Which Augment?"
          options={eyePool.filter((option) => !auraStats.some((l) => l.affixId === option.id))}
          width={320}
          disabled={auraStats.length >= MAX_EYE_AURA_STATS}
          title={
            auraStats.length >= MAX_EYE_AURA_STATS
              ? `An eye holds at most ${MAX_EYE_AURA_STATS} — UberBossTier.watcherEyeAffixes tops out there, and nothing adds a fourth afterwards.`
              : "A line that fires only while its Augment is socketed"
          }
          // The line's own level, not the character's: `StatsWhileUnderAuraData.lvl` is set from
          // the drop's level and every stat on the line interpolates at it. The jewel's is the
          // only sane starting point. The roll is the floor rather than a random one — this is
          // an editor, and a number nobody chose should be recognisably unset.
          onAdd={(affixId) =>
            setAuraStats([...auraStats, { affixId, rollPercent: 0, itemLevel: jewel.itemLevel }])
          }
        />
      </Accordion>

      {/*
        `JewelItemData.cor`, which the engine has always counted and this editor never showed.
        A corrupted jewel is where `slow_immunity`, `max_fire_resist` and a third of a build's
        `spirit_cost` live, and both Abyssal Eyes in the fixtures carry one.
      */}
      <Accordion title="Corruptions" count={corruptions.length}>
        <div className="notice">
          An Orb of Mesmerizing Chaos rolls one, or two on a 1-in-10, and only on a jewel that
          has none — <code>JewelItemData.corrupt</code>. They resolve alongside the rolled
          affixes and are drawn from the <code>jewel_corruption</code> pool, which the play style
          does not narrow.
        </div>

        {corruptions.map((roll, index) => (
          <JewelAffixRow
            key={index}
            roll={roll}
            pool={corruptionPool}
            tiers={tiers}
            itemLevel={jewel.itemLevel}
            onChange={(next) =>
              setCorruptions(corruptions.map((r, i) => (i === index ? { ...r, ...next } : r)))
            }
            onRemove={() => setCorruptions(corruptions.filter((_, i) => i !== index))}
          />
        ))}

        <AddPicker
          label="Add corruption"
          placeholder="Which corruption?"
          options={corruptionPool}
          width={280}
          disabled={corruptions.length >= MAX_JEWEL_CORRUPTIONS}
          title={
            corruptions.length >= MAX_JEWEL_CORRUPTIONS
              ? "Two is the most one orb rolls, and a corrupted jewel cannot be corrupted again."
              : "An Orb of Mesmerizing Chaos line — it resolves alongside the rolled affixes"
          }
          onAdd={(affixId) =>
            setCorruptions([
              ...corruptions,
              {
                affixId,
                tier: tiers[0] ?? "common",
                rollPercent: band(tiers[0] ?? "common").min,
              },
            ])
          }
        />
      </Accordion>
      </div>
      )}
    </div>
  );
}

/** Which Augment a `watcher_eye` line waits on — `Affix.eye_aura_req`, read off the affix. */
function augmentOf(snapshot: Snapshot, affixId: string): string {
  return affix(snapshot, affixId)?.eyeAuraReq ?? "";
}

/**
 * One Augment effect on an Abyssal Eye: which line it is, which Augment it waits on, its roll
 * and its own level.
 *
 * Not `JewelAffixRow` with a different pool, because a `StatsWhileUnderAuraData` is not an
 * `AffixData` and the differences are exactly the controls:
 *
 *  - **no tier.** `perc` is `new MinMax(0, 100).random()` in the constructor, with no rarity
 *    and no band anywhere in the class, so the slider is the whole 0-100 and there is nothing
 *    to re-tier a typed value into.
 *  - **its own level.** `lvl` comes from the drop, not from the jewel, and `getStatAndContext`
 *    interpolates every stat on the line at it: `mod.ToExactStat(perc, lvl)`. Two eyes rolled
 *    at the same percent off bosses of different levels are not worth the same, and the
 *    document records it per line for that reason.
 *
 * The Augment itself is not a control. It is a property of the affix, so choosing the line
 * chooses the Augment — the badge states which one and whether the build is running it, which
 * is the difference between a line that is doing something and a line that is not.
 */
function JewelAuraRow({
  line,
  pool,
  aurasOn,
  taken,
  onChange,
  onRemove,
}: {
  line: AuraStatRoll;
  pool: PickerOption[];
  aurasOn: ReadonlySet<string>;
  /** Affix ids the eye's other lines already hold — one affix never appears twice on an eye. */
  taken: string[];
  onChange: (next: Partial<AuraStatRoll>) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const draft = useRollDraft(line.rollPercent);

  const view = affix(snapshot, line.affixId);
  const augment = view?.eyeAuraReq ?? "";
  const live = augment.length > 0 && aurasOn.has(augment);

  return (
    <div className="mb-3">
      <div className="row">
        <Picker
          options={pool.filter((option) => !taken.includes(option.id))}
          value={line.affixId}
          onChange={(id) => id !== undefined && onChange({ affixId: id })}
          width="100%"
        />
        <button title="Remove this Augment effect" onClick={onRemove}>
          ✕
        </button>
      </div>

      <div className="row wrap" style={{ marginTop: 3 }}>
        {/*
          Not decoration: a line whose Augment is not socketed grants nothing at all, and the
          jewel says nothing about it — `collectJewels` skips the context outright. The badge is
          where that becomes visible while the line is being edited rather than only on the card.
        */}
        <span
          className={live ? "badge" : "badge warn"}
          title={
            augment.length === 0
              ? "This affix carries no eye_aura_req, so nothing says which Augment gates it — the engine skips the line and says so in Diagnostics."
              : live
                ? "This Augment is socketed, so the line is on your sheet"
                : "Socket this Augment on the Items tab to switch the line on"
          }
        >
          {augment.length === 0
            ? "no Augment requirement"
            : `${underAugmentLabel(snapshot, augment)}${live ? "" : " — not socketed"}`}
        </span>
        <RollSlider
          value={draft.shown}
          onPreview={draft.preview}
          ends
          onChange={(rollPercent) => onChange({ rollPercent })}
        />
        {/*
          The line's level, which is not the jewel's. Labelled to say so, because two number
          boxes reading "ilvl" on one card would look like the same field entered twice.
        */}
        <div className="field">
          <label>line ilvl</label>
          <NumberField
            value={line.itemLevel}
            min={1}
            max={world.maxLevel}
            width={58}
            onChange={(itemLevel) => onChange({ itemLevel })}
          />
        </div>
      </div>

      {/* The full 0-100 in both places: there is no tier to clamp a typed value into, so a
          number read off the item in game lands on the roll that produces it. */}
      <StatLines
        mods={view?.stats ?? []}
        rollPercent={draft.shown}
        band={{ min: 0, max: 100 }}
        itemLevel={line.itemLevel}
        onRoll={(rollPercent) => onChange({ rollPercent })}
      />
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
