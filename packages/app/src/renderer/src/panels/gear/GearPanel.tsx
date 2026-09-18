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
 * Each item's preview runs `collectGear` — the same collector the character sheet uses — so a
 * line shown here cannot disagree with the total in the sidebar.
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
  gearTypeName,
  isTwoHanded,
  slotFamily,
  slotName,
  unique as uniqueView,
  uniqueName,
  uniqueRarityId,
  type Diagnostic,
  type Item,
} from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useItemCompare } from "../../state/item-compare.js";
import { useWorld } from "../../state/snapshot.js";
import { itemLines } from "../../ui/item-stats.js";
import { useItemTooltip } from "../../ui/ItemTooltip.js";
import { RarityBadge } from "../../ui/RarityBadge.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { AugmentList } from "../../ui/Augments.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { modDetail, modKeywords } from "../../ui/mods.js";

import { ImportDialog } from "./ImportDialog.js";
import { ItemEditor } from "./ItemEditor.js";
import { OmenEditor, omenName, omenWord } from "./OmenEditor.js";
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
   * Publish the selected item to the sidebar, with whatever it would take the place of.
   *
   * Which piece comes off is not a guess: `equip` displaces `occupying.length - (capacity - 1)`
   * items oldest-first, so for a full slot that is `occupying[0]` and for a slot with room it is
   * nothing at all. Reading the same rule here is what keeps the diff a statement about the
   * click you are about to make rather than about a swap the panel would not perform.
   *
   * A worn item has nothing to compare against — selecting your own boots is not a swap — and
   * the sidebar shows what they contribute instead.
   */
  const showCompare = useItemCompare((s) => s.show);
  const clearCompare = useItemCompare((s) => s.clear);

  useEffect(() => {
    if (editing === null || target === undefined) {
      clearCompare();
      return;
    }
    const entry = poolEntries.find((e) => sameRef(editing, e.ref));
    const row = rowFor(world.snapshot, target);
    const occupying = row === undefined ? [] : (placement.byRow.get(row.id) ?? []);
    const capacity = row?.capacity ?? 1;
    const displaced =
      editing.where === "gear"
        ? undefined
        : occupying.slice(0, Math.max(0, occupying.length - (capacity - 1)))[0];

    showCompare({
      item: target,
      against: displaced === undefined ? undefined : items[displaced],
      where: editing.where,
      slotLabel:
        entry?.slot ??
        (row === undefined
          ? undefined
          : row.kind === "slot"
            ? slotName(world.snapshot, row.id)
            : row.family),
    });
  }, [editing, target, poolEntries, placement, items, world.snapshot, showCompare, clearCompare]);

  // Leaving the tab takes the card with it: it is about a choice being made in this panel, and
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

/** A unique is known by its own name; everything else by its base. */
function itemLabel(snapshot: Snapshot, item: Item): string {
  return item.unique === undefined
    ? gearTypeName(snapshot, item.base)
    : uniqueName(snapshot, item.unique);
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
  const world = useWorld();

  return (
    <div className={`slot-row empty${suppressed ? " suppressed" : ""}`}>
      <span className="slot-name">{label}</span>
      {suppressed ? (
        <span className="faint text-sm">emptied by the two-handed weapon</span>
      ) : candidates.length === 0 ? (
        <span className="faint text-sm">empty — nothing in the pool fits here</span>
      ) : (
        <AddPicker
          label="equip…"
          placeholder={`Which ${label.toLowerCase()}?`}
          width={190}
          options={candidates.map(({ item, i }) => ({
            id: String(i),
            label: itemLabel(world.snapshot, item),
            hint: item.rarity,
          }))}
          onAdd={(id) => onEquip(Number(id))}
        />
      )}
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
        <strong className="ellipsis">{itemLabel(world.snapshot, entry.item)}</strong>
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
  const level = useBuild((s) => s.doc.character.level);
  const slotId = baseGearType(world.snapshot, item.base)?.gearSlot ?? "";
  const preview = useItemPreview(world.snapshot, item, 0, level);

  return (
    <>
      <div className="section-title">
        Editing <span className="faint">{itemLabel(world.snapshot, item)}</span>{" "}
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

      <div className="card" style={{ marginTop: -8 }}>
        <div className="section-title mt-0">What this item contributes</div>
        {where === "pool" && (
          <div className="faint mb-2">
            Nothing yet — this item is on the bench. Below is what it would add if you equipped
            it.
          </div>
        )}
        {where === "gear" && suppressed && (
          <div className="faint mb-2">
            Nothing — the offhand is empty while a two-handed weapon is held. The engine still
            sums it, which is why the validator calls this an error rather than a note.
          </div>
        )}
        {preview.lines.length === 0 ? (
          <div className="faint">Nothing.</div>
        ) : (
          preview.lines.map((line, i) => (
            <div key={i} className="text-md" style={{ color: "var(--good)" }}>
              {line}
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * One item on the paperdoll.
 *
 * A row, not a disclosure: clicking it selects the item for the single editor in the middle
 * column. The badges are what you need to tell two rings apart at a glance, and the preview
 * line under it is what the piece is actually doing.
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
}): ReactNode {
  const world = useWorld();
  const level = useBuild((s) => s.doc.character.level);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const aboveLevel = item.itemLevel > level;
  // What the piece is actually doing, without having to open it — see `ui/ItemTooltip`.
  const tooltip = useItemTooltip(item);

  return (
    <div>
      <div
        className={`slot-row${suppressed ? " suppressed" : ""}${selected ? " selected" : ""}`}
        style={{
          cursor: "pointer",
          borderColor: errors > 0 ? "#5c3131" : undefined,
          opacity: suppressed ? 0.78 : 1,
        }}
        onClick={onSelect}
        {...tooltip.props}
      >
        <span className="slot-name">{slotLabel}</span>
        <GearIcon baseId={item.base} />
        <strong className="ellipsis">{itemLabel(world.snapshot, item)}</strong>
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
        <button
          title="Take this off, onto the bench. Nothing is lost — it goes back to the item pool."
          onClick={(event) => {
            event.stopPropagation();
            onOff();
          }}
        >
          off
        </button>
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

/**
 * The item's resolved contribution, through the engine's own collector.
 *
 * The summation itself is `ui/item-stats`, because three things now ask this question — this
 * preview, the hover tooltip and the sidebar's swap diff — and three copies of it would be three
 * opinions about what an item grants. What stays here is the memo: the preview is on the render
 * path of a list, and `collectGear` is not free.
 */
function useItemPreview(
  snapshot: Snapshot,
  item: Item,
  index: number,
  characterLevel: number,
): { lines: string[] } {
  return useMemo(
    () => ({ lines: itemLines(snapshot, item, characterLevel) }),
    // `index` is in the deps so a reordered list rebuilds its previews.
    [snapshot, item, index, characterLevel],
  );
}

/**
 * The item's sprite, resolved out of whichever mod owns it.
 *
 * Renders nothing at all when there is none rather than a placeholder: the only gear that
 * fails to resolve is vanilla, whose textures live in the client jar, and a wrong glyph beside
 * the right name is worse than no glyph.
 */
function GearIcon({ baseId }: { baseId: string }): ReactNode {
  const world = useWorld();
  const url = world.gearIcon(baseId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt=""
      width={20}
      height={20}
      // Minecraft sprites are 16x16; smoothing them turns a crisp icon to mush.
      style={{ imageRendering: "pixelated", flex: "0 0 auto" }}
    />
  );
}
