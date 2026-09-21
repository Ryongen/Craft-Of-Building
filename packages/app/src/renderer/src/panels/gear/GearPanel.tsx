/**
 * The equipment list, laid out as the paperdoll the mod actually gives a character.
 *
 * This used to carry a banner saying the layout was our assumption, because phase 0.5 recorded
 * that "how many items share a gear slot (two rings?) is not in the datapack" and left it
 * unchecked. That was true of the datapack and false of the mod:
 * `characters/CharacterEquipment.java` states the worn loadout outright, because switching
 * characters has to relocate every worn stack —
 *
 *     VANILLA_SLOTS = HEAD, CHEST, LEGS, FEET, OFFHAND
 *     CURIO_BLOCKS  = RING(base 5, count 2), NECKLACE(7, 1), OMEN(8, 1)
 *     public static final int SIZE = 9; // 4 armor + offhand + 2 rings + necklace + omen
 *
 * — and the mainhand is excluded from that list precisely because it is the held item rather
 * than a stored one. So: one helmet, chest, pants, boots, necklace, weapon and offhand, and
 * two rings. `SLOT_CAPACITY` in `@cte2/schema` is that table, the validator enforces it, and
 * this renders one row per slot the character has rather than an unbounded list.
 *
 * The omen is in that list too, and has its own row at the bottom — but it is not gear and is
 * not an `Item`. It carries requirements over the rest of the loadout instead of stats of its
 * own, so it lives in `doc.omen` and gets `OmenEditor` rather than `ItemEditor`.
 *
 * Each item's contribution is drawn by `ui/ItemTooltip` — the same card the hover tooltip shows,
 * laid into the editor rather than pinned to the pointer — and that card reads the engine's own
 * collector, so a line shown here cannot disagree with the total in the sidebar. Beside it sits
 * `ItemDiffCard`, which prices the item against every place it could go: one card for a helmet,
 * two for a ring, because a ring fits either finger and the two answers differ.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  SLOT_CAPACITY,
  allUniques,
  baseGearType,
  countOmenPieces,
  omen as omenView,
  omenBuckets,
  omenIds,
  omenMinLevel,
  omenName,
  gearTypeName,
  isTwoHanded,
  itemName,
  slotFamily,
  slotName,
  unique as uniqueView,
  uniqueName,
  uniqueRarityId,
  type Diagnostic,
  type Item,
} from "@cte2/schema";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useBuild } from "../../state/build-store.js";
import { useWhatIf } from "../../state/compare.js";
import { useDerived } from "../../state/derived.js";
import { docWithSwap, useItemCompare, type ComparePosition } from "../../state/item-compare.js";
import { useWorld } from "../../state/snapshot.js";
import { ComparisonBlock } from "../../ui/DeltaTable.js";
import { GearIcon } from "../../ui/GearIcon.js";
import { ItemDiffCard } from "../../ui/ItemDiffCard.js";
import { ItemWindow, useItemTooltip } from "../../ui/ItemTooltip.js";
import { RarityBadge } from "../../ui/RarityBadge.js";
import { AugmentList } from "../../ui/Augments.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { modDetail, modKeywords } from "../../ui/mods.js";

import { ImportDialog } from "./ImportDialog.js";
import { ItemEditor } from "./ItemEditor.js";
import { OmenEditor, omenWord } from "./OmenEditor.js";
import { JewelList } from "./JewelList.js";

/**
 * One row of the paperdoll.
 *
 * `kind` is what the capacity is counted over. Armour and jewellery are limited per *slot*
 * (`SLOT_CAPACITY`); the two hands are limited per *family*, because which kind of weapon
 * fills the mainhand is a choice and how many do is not — `sword`, `bow` and `greatsword` are
 * separate `mmorpg_gear_slot` entries all competing for the same hand.
 */
type SlotRow =
  | { kind: "slot"; id: string; capacity: number }
  | { kind: "family"; id: string; family: string; capacity: number };

/** In the order `CharacterEquipment` lists them: armour, then the hands, then jewellery. */
const PAPERDOLL: SlotRow[] = [
  { kind: "slot", id: "helmet", capacity: SLOT_CAPACITY.helmet ?? 1 },
  { kind: "slot", id: "chest", capacity: SLOT_CAPACITY.chest ?? 1 },
  { kind: "slot", id: "pants", capacity: SLOT_CAPACITY.pants ?? 1 },
  { kind: "slot", id: "boots", capacity: SLOT_CAPACITY.boots ?? 1 },
  { kind: "family", id: "weapon", family: "Weapon", capacity: 1 },
  { kind: "family", id: "offhand", family: "OffHand", capacity: 1 },
  { kind: "slot", id: "necklace", capacity: SLOT_CAPACITY.necklace ?? 1 },
  { kind: "slot", id: "ring", capacity: SLOT_CAPACITY.ring ?? 2 },
  // A pack-added slot, not one of `CURIO_BLOCKS` — see `SLOT_CAPACITY`, where its count of 1
  // is recorded as the pack author's statement rather than as something the Java says.
  { kind: "slot", id: "elytra", capacity: SLOT_CAPACITY.elytra ?? 1 },
];

/**
 * Which item the middle column is editing, and where it lives.
 *
 * Two lists hold items and the editor has to be able to point at either: `gear` is what the
 * character is wearing and `itemPool` is the bench. An index alone would be ambiguous — pool
 * item 0 and worn item 0 are different items — and carrying the item itself would go stale the
 * moment an edit produced a new document.
 */
type ItemRef = { where: "gear" | "pool"; index: number };

function sameRef(a: ItemRef | null, b: ItemRef): boolean {
  return a !== null && a.where === b.where && a.index === b.index;
}

/**
 * One row of the pool: an item, where it lives, and the slot it is worn in.
 *
 * `slot` is `undefined` for a benched item and the paperdoll's own label for a worn one — the
 * label rather than the slot id, so the badge reads "Ring 2" and matches the row on the left
 * that the same item appears in.
 */
type PoolEntry = { item: Item; ref: ItemRef; slot: string | undefined };

/**
 * What the base/unique search is narrowed to.
 *
 * Resolved through the paperdoll rows rather than a list of slot ids typed here, so the filter
 * and the loadout can never disagree about what counts as a weapon.
 */
const FINDER_FILTERS = [
  { id: "all", label: "All" },
  { id: "armor", label: "Armor" },
  { id: "weapon", label: "Weapons" },
  // "Jewelry", because that is what `mmorpg_gear_slot.fam` calls it and what the game shows.
  // "Curios" is the Forge mod the rings and necklace are *implemented* through, which is a fact
  // about the code and not a word any player uses.
  { id: "curio", label: "Jewelry" },
] as const;

type FilterId = (typeof FINDER_FILTERS)[number]["id"];

