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
import { balance, collectGear, makeEnv, statIndex } from "@cte2/engine";
import {
  SLOT_CAPACITY,
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
  statName,
  type Diagnostic,
  type Item,
} from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { signed, smart } from "../../ui/format.js";
import { AddPicker } from "../../ui/AddPicker.js";
import type { PickerOption } from "../../ui/Picker.js";

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
];

export function GearPanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const addItem = useBuild((s) => s.addItem);
  const updateItem = useBuild((s) => s.updateItem);
  const removeItem = useBuild((s) => s.removeItem);
  const derived = useDerived();

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [omenOpen, setOmenOpen] = useState(false);
  const setOmen = useBuild((s) => s.setOmen);

  const items = doc.gear ?? [];

  /** Which document indices sit in each paperdoll row, and which sit in none. */
  const placement = useMemo(() => {
    const byRow = new Map<string, number[]>();
    const unplaced: number[] = [];

    for (const [index, item] of items.entries()) {
      const slotId = baseGearType(world.snapshot, item.base)?.gearSlot;
      const family = slotId === undefined ? undefined : slotFamily(world.snapshot, slotId);
      const row = PAPERDOLL.find((r) =>
        r.kind === "slot" ? r.id === slotId : r.family === family,
      );
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
  const twoHandedIndex = (placement.byRow.get("weapon") ?? []).find((index) => {
    const item = items[index];
    return item !== undefined && isTwoHanded(world.snapshot, item.base);
  });

  /** Every base this row could hold, for its own picker. */
  const basesFor = (row: SlotRow): PickerOption[] => {
    const bases =
      row.kind === "slot"
        ? world.basesFor(row.id)
        : world.slots.filter((s) => s.family === row.family).flatMap((s) => world.basesFor(s.id));
    return bases.map((base) => ({
      id: base.id,
      label: gearTypeName(world.snapshot, base.id),
      keywords: base.id,
    }));
  };

  // `bases[0]` used to be the answer — whichever base the registry happened to order first,
  // added at `rare` with no affixes, leaving you to find the one you meant in the editor that
  // opened on top of it.
  const addFor = (baseId: string): void => {
    addItem({ base: baseId, rarity: "rare", itemLevel: doc.character.level });
    setOpenIndex(items.length);
  };

  return (
    <div className="panel">
      <div className="row wrap mb-5">
        <button className="primary" onClick={() => setImportOpen(true)}>
          Import item…
        </button>
        <span className="faint text-sm">
          Paste an in-game tooltip (hold Shift over the item first) or the output of
          <code style={{ margin: "0 4px" }}>/data get entity @s SelectedItem</code>.
        </span>
      </div>

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(item) => {
            addItem(item);
            setOpenIndex(items.length);
            setImportOpen(false);
          }}
        />
      )}

      {PAPERDOLL.map((row) => {
        const indices = placement.byRow.get(row.id) ?? [];
        const label = row.kind === "slot" ? slotName(world.snapshot, row.id) : row.family;
        const suppressed = row.id === "offhand" && twoHandedIndex !== undefined;

        return (
          <div key={row.id} className="mb-3">
            {indices.map((index, nth) => (
              <ItemRow
                key={index}
                item={items[index]!}
                index={index}
                slotLabel={nth === 0 ? label : ""}
                overCapacity={nth >= row.capacity}
                suppressed={suppressed}
                open={openIndex === index}
                diagnostics={derived.diagnostics.filter((d) => d.path.startsWith(`gear[${index}]`))}
                onToggle={() => setOpenIndex(openIndex === index ? null : index)}
                onChange={(next) => updateItem(index, next)}
                onRemove={() => {
                  removeItem(index);
                  setOpenIndex(null);
                }}
                onDuplicate={() => {
                  // Deep-cloned: the affix arrays are shared otherwise, and editing the copy
                  // would edit the original.
                  addItem(structuredClone(items[index]!));
                  setOpenIndex(items.length);
                }}
              />
            ))}

            {indices.length < row.capacity && (
              <div className={`slot-row empty${suppressed ? " suppressed" : ""}`}>
                <span className="slot-name">{indices.length === 0 ? label : ""}</span>
                {suppressed ? (
                  <span className="faint text-sm">
                    emptied by the two-handed weapon — an item here would grant nothing
                  </span>
                ) : (
                  <>
                    <AddPicker
                      label="+ add"
                      placeholder={`Which ${row.kind === "slot" ? row.id : row.family}?`}
                      options={basesFor(row)}
                      width={200}
                      onAdd={addFor}
                    />
                    <span className="faint text-sm">
                      {row.capacity > 1 ? `${indices.length} of ${row.capacity}` : "empty"}
                    </span>
                  </>
                )}
              </div>
            )}
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
            These items name a gear slot the mod does not give a character a place for —{" "}
            <code>elytra</code> and <code>head</code> are pack-added slots matching no block in{" "}
            <code>CharacterEquipment.CURIO_BLOCKS</code>. How many you may wear is genuinely
            unanswered, so nothing is enforced and the engine still sums them.
          </div>
          {placement.unplaced.map((index) => (
            <ItemRow
              key={index}
              item={items[index]!}
              index={index}
              slotLabel=""
              overCapacity={false}
              suppressed={false}
              open={openIndex === index}
              diagnostics={derived.diagnostics.filter((d) => d.path.startsWith(`gear[${index}]`))}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
              onChange={(next) => updateItem(index, next)}
              onRemove={() => {
                removeItem(index);
                setOpenIndex(null);
              }}
              onDuplicate={() => {
                // Deep-cloned: the affix arrays are shared otherwise, and editing the copy
                // would edit the original.
                addItem(structuredClone(items[index]!));
                setOpenIndex(items.length);
              }}
            />
          ))}
        </>
      )}

      <JewelList />
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

function ItemRow({
  item,
  index,
  slotLabel,
  overCapacity,
  suppressed,
  open,
  diagnostics,
  onToggle,
  onChange,
  onRemove,
  onDuplicate,
}: {
  item: Item;
  index: number;
  slotLabel: string;
  /** Past what the slot holds — kept visible, because hiding it would hide the error too. */
  overCapacity: boolean;
  /** In an offhand a two-handed weapon has emptied. */
  suppressed: boolean;
  open: boolean;
  diagnostics: Diagnostic[];
  onToggle: () => void;
  onChange: (item: Item) => void;
  onRemove: () => void;
  /** Add a copy of this item. A pair of rings differs in one affix, not in twenty-five clicks. */
  onDuplicate: () => void;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const base = baseGearType(world.snapshot, item.base);
  const slotId = base?.gearSlot ?? "";

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  const preview = useItemPreview(world.snapshot, item, index, doc.character.level);
  const aboveLevel = item.itemLevel > doc.character.level;

  return (
    <div style={{ marginBottom: open ? 6 : 0 }}>
      <div
        className={`slot-row${suppressed ? " suppressed" : ""}`}
        style={{ cursor: "pointer", borderColor: errors > 0 ? "#5c3131" : undefined, opacity: suppressed ? 0.6 : 1 }}
        onClick={onToggle}
      >
        <span className="slot-name">{slotLabel === "" ? (slotId === "" ? "?" : "") : slotLabel}</span>
        <GearIcon baseId={item.base} />
        <strong className="ellipsis">{gearTypeName(world.snapshot, item.base)}</strong>
        <span className="badge">{item.rarity}</span>
        <span className="badge">ilvl {item.itemLevel}</span>
        {item.unique !== undefined && <span className="badge warn">unique</span>}
        {isTwoHanded(world.snapshot, item.base) && <span className="badge warn">2H</span>}
        {overCapacity && (
          <span className="badge bad" title="More items in this slot than a character has of it">
            over capacity
          </span>
        )}
        {suppressed && (
          <span className="badge bad" title="Better Combat empties the offhand while a two-handed weapon is held">
            grants nothing
          </span>
        )}
        {aboveLevel && (
          <span className="badge bad" title="An item above the character's level contributes nothing at all">
            above your level
          </span>
        )}
        {errors > 0 && <span className="badge bad">{errors} error{errors === 1 ? "" : "s"}</span>}
        {warnings > 0 && <span className="badge warn">{warnings}</span>}
        <span className="grow" />
        {/*
          Copy, then duplicate. Both stop the row's own click, which would otherwise collapse the
          card the copy just opened.

          `Copy item` writes the document's own JSON, which `ImportDialog` reads back — so an item
          moves between two builds, or into a fixture, without being rebuilt by hand. Duplicate is
          the same move within one build and does not go via the clipboard, because it does not
          need to and because a clipboard round trip would be a silent way to lose a field.
        */}
        <CopyItemButton item={item} />
        <button
          title="Add a copy of this item"
          onClick={(event) => {
            event.stopPropagation();
            onDuplicate();
          }}
        >
          ⧉
        </button>
        <span className="faint">{open ? "▾" : "▸"}</span>
      </div>

      {!open && preview.lines.length > 0 && (
        <div className="faint ellipsis text-sm" style={{ padding: "0 6px 3px 88px" }}>
          {preview.lines.slice(0, 3).join(" · ")}
          {preview.lines.length > 3 ? ` · +${preview.lines.length - 3} more` : ""}
        </div>
      )}

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

          <ItemEditor item={item} slotId={slotId} onChange={onChange} onRemove={onRemove} />

          <div className="card" style={{ marginTop: -8 }}>
            <div className="section-title mt-0">
              What this item contributes
            </div>
            {suppressed ? (
              <div className="faint">
                Nothing — the offhand is empty while a two-handed weapon is held. The engine
                still sums it, which is why the validator calls this an error rather than a note.
              </div>
            ) : preview.lines.length === 0 ? (
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
      )}
    </div>
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
        <span className="badge">{omen.rarity}</span>
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
 * `collectGear` applies the item-level scaling and the roll interpolation exactly as the sheet
 * does, so this preview and the sidebar cannot disagree. It also means the "above your level
 * contributes nothing" rule shows up here for free rather than needing a special case.
 */
function useItemPreview(
  snapshot: Snapshot,
  item: Item,
  index: number,
  characterLevel: number,
): { lines: string[] } {
  return useMemo(() => {
    const env = makeEnv(snapshot, statIndex(snapshot), balance(snapshot), characterLevel);
    const contexts = collectGear(env, [item]);

    // Several contexts (base, each affix, gems, runes) all feed one item; the preview wants
    // the totals per stat, not one line per source.
    const totals = new Map<string, { flat: number; percent: number; more: number }>();
    for (const context of contexts) {
      for (const mod of context.stats) {
        let bucket = totals.get(mod.statId);
        if (!bucket) {
          bucket = { flat: 0, percent: 0, more: 0 };
          totals.set(mod.statId, bucket);
        }
        if (mod.type === "FLAT") bucket.flat += mod.value;
        else if (mod.type === "PERCENT") bucket.percent += mod.value;
        else bucket.more += mod.value;
      }
    }

    const lines: string[] = [];
    for (const [statId, bucket] of totals) {
      const name = statName(snapshot, statId);
      if (bucket.flat !== 0) lines.push(`${signed(bucket.flat)} ${name}`);
      if (bucket.percent !== 0) lines.push(`${signed(bucket.percent)}% Increased ${name}`);
      if (bucket.more !== 0) {
        lines.push(
          bucket.more < 0
            ? `${smart(-bucket.more)}% Less ${name}`
            : `${smart(bucket.more)}% More ${name}`,
        );
      }
    }
    return { lines };
    // `index` is in the deps so a reordered list rebuilds its previews.
  }, [snapshot, item, index, characterLevel]);
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