/**
 * Whether the finder is showing named items, craftable bases, or both.
 *
 * Its own control beside the slot filter, and not a nicety. The list is 310 uniques and 43
 * bases, and the dropdown draws at most 200 rows — so with an empty search box the bases were
 * *all* past the cut, every time, and the only way to reach one was to know its name and type
 * it. Nothing on screen said so: the list simply had no rares in it, and picking a unique and
 * editing it into a rare was the only path anyone could find to a rare item.
 *
 * Both halves are still ordered uniques-first inside `All` — a unique is the thing searched for
 * by name — but `Non-unique` makes the 43 bases a list you can read, which is what they are.
 */
const RARITY_FILTERS = [
  { id: "any", label: "All" },
  { id: "unique", label: "Unique" },
  { id: "base", label: "Non-unique" },
] as const;

type RarityFilterId = (typeof RARITY_FILTERS)[number]["id"];

/** The four armour rows, for the finder's filter. */
const ARMOUR_SLOTS = new Set(["helmet", "chest", "pants", "boots"]);

/**
 * How many pool rows are shown before the list starts scrolling inside itself.
 *
 * Nine, because that is `CharacterEquipment.SIZE` plus the mainhand — a full loadout. Below it
 * the list is the character; above it the list is a collection, and a collection belongs in a
 * box with a scrollbar rather than in a column that grows without limit.
 */
const POOL_ROWS = 9;

/** `POOL_ROWS` rows at the height `.items-col .slot-row` renders one at, plus its margin. */
const POOL_MAX = POOL_ROWS * 26;

/** The two hands. */
const HAND_SLOTS = new Set(["weapon", "offhand"]);

export function GearPanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const updateItem = useBuild((s) => s.updateItem);
  const removeItem = useBuild((s) => s.removeItem);
  const unequipItem = useBuild((s) => s.unequipItem);
  const addPoolItem = useBuild((s) => s.addPoolItem);
  const updatePoolItem = useBuild((s) => s.updatePoolItem);
  const removePoolItem = useBuild((s) => s.removePoolItem);
  const equipPoolItem = useBuild((s) => s.equipPoolItem);
  const setOmen = useBuild((s) => s.setOmen);
  const derived = useDerived();

  const [editing, setEditing] = useState<ItemRef | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [omenOpen, setOmenOpen] = useState(false);

  const items = doc.gear ?? [];
  const pool = doc.itemPool ?? [];

  /** Which document indices sit in each paperdoll row, and which sit in none. */
  const placement = useMemo(() => {
    const byRow = new Map<string, number[]>();
    const unplaced: number[] = [];

    for (const [index, item] of items.entries()) {
      const row = rowFor(world.snapshot, item);
      if (row === undefined) {
        unplaced.push(index);
        continue;
      }
      byRow.set(row.id, [...(byRow.get(row.id) ?? []), index]);
    }
    return { byRow, unplaced };
  }, [items, world.snapshot]);

  /**
   * A two-handed weapon empties the offhand outright.
   *
   * Better Combat's `PlayerEntityMixin.getEquippedStack_Pre` returns `ItemStack.EMPTY` for
   * `EquipmentSlot.OFFHAND` while one is held, so Mine and Slash reads an empty offhand and
   * sums nothing from it. Greying the row out is the honest rendering of that.
   */
  const twoHanded = (placement.byRow.get("weapon") ?? []).some((index) => {
    const item = items[index];
    return item !== undefined && isTwoHanded(world.snapshot, item.base);
  });

  /**
   * Put a benched item on, taking off whatever the slot has no room for.
   *
   * The displaced pieces go back to the bench rather than being deleted, which is the rule that
   * makes trying things on safe: swapping one of two rings must leave you holding the other.
   * Oldest first, so the ring worn longest is the one that comes off.
   */
  const equip = (poolIndex: number): void => {
    const item = pool[poolIndex];
    if (item === undefined) return;
    const row = rowFor(world.snapshot, item);
    const occupying = row === undefined ? [] : (placement.byRow.get(row.id) ?? []);
    const capacity = row?.capacity ?? 1;
    // One place has to be free for the arrival, so everything past `capacity - 1` comes off.
    const displace = occupying.slice(0, Math.max(0, occupying.length - (capacity - 1)));
    equipPoolItem(poolIndex, displace);
    // It arrives at the end of `gear`, which has lost `displace.length` entries on the way.
    setEditing({ where: "gear", index: items.length - displace.length });
  };

  /** A new item always lands on the bench, never straight onto the character. */
  const create = (item: Item): void => {
    addPoolItem(item);
    setEditing({ where: "pool", index: pool.length });
  };

  const target =
    editing === null
      ? undefined
      : editing.where === "gear"
        ? items[editing.index]
        : pool[editing.index];

  /**
   * The whole collection, worn first.
   *
   * Worn first because that is the order they are read in — the character, then what is spare —
   * and because a list whose top half shuffled every time you took something off would be the
   * wrong shape for comparing two candidates side by side.
   */
  const poolEntries = useMemo<PoolEntry[]>(() => {
    const label = (item: Item): string | undefined => {
      const row = rowFor(world.snapshot, item);
      if (row === undefined) return "worn";
      const name = row.kind === "slot" ? slotName(world.snapshot, row.id) : row.family;
      if (row.capacity <= 1) return name;
      // Which of the two rings this is, counted the way the paperdoll numbers them.
      const nth = (placement.byRow.get(row.id) ?? []).indexOf(items.indexOf(item));
      return nth < 0 ? name : `${name} ${nth + 1}`;
    };
    return [
      ...items.map<PoolEntry>((item, index) => ({
        item,
        ref: { where: "gear", index },
        slot: label(item),
      })),
      ...pool.map<PoolEntry>((item, index) => ({
        item,
        ref: { where: "pool", index },
        slot: undefined,
      })),
    ];
  }, [items, pool, world.snapshot, placement]);

  /**
   * Publish the selected item, with every place it could sit.
   *
   * Which piece comes off is not a guess: `equip` displaces `occupying.length - (capacity - 1)`
   * items oldest-first, so for a full slot that is `occupying[0]` and for a slot with room it is
   * nothing at all. Reading the same rule here is what keeps each diff a statement about the
   * click you are about to make rather than about a swap the panel would not perform.
   *
   * Every *position* the row has, not just the one that would give way. A ring has two, and they
   * are two different readings rather than one printed twice: a benched ring may replace the one
   * on your finger or take the empty slot beside it, and which of those it is changes every
   * number on the card. Both empty is the single case that collapses back to one — nothing is
   * coming off either way, so two cards would say the same thing twice and imply a choice the
   * character does not have yet.
   */
  const showCompare = useItemCompare((s) => s.show);
  const clearCompare = useItemCompare((s) => s.clear);

  useEffect(() => {
    if (editing === null || target === undefined) {
      clearCompare();
      return;
    }
    const row = rowFor(world.snapshot, target);
    const occupying = row === undefined ? [] : (placement.byRow.get(row.id) ?? []);
    // As many rows as the paperdoll draws: the slot's capacity, or however many are wedged into
    // it. An item in a row the paperdoll has no place for — `head` — is priced on its own.
    const count = row === undefined ? 1 : Math.max(row.capacity, occupying.length);
    const slotId = baseGearType(world.snapshot, target.base)?.gearSlot;
    const name =
      row === undefined
        ? slotId === undefined
          ? "Not in any slot"
          : slotName(world.snapshot, slotId)
        : row.kind === "slot"
          ? slotName(world.snapshot, row.id)
          : row.family;

    const positions: ComparePosition[] = Array.from({ length: count }, (_, nth) => {
      const at = occupying[nth];
      return {
        label: count > 1 ? `${name} ${nth + 1}` : name,
        against: at === undefined ? undefined : items[at],
        // The index as well as the item: the card builds the document each choice would produce,
        // and "which entry of `doc.gear` gives way" is not answerable from the item alone — two
        // identical rings are two entries.
        againstIndex: at,
        worn: editing.where === "gear" && at === editing.index,
      };
    });

    // The place the item is already in reads first — that is the one being looked at — and the
    // alternatives follow in the paperdoll's order. `sort` is stable, so they keep that order.
    positions.sort((a, b) => Number(b.worn) - Number(a.worn));

    const collapse = positions.length > 1 && positions.every((p) => p.against === undefined);
    showCompare({
      item: target,
      source: editing,
      positions: collapse ? [{ ...positions[0]!, label: `${name} 1 or ${count}` }] : positions,
    });
  }, [editing, target, placement, items, world.snapshot, showCompare, clearCompare]);

  // Leaving the tab clears the card with it: it is about a choice being made in this panel, and
  // a diff left standing over the Tree tab is a diff about nothing on screen.
  useEffect(() => clearCompare, [clearCompare]);

  return (
    <div className="panel items-panel">
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(item) => {
            create(item);
            setImportOpen(false);
          }}
        />
      )}

      {/* -- left: what the character is wearing -------------------------- */}
      <div className="items-col">
        <div className="section-title mt-0">Equipped</div>

        {PAPERDOLL.map((row) => {
          const indices = placement.byRow.get(row.id) ?? [];
          const label = row.kind === "slot" ? slotName(world.snapshot, row.id) : row.family;
          const suppressed = row.id === "offhand" && twoHanded;
          // One row per place the slot has, filled or not, so the paperdoll keeps its shape as
          // items come on and off. `Ring 1` and `Ring 2` rather than one label over two rows:
          // they are two different items and each is chosen separately.
          //
          // The number names the *place*, never the item. What is worn there carries the name
          // the game gives it — `itemName`, which is "Azure Amethyst Ring of Venom" and not
          // "Ring" — so the two rings are told apart by what they are rather than by which row
          // they landed in.
          const rows = Math.max(row.capacity, indices.length);

          return (
            <div key={row.id}>
              {Array.from({ length: rows }, (_, nth) => {
                const index = indices[nth];
                const rowLabel = row.capacity > 1 ? `${label} ${nth + 1}` : label;

                if (index === undefined) {
                  return (
                    <EmptySlot
                      key={`empty-${nth}`}
                      label={rowLabel}
                      suppressed={suppressed}
                      candidates={pool
                        .map((item, i) => ({ item, i }))
                        .filter(({ item }) => rowFor(world.snapshot, item)?.id === row.id)}
                      onEquip={equip}
                    />
                  );
                }

                return (
                  <ItemRow
                    key={index}
                    item={items[index]!}
                    slotLabel={rowLabel}
                    overCapacity={nth >= row.capacity}
                    suppressed={suppressed}
                    selected={sameRef(editing, { where: "gear", index })}
                    diagnostics={derived.diagnostics.filter((d) =>
                      d.path.startsWith(`gear[${index}]`),
                    )}
                    onSelect={() => setEditing({ where: "gear", index })}
                    onOff={() => {
                      unequipItem(index);
                      setEditing(null);
                    }}
                    // The row *is* the list of what else could go here — see `SlotPicker`. The
                    // facts come from here rather than from the row because only the panel knows
                    // what is on the bench and what `equip` would displace.
                    slot={{
                      index,
                      candidates: pool
                        .map((item, i) => ({ item, i }))
                        .filter(({ item }) => rowFor(world.snapshot, item)?.id === row.id),
                      onEquip: equip,
                      onUnequip: (at) => {
                        unequipItem(at);
                        setEditing(null);
                      },
                    }}
                  />
                );
              })}
            </div>
          );
        })}

        <OmenRow
          open={omenOpen}
          onToggle={() => setOmenOpen(!omenOpen)}
          onChange={setOmen}
          diagnostics={derived.diagnostics.filter((d) => d.path.startsWith("omen"))}
        />

        {placement.unplaced.length > 0 && (
          <>
            <div className="section-title">Not in any slot</div>
            <div className="notice">
              These items name a gear slot with no row above it: <code>head</code> is a
              pack-added slot matching no block in{" "}
              <code>CharacterEquipment.CURIO_BLOCKS</code>, so how many of it a character may
              wear is genuinely unanswered. Nothing is enforced and the engine still sums them.
            </div>
            {placement.unplaced.map((index) => (
              <ItemRow
                key={index}
                item={items[index]!}
                slotLabel=""
                overCapacity={false}
                suppressed={false}
                selected={sameRef(editing, { where: "gear", index })}
                diagnostics={derived.diagnostics.filter((d) => d.path.startsWith(`gear[${index}]`))}
                onSelect={() => setEditing({ where: "gear", index })}
                onOff={() => {
                  unequipItem(index);
                  setEditing(null);
                }}
              />
            ))}
          </>
        )}

        <AugmentList compact />
        <JewelList />
      </div>

      {/* -- middle: find, keep, craft ------------------------------------ */}
      <div className="items-col">
        <ItemFinder onCreate={create} onImport={() => setImportOpen(true)} />

        <ItemPool
          entries={poolEntries}
          editing={editing}
          onSelect={setEditing}
          onEquip={equip}
          onUnequip={(index) => {
            unequipItem(index);
            setEditing(null);
          }}
          onRemove={(ref) => {
            if (ref.where === "gear") removeItem(ref.index);
            else removePoolItem(ref.index);
            setEditing(null);
          }}
        />

        {editing === null || target === undefined ? (
          <div className="empty">
            Pick a slot on the left, or an item from the pool above, to edit it here. Searching
            for a base or a unique adds a new one to the pool.
          </div>
        ) : (
          <EditorCard
            item={target}
            where={editing.where}
            suppressed={editing.where === "gear" && twoHanded && isOffhand(world.snapshot, target)}
            diagnostics={derived.diagnostics.filter((d) =>
              d.path.startsWith(
                editing.where === "gear" ? `gear[${editing.index}]` : `itemPool[${editing.index}]`,
              ),
            )}
            onChange={(next) =>
              editing.where === "gear"
                ? updateItem(editing.index, next)
                : updatePoolItem(editing.index, next)
            }
            onRemove={() => {
              if (editing.where === "gear") removeItem(editing.index);
              else removePoolItem(editing.index);
              setEditing(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Which paperdoll row an item belongs in, by its base's slot and that slot's family. */
function rowFor(snapshot: Snapshot, item: Item): SlotRow | undefined {
  const slotId = baseGearType(snapshot, item.base)?.gearSlot;
  const family = slotId === undefined ? undefined : slotFamily(snapshot, slotId);
  return PAPERDOLL.find((r) => (r.kind === "slot" ? r.id === slotId : r.family === family));
}

function isOffhand(snapshot: Snapshot, item: Item): boolean {
  return rowFor(snapshot, item)?.id === "offhand";
}

/** The id the `(none)` row carries. Never an item, so it cannot collide with a pool index. */
const NONE = "\u0000none";

/**
 * One panel of the swap preview, in pixels.
 *
 * `.item-window` sits between 290 and 360 when it is a tooltip, and three of these have to fit
 * beside a 400px column without running off the window. 300 is the width a gear card reads at
 * without wrapping its longest affix line onto three rows.
 */
const PANEL = 300;

/**
 * Everything that could go in one place on the paperdoll, and what each would be worth.
 *
 * A slot used to be a label. Filling one meant finding the piece in the pool above and pressing
 * "equip" on *it* — the question asked at the wrong end, since what a player has is "what can go
 * here". So the slot is the control: opening it lists every benched piece whose base belongs in
 * this row, with `(none)` at the top to take off whatever is in it.
 *
 * **The whole row is the trigger**, not a box at its left end. A 58px control on a 400px row is a
 * target you have to aim at, and it left the rest of the row — the icon, the name, the badges,
 * everything that says *which* slot this is — doing nothing. So the row's own content is the
 * closed state and clicking anywhere on it opens the list, which is also what makes the separate
 * "off" button unnecessary: taking a piece off is the first entry of the list that opens.
 *
 * `onOpen` fires on the same click, so one press both drops the list and puts the piece in the
 * editor below. The two are the same intention — "I am working on this slot" — and splitting them
 * across two targets was what made the row need two controls in the first place.
 *
 * ## Why this is not a `Picker`
 *
 * It was one, and a `Picker` is the wrong shape for a row. A `Picker` *replaces* itself with a
 * search box when it opens, and that produced two ways to get stuck, both reported:
 *
 *  - **the row would not close again.** Clicking it a second time is the obvious way to dismiss a
 *    dropdown, and it landed on the search input, which refocuses and reopens. There was no
 *    gesture that shut the list except clicking somewhere else entirely.
 *  - **the list covered the rows below it**, so a click aimed at the next slot actually landed
 *    inside the open list — on padding, between options — where it counted as *inside* the picker
 *    and closed nothing. Two or three dead clicks in a row read as a frozen control.
 *
 * A slot has a handful of candidates and needs no search, so the row stays a row: the list drops
 * underneath it and clicking the row again folds it away. There is no dead area, because every
 * pixel of the list is an option.
 *
 * **Hovering an option prices it.** Two swaps into the same slot are worth wildly different
 * amounts and no list of names can say so, so the entry under the cursor is priced exactly the way
 * `ItemDiffCard` prices a selection — the document that choice would produce, run through the
 * whole engine — and drawn beside the list. `(none)` is priced too, which is the only place in
 * the app that answers what a worn piece is doing for you without making you take it off first.
 */
type SlotOption = { id: string; label: string; hint: string; item: Item | undefined };

function SlotPicker({
  label,
  worn,
  wornIndex,
  candidates,
  onEquip,
  onUnequip,
  onOpen,
  children,
}: {
  /** The paperdoll's name for this place — "Ring 2". */
  label: string;
  /** What is in it now. */
  worn: Item | undefined;
  /** `worn`'s index in `doc.gear`. */
  wornIndex: number | undefined;
  /** Benched pieces whose base belongs in this row, with their pool indices. */
  candidates: { item: Item; i: number }[];
  onEquip: (poolIndex: number) => void;
  onUnequip: (gearIndex: number) => void;
  /** Also fired by the click that opens the list — see the note above. */
  onOpen?: () => void;
  /** The row itself: what the slot looks like while the list is shut. */
  children: ReactNode;
}): ReactNode {
  const world = useWorld();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | undefined>();
  const wrapRef = useRef<HTMLDivElement>(null);

  const options = useMemo<SlotOption[]>(() => {
    const rows: SlotOption[] = [];
    if (worn !== undefined) {
      rows.push({
        id: NONE,
        label: `(none) — take off ${itemName(world.snapshot, worn)}`,
        hint: "unequip",
        item: undefined,
      });
    }
    for (const { item, i } of candidates) {
      rows.push({
        id: String(i),
        label: itemName(world.snapshot, item),
        hint: item.rarity,
        item,
      });
    }
    return rows;
  }, [candidates, worn, world.snapshot]);

  // Dismissed by clicking anywhere that is not this row, and by Escape. Both are registered only
  // while the list is up, so a shut row costs nothing.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // Nothing under the pointer once the list is gone, or the preview outlives the list it belonged
  // to and hangs over the panel.
  useEffect(() => {
    if (!open) setHovered(undefined);
  }, [open]);

  const choose = (id: string): void => {
    setOpen(false);
    if (id === NONE) {
      if (wornIndex !== undefined) onUnequip(wornIndex);
      return;
    }
    onEquip(Number(id));
  };

  // Nothing to offer and nothing to take off is not a list, it is a dead end: an empty offhand
  // beside a two-handed weapon would open onto an empty box. The row stays a row.
  const offersNothing = options.length === 0;
  const hoveredItem = options.find((o) => o.id === hovered)?.item;

  return (
    <div className="slot-picker" ref={wrapRef}>
      <div
        className={`slot-trigger${offersNothing ? " inert" : ""}${open ? " open" : ""}`}
        onClick={() => {
          onOpen?.();
          if (!offersNothing) setOpen((was) => !was);
        }}
      >
        {children}
      </div>

      {open && !offersNothing && (
        <div className="slot-list" onMouseLeave={() => setHovered(undefined)}>
          {options.map((option) => (
            <div
              key={option.id}
              className={`slot-option${option.id === hovered ? " active" : ""}`}
              onMouseEnter={() => setHovered(option.id)}
              onMouseDown={() => choose(option.id)}
            >
              <span className="ellipsis">{option.label}</span>
              <span className="badge">{option.hint}</span>
            </div>
          ))}
        </div>
      )}

      {hovered !== undefined && (
        <SwapPreview
          anchorRef={wrapRef}
          label={label}
          worn={worn}
          wornIndex={wornIndex}
          candidate={hoveredItem}
        />
      )}
    </div>
  );
}

/**
 * What the row under the cursor would do, laid out as three panels side by side.
 *
 * The same statement `ItemDiffCard` makes and for the same reason — an item's own stat lines are
 * not what it is worth, because every one of them runs through the increases, the curves and the
 * caps the rest of the character already has. So this builds the document the click would produce
 * and prices that. `useWhatIf` holds it for a beat, which is what stops a run down a list of nine
 * rings from spending an engine pass on each ring the cursor merely crossed.
 *
 * ## Three panels, not one tall one
 *
 * It began as one column — the candidate's card with the price stacked under it — and that is the
 * wrong axis. A gear card is 300px wide and 400 tall; two of them plus a price list is 900px of
 * height in a 1000px window, so the panel ran the height of the screen, covered the list that
 * summoned it, and still could not show both items at once. Beside each other they are 900px of
 * *width*, which the Items tab has going spare once the 400px paperdoll is accounted for.
 *
 * Left to right: **what changes**, then **what is on now**, then **what would go on**. The order
 * is the reading order of the question — the verdict, then the two things it is a verdict about —
 * and it puts the two item cards next to each other, which is the comparison a player is actually
 * making.
 *
 * Panels that have nothing to show are left out rather than drawn empty: an empty slot has no
 * "on now" card, and the `(none)` row has no "would go on".
 *
 * Portalled to `document.body` and positioned against the paperdoll **column**, not against the
 * pointer and not against the row. Not the pointer, because this is a panel being read rather than
 * a tooltip being glanced at, and one that slid about under the mouse as you moved down a list
 * would be unreadable. Not the row, because the list drops *below* the row and the panel would sit
 * on top of it.
 */
function SwapPreview({
  anchorRef,
  label,
  worn,
  wornIndex,
  candidate,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  label: string;
  worn: Item | undefined;
  wornIndex: number | undefined;
  /** The piece going on, or `undefined` for the `(none)` row. */
  candidate: Item | undefined;
}): ReactNode {
  const doc = useBuild((s) => s.doc);
  const [box, setBox] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    // The column rather than the row: `.items-col` is the paperdoll, and its right edge is where
    // there is room. Falls back to the row itself if the class ever moves.
    const anchor = anchorRef.current;
    const column = anchor?.closest(".items-col") ?? anchor;
    setBox(column?.getBoundingClientRect() ?? null);
  }, [anchorRef, candidate]);

  const next = useMemo(
    () =>
      candidate === undefined
        ? docWithSwap(doc, { removeIndex: wornIndex })
        : docWithSwap(doc, { item: candidate, removeIndex: wornIndex }),
    [doc, candidate, wornIndex],
  );

  const priced = useWhatIf(next);

  if (box === null) return null;

  const panels = 1 + (worn === undefined ? 0 : 1) + (candidate === undefined ? 0 : 1);
  const width = panels * PANEL + (panels - 1) * 8;
  const flip = box.right + width + 16 > window.innerWidth;
  const top = Math.max(8, box.top);
  const style: CSSProperties = {
    position: "fixed",
    width,
    top,
    maxHeight: Math.max(240, window.innerHeight - top - 12),
    ...(flip ? { right: window.innerWidth - box.left + 8 } : { left: box.right + 8 }),
  };

  return createPortal(
    <div className="swap-preview" style={style}>
      {/* The title sits outside the box on every panel, so the three line up across the top
          whatever is inside them. */}
      <div className="swap-panel">
        <div className="swap-panel-title">
          {candidate === undefined
            ? `${label} — taking it off`
            : worn === undefined
              ? `${label} — would add`
              : `${label} — would swap`}
        </div>
        <div className="swap-panel-price">
          {priced === undefined ? (
            <div className="faint text-sm">Pricing…</div>
          ) : (
            <ComparisonBlock
              comparison={priced.click.comparison}
              statLimit={10}
              emptyNote="Nothing changes — the character sheet lands in exactly the same place."
            />
          )}
        </div>
      </div>

      {worn !== undefined && (
        <div className="swap-panel">
          <div className="swap-panel-title">On now</div>
          <ItemWindow item={worn} />
        </div>
      )}

      {candidate !== undefined && (
        <div className="swap-panel">
          <div className="swap-panel-title">Would go on</div>
          <ItemWindow item={candidate} />
        </div>
      )}
    </div>,
    document.body,
  );
}

/** A place on the paperdoll with nothing in it, and what the pool could put there. */
function EmptySlot({
  label,
  suppressed,
  candidates,
  onEquip,
}: {
  label: string;
  suppressed: boolean;
  /** Benched items whose base belongs in this row, with their pool indices. */
  candidates: { item: Item; i: number }[];
  onEquip: (poolIndex: number) => void;
}): ReactNode {
  return (
    <div className={`slot-row empty${suppressed ? " suppressed" : ""}`}>
      <SlotPicker
        label={label}
        worn={undefined}
        wornIndex={undefined}
        candidates={candidates}
        onEquip={onEquip}
        onUnequip={() => {}}
      >
        <span className="slot-name">{label}</span>
        {suppressed ? (
          <span className="faint text-sm">emptied by the two-handed weapon</span>
        ) : candidates.length === 0 ? (
          <span className="faint text-sm">empty — nothing in the pool fits here</span>
        ) : (
          <span className="faint text-sm">
            empty — {candidates.length} in the pool fit{candidates.length === 1 ? "s" : ""} here
          </span>
        )}
      </SlotPicker>
    </div>
  );
}

/**
 * Search the registry for something to build from.
 *
 * Bases and uniques in one list, because "what shall I put here" is one question: nobody
 * looking for a chest piece first decides whether they want a rare or a unique. Picking either
 * adds an item to the pool and opens it in the editor below.
 */
function ItemFinder({
  onCreate,
  onImport,
}: {
  onCreate: (item: Item) => void;
  onImport: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const level = useBuild((s) => s.doc.character.level);
  const [filter, setFilter] = useState<FilterId>("all");
  const [rarityFilter, setRarityFilter] = useState<RarityFilterId>("any");

  const uniques = useMemo(() => allUniques(snapshot), [snapshot]);

  const options = useMemo<PickerOption[]>(() => {
    const inFilter = (baseId: string | undefined): boolean => {
      if (filter === "all") return true;
      if (baseId === undefined) return false;
      const row = rowFor(snapshot, { base: baseId, rarity: "common", itemLevel: 1 });
      if (row === undefined) return false;
      if (filter === "armor") return ARMOUR_SLOTS.has(row.id);
      if (filter === "weapon") return HAND_SLOTS.has(row.id);
      return !ARMOUR_SLOTS.has(row.id) && !HAND_SLOTS.has(row.id);
    };

    const bases =
      rarityFilter === "unique"
        ? []
        : world.slots
            .flatMap((slot) => world.basesFor(slot.id))
            .filter((base) => inFilter(base.id))
            .map<PickerOption>((base) => ({
              id: `base:${base.id}`,
              label: gearTypeName(snapshot, base.id),
              hint: "base",
              keywords: `${base.id} ${base.tags.join(" ")}`,
            }));

    const uniqueRows =
      rarityFilter === "base"
        ? []
        : uniques
            .filter((u) => inFilter(u.baseGear))
            .map<PickerOption>((u) => {
              const detail = modDetail(snapshot, u.uniqueStats);
              return {
                id: `unique:${u.id}`,
                label: uniqueName(snapshot, u.id),
                hint: "unique",
                keywords: `${u.id} ${u.baseGear ?? ""} ${modKeywords(snapshot, u.uniqueStats)}`,
                ...(detail === undefined ? {} : { detail }),
              };
            });

    /*
     * Bases first, and this used to be the other way round.
     *
     * The old order was uniques first, on the reasoning that a unique is what you search for by
     * name and a base list is a list of nouns you already know you want. Both halves of that are
     * still true — and it made the bases unreachable. The dropdown draws 200 rows, this pack has
     * 310 uniques and 43 bases, so on an empty search box *every* base was past the cut, every
     * time. The list simply had no rares in it, and the only way anyone found to a rare was to
     * pick a unique and edit it into one.
     *
     * 43 then 157 puts both kinds on screen, and costs the uniques nothing that matters: nobody
     * scrolls to `Voidforge`, they type it.
     */
    return [...bases, ...uniqueRows];
  }, [world, snapshot, uniques, filter, rarityFilter]);

  const pick = (id: string): void => {
    if (id.startsWith("base:")) {
      onCreate({ base: id.slice(5), rarity: "rare", itemLevel: level });
      return;
    }
    const view = uniqueView(snapshot, id.slice(7));
    if (view?.baseGear === undefined) return;
    onCreate({
      base: view.baseGear,
      rarity: uniqueRarityId(snapshot, view) ?? "unique",
      // `min_drop_lvl` is a floor rather than the level: start at the character's where that is
      // already legal, and at the floor where it is not.
      itemLevel: Math.max(level, view.minDropLvl),
      unique: view.id,
    });
  };

  return (
    <div className="card">
      <div className="section-title mt-0">Find an item</div>
      <div className="row wrap mb-3">
        <Picker
          // Keyed on both filters so the input clears its typed query when either changes.
          // Without it, narrowing to Non-unique while "kobold" is still in the box shows "No
          // match" and reads as though the filter found nothing.
          key={`${filter}-${rarityFilter}`}
          options={options}
          value={undefined}
          placeholder={
            rarityFilter === "unique"
              ? "Search a unique…"
              : rarityFilter === "base"
                ? "Search a base…"
                : "Search a base or a unique…"
          }
          width={300}
          onChange={(id) => id !== undefined && pick(id)}
        />
        <div className="row" style={{ gap: 2 }}>
          {FINDER_FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "nudge word primary" : "nudge word"}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 2 }}>
          {RARITY_FILTERS.map((f) => (
            <button
              key={f.id}
              className={rarityFilter === f.id ? "nudge word primary" : "nudge word"}
              title={
                f.id === "base"
                  ? "Every gear base in the pack. One arrives as a rare you can roll affixes onto."
                  : f.id === "unique"
                    ? "Named items only."
                    : "Uniques and bases together, uniques first."
              }
              onClick={() => setRarityFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button onClick={onImport}>Import item…</button>
      </div>
      <span className="faint text-sm">
        Whatever you pick lands in the pool below, unequipped, and opens in the editor. A base
        arrives as a rare with no affixes on it yet; a unique arrives with its own.
      </span>
    </div>
  );
}

/**
 * Everything the build owns, worn or not.
 *
 * **The pool is the whole collection, not the spares.** Worn items are listed here too, with
 * the slot they are in, because "what do I have" and "what am I wearing" are one question asked
 * two ways — and a pool that hid the worn half made loading a build look like it had lost nine
 * items. Equipping never removes anything from this list; it only changes which row carries a
 * slot badge.
 *
 * The left column stays the authority on *where* a thing is. This is the authority on *what
 * there is*, and it is the list that exports.
 */
function ItemPool({
  entries,
  editing,
  onSelect,
  onEquip,
  onUnequip,
  onRemove,
}: {
  entries: readonly PoolEntry[];
  editing: ItemRef | null;
  onSelect: (ref: ItemRef) => void;
  onEquip: (poolIndex: number) => void;
  onUnequip: (gearIndex: number) => void;
  onRemove: (ref: ItemRef) => void;
}): ReactNode {
  const worn = entries.filter((e) => e.slot !== undefined).length;

  return (
    <>
      <div className="section-title">
        Item pool{" "}
        <span className="faint">
          ({entries.length}
          {entries.length > 0 ? ` · ${worn} equipped` : ""})
        </span>
        {entries.length > POOL_ROWS && (
          <span className="faint text-sm" style={{ fontWeight: "normal", marginLeft: 8 }}>
            — scrolling
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="faint text-sm mb-4">
          Nothing yet. Items you search for or import land here, and taking a piece off leaves it
          here too — so comparing two swords never means losing one of them.
        </div>
      ) : (
        /*
         * Past {@link POOL_ROWS} the list scrolls inside itself rather than growing.
         *
         * A worn loadout is nine pieces, so nine rows is the point at which the list stops being
         * "what am I wearing" and starts being a collection — and the collection is unbounded:
         * every item ever searched for or taken off stays here, which is the whole point of the
         * bench. Unbounded, it pushed the item editor below the fold, so choosing between two
         * swords meant scrolling past every sword you own to reach the one you were editing.
         */
        <div className="item-pool" style={{ maxHeight: entries.length > POOL_ROWS ? POOL_MAX : undefined }}>
        {entries.map((entry) => (
          <PoolRow
            key={`${entry.ref.where}-${entry.ref.index}`}
            entry={entry}
            selected={sameRef(editing, entry.ref)}
            onSelect={() => onSelect(entry.ref)}
            onEquip={() => onEquip(entry.ref.index)}
            onUnequip={() => onUnequip(entry.ref.index)}
            onRemove={() => onRemove(entry.ref)}
          />
        ))}
        </div>
      )}
    </>
  );
}

/**
 * One row of the pool.
 *
 * Its own component rather than a block inside the list's `map`, because it hovers: the tooltip
 * is a hook and a hook cannot be called in a loop. The row is otherwise what it was — the badges
 * are what tell two rings apart at a glance, and the tooltip is what tells them apart properly.
 */
function PoolRow({
  entry,
  selected,
  onSelect,
  onEquip,
  onUnequip,
  onRemove,
}: {
  entry: PoolEntry;
  selected: boolean;
  onSelect: () => void;
  onEquip: () => void;
  onUnequip: () => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const tooltip = useItemTooltip(entry.item);

  return (
    <>
      <div
        className={`slot-row${selected ? " selected" : ""}`}
        style={{ cursor: "pointer" }}
        onClick={onSelect}
        {...tooltip.props}
      >
        <GearIcon baseId={entry.item.base} />
        <strong className="ellipsis">{itemName(world.snapshot, entry.item)}</strong>
        <RarityBadge rarity={entry.item.rarity} />
        <span className="badge">ilvl {entry.item.itemLevel}</span>
        {isTwoHanded(world.snapshot, entry.item.base) && <span className="badge warn">2H</span>}
        {entry.slot !== undefined && (
          <span className="badge good" title="Worn — this one is on the character">
            {entry.slot}
          </span>
        )}
        <span className="grow" />
        <CopyItemButton item={entry.item} />
        {entry.slot === undefined ? (
          <button
            title="Wear this. Anything the slot has no room for comes off, back into the pool."
            onClick={(event) => {
              event.stopPropagation();
              onEquip();
            }}
          >
            equip
          </button>
        ) : (
          <button
            title="Take this off. It stays in the pool."
            onClick={(event) => {
              event.stopPropagation();
              onUnequip();
            }}
          >
            take off
          </button>
        )}
        <button
          title="Delete this item from the build entirely"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>
      {tooltip.node}
    </>
  );
}

/**
 * The editor, and what the item under it is worth.
 *
 * One editor for the whole tab rather than one per row. The old panel expanded a card inside
 * the paperdoll, which pushed every slot below it off the screen — so the character you were
 * editing for was not visible while you edited.
 *
 * It ends on a pair: the item as the game draws it, and — beside it — what taking it would change.
 * Two columns because there is room for two, and because reading one against the other is the
 * whole question; stacking them would put the price of the swap below the fold of a thirty-line
 * item window.
 */
function EditorCard({
  item,
  where,
  suppressed,
  diagnostics,
  onChange,
  onRemove,
}: {
  item: Item;
  where: "gear" | "pool";
  suppressed: boolean;
  diagnostics: Diagnostic[];
  onChange: (item: Item) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const slotId = baseGearType(world.snapshot, item.base)?.gearSlot ?? "";

  return (
    <>
      <div className="section-title">
        Editing <span className="faint">{itemName(world.snapshot, item)}</span>{" "}
        {where === "pool" && (
          <span className="badge" title="On the bench — it contributes nothing until you equip it">
            not equipped
          </span>
        )}
      </div>

      {diagnostics.length > 0 && (
        <div className="card mb-0">
          {diagnostics.map((d, i) => (
            <div key={i} className={`diag ${d.severity}`} style={{ borderBottom: "none" }}>
              <span className="dot">{d.severity === "error" ? "✖" : "▲"}</span>
              <span className="grow">{d.message.replace(/`/g, "")}</span>
              <span className="code">{d.code}</span>
            </div>
          ))}
        </div>
      )}

      <ItemEditor item={item} slotId={slotId} onChange={onChange} onRemove={onRemove} />

      {/*
        The item as the game draws it, beside what taking it would change.

        The left half is `ItemWindow` — the same card the hover tooltip draws, laid into the page
        rather than pinned to the pointer. It replaced a flat list of the item's lines: that list
        was every stat the piece grants, flattened into one column, which is the same thing the
        game shows except with the base roll, each affix and the uniques run together so nothing
        said which part of the item a line came from. It also carried no name, no rarity, no
        requirements and no sprite.

        The right half is `ItemDiffCard`: the price of the swap for a candidate, and the price of
        taking the piece off for something already worn.
      */}
      <div className="editor-contribute">
        <div>
          {/*
            No "nothing yet" note above the window any more.

            It said the piece is on the bench, which the "not equipped" badge on the heading
            already says and the diff beside it says better — the whole right-hand column is what
            it *would* add. What it cost was alignment: one column started with a line of prose
            and the other did not, so the item card sat a line lower than the card it is read
            against, on every benched item, which is most of them.

            The two-handed case keeps its note, because nothing else on screen carries it: an
            offhand emptied by the weapon in the other hand is a fact about a *different* slot,
            and the item window has no way to say so.
          */}
          {where === "gear" && suppressed && (
            <div className="faint mb-2">
              Nothing — the offhand is empty while a two-handed weapon is held. The engine still
              sums it, which is why the validator calls this an error rather than a note.
            </div>
          )}

          <ItemWindow item={item} />
        </div>

        {/*
          Its own cell rather than a bare sibling, so the column is held open on the frame before
          the compare store has caught up: the card reads that store, and the effect that fills it
          runs after this render — unwrapped, the window would sit full width for a frame and then
          snap to half as soon as the diff appeared.

          A stack, because one item can have more than one reading. See `diff-stack`.
        */}
        <div className="diff-stack">
          <ItemDiffCard />
        </div>
      </div>
    </>
  );
}

/**
 * One item on the paperdoll.
 *
 * The whole row is the slot's own list — see `SlotPicker`. Clicking anywhere on it puts the piece
 * in the editor and drops the list of what else could go here, with `(none)` at the top to take
 * this one off; the badges are what you need to tell two rings apart while the list is shut.
 *
 * **There is no "off" button any more** on a row that has a list. It was a 24px target at the far
 * end of the line doing what the list's first entry now does, and unlike the button the list says
 * what taking the piece off would cost before you do it. The one row that keeps the button is the
 * one with no list: an item in the pack-added `head` slot sits in no paperdoll row, so there are
 * no alternatives to offer and no `(none)` to offer them under.
 */
function ItemRow({
  item,
  slotLabel,
  overCapacity,
  suppressed,
  selected,
  diagnostics,
  onSelect,
  onOff,
  slot,
}: {
  item: Item;
  slotLabel: string;
  /** Past what the slot holds — kept visible, because hiding it would hide the error too. */
  overCapacity: boolean;
  /** In an offhand a two-handed weapon has emptied. */
  suppressed: boolean;
  selected: boolean;
  diagnostics: Diagnostic[];
  onSelect: () => void;
  /** Take it off, onto the bench. Never a delete — that lives in the editor. */
  onOff: () => void;
  /**
   * What this row's slot list needs to know, when the row has one.
   *
   * Absent for a row the paperdoll has no place for — an item in the pack-added `head` slot —
   * where there is nothing to offer alternatives for. That row keeps the "off" button instead.
   */
  slot?: {
    /** `item`'s index in `doc.gear`. */
    index: number;
    /** Benched pieces whose base belongs in this row, with their pool indices. */
    candidates: { item: Item; i: number }[];
    onEquip: (poolIndex: number) => void;
    onUnequip: (gearIndex: number) => void;
  };
}): ReactNode {
  const world = useWorld();
  const level = useBuild((s) => s.doc.character.level);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const aboveLevel = item.itemLevel > level;
  // What the piece is actually doing, without having to open it — see `ui/ItemTooltip`.
  const tooltip = useItemTooltip(item);

  const content = (
    <>
      <span className="slot-name">{slotLabel}</span>
      {/*
        The hover card hangs off the icon and the name rather than off the whole row.

        The row now *contains* the slot's list, and the list is 300px of rows the pointer has to
        travel through — with the handlers on the row, every one of those moves re-pinned this
        item's card under the cursor, on top of the swap preview the list was drawing. The icon
        and the name are what "hover the item" means anyway.
      */}
      <span className="slot-row-item" {...tooltip.props}>
        <GearIcon baseId={item.base} />
        <strong className="ellipsis">{itemName(world.snapshot, item)}</strong>
      </span>
      <RarityBadge rarity={item.rarity} />
      {isTwoHanded(world.snapshot, item.base) && <span className="badge warn">2H</span>}
      {overCapacity && (
        <span className="badge bad" title="More items in this slot than a character has of it">
          over capacity
        </span>
      )}
      {suppressed && (
        <span
          className="badge bad"
          title="Better Combat empties the offhand while a two-handed weapon is held"
        >
          grants nothing
        </span>
      )}
      {aboveLevel && (
        <span
          className="badge bad"
          title="An item above the character's level contributes nothing at all"
        >
          above your level
        </span>
      )}
      {errors > 0 && (
        <span className="badge bad">
          {errors} error{errors === 1 ? "" : "s"}
        </span>
      )}
      {warnings > 0 && <span className="badge warn">{warnings}</span>}
      <span className="grow" />
    </>
  );

  return (
    <div>
      <div
        className={`slot-row${suppressed ? " suppressed" : ""}${selected ? " selected" : ""}`}
        style={{
          borderColor: errors > 0 ? "#5c3131" : undefined,
          opacity: suppressed ? 0.78 : 1,
        }}
      >
        {slot === undefined ? (
          <>
            <span style={{ display: "contents", cursor: "pointer" }} onClick={onSelect}>
              {content}
            </span>
            <button
              title="Take this off, onto the bench. Nothing is lost — it goes back to the item pool."
              onClick={(event) => {
                event.stopPropagation();
                onOff();
              }}
            >
              off
            </button>
          </>
        ) : (
          <SlotPicker
            label={slotLabel}
            worn={item}
            wornIndex={slot.index}
            candidates={slot.candidates}
            onEquip={slot.onEquip}
            onUnequip={slot.onUnequip}
            onOpen={() => {
              // The row is about to unmount, so its `onMouseLeave` will never fire.
              tooltip.clear();
              onSelect();
            }}
          >
            {content}
          </SlotPicker>
        )}
      </div>
      {tooltip.node}
    </div>
  );
}

/**
 * Put this item on the clipboard as JSON.
 *
 * The same shape `fixtures/` holds and `ImportDialog` reads, so the three ways an item moves —
 * between builds, into a fixture, out of the game — are one shape rather than three. It confirms
 * in place rather than with a notification: at this size a button that does nothing visible reads
 * as a broken button.
 */
function CopyItemButton({ item }: { item: Item }): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      title="Copy this item as JSON — paste it into another build with Import, or into a fixture"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(JSON.stringify(item, null, 2)).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "copied" : "⧉ JSON"}
    </button>
  );
}

/**
 * The omen's row on the paperdoll.
 *
 * `CURIO_BLOCKS` gives `OMEN` a count of 1, so this is one row and not a list. It sits last
 * because it is the only piece whose value depends on everything above it.
 */
function OmenRow({
  open,
  onToggle,
  onChange,
  diagnostics,
}: {
  open: boolean;
  onToggle: () => void;
  onChange: (omen: NonNullable<ReturnType<typeof useBuild.getState>["doc"]["omen"]>| undefined) => void;
  diagnostics: Diagnostic[];
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const omen = doc.omen;

  const word = omenWord(world.snapshot);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  if (omen === undefined) {
    const first = omenIds(world.snapshot)[0];
    return (
      <div className="slot-row empty mt-4">
        <span className="slot-name">{word}</span>
        <button
          disabled={first === undefined}
          onClick={() =>
            first !== undefined &&
            onChange({
              id: first,
              // Its own mods and affixes scale at this, and `lvl_req` gates it at half of
              // MAX_LEVEL, so start where it could actually have dropped.
              itemLevel: Math.max(doc.character.level, omenMinLevelFor(world.snapshot, first)),
              rarity: "rare",
              requires: { NORMAL: 2 },
            })
          }
        >
          + add
        </button>
        <span className="faint text-sm">
          a set bonus paid out by the rest of your gear
        </span>
      </div>
    );
  }

  const filled = countOmenPieces(world.snapshot, doc.gear ?? [], omen, doc.character.level);
  const needed = omenBuckets(world.snapshot, omen).reduce(
    (min, bucket) => Math.min(min, bucket.pieces),
    Number.POSITIVE_INFINITY,
  );
  const active = Number.isFinite(needed) && filled >= needed;

  return (
    <div className="mt-4">
      <div className="slot-row" style={{ cursor: "pointer" }} onClick={onToggle}>
        <span className="slot-name">{word}</span>
        <strong className="ellipsis">{omenName(world.snapshot, omen.id)}</strong>
        <RarityBadge rarity={omen.rarity} />
        <span className="badge">lvl {omen.itemLevel}</span>
        <span className={`badge ${active ? "good" : "warn"}`}>
          {filled} piece{filled === 1 ? "" : "s"}
          {active ? " — active" : " — grants nothing yet"}
        </span>
        {errors > 0 && <span className="badge bad">{errors} error{errors === 1 ? "" : "s"}</span>}
        {warnings > 0 && <span className="badge warn">{warnings}</span>}
        <span className="grow" />
        <span className="faint">{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <>
          {diagnostics.length > 0 && (
            <div className="card mb-0" style={{ borderTop: "none" }}>
              {diagnostics.map((d, i) => (
                <div key={i} className={`diag ${d.severity}`} style={{ borderBottom: "none" }}>
                  <span className="dot">{d.severity === "error" ? "✖" : "▲"}</span>
                  <span className="grow">{d.message.replace(/`/g, "")}</span>
                  <span className="code">{d.code}</span>
                </div>
              ))}
            </div>
          )}
          <OmenEditor
            omen={omen}
            gear={doc.gear ?? []}
            characterLevel={doc.character.level}
            onChange={onChange}
            onRemove={() => {
              onChange(undefined);
              onToggle();
            }}
          />
        </>
      )}
    </div>
  );
}

/** `MAX_LEVEL * lvl_req`, or 1 when the omen is not in the snapshot. */
function omenMinLevelFor(snapshot: Snapshot, id: string): number {
  const view = omenView(snapshot, id);
  return view === undefined ? 1 : omenMinLevel(snapshot, view);
}
