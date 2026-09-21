/**
 * The item, drawn the way the game draws it.
 *
 * Two places need this card, and for the same reason. `useItemTooltip` pins it to the pointer so
 * a row in a list can be read without opening it; the Items panel lays the same card into the
 * page beside the editor, because "what does this grant" is the question the editor is asking
 * about the item in it. One component rather than two, so the card in the panel and the card
 * under the pointer cannot disagree about what an item says — and so a fix to the card is a fix
 * in both.
 *
 * ## Two cards, one shell
 *
 * `JewelWindow` is the second, and a jewel is different enough to need it: no base, no
 * implicit, no sockets, no level gate, one affix list instead of two, and a Watcher's Eye's
 * conditional lines on top. It shares the shell, the headings and the colouring — the parts a
 * player recognises as "the tooltip" — and nothing else, because everything else about the two
 * items is genuinely different.
 *
 * ## The icon
 *
 * The header's frame holds the item's own sprite, resolved out of whichever mod owns it by
 * `GearIcon`. It used to hold an empty `<div className="tt-icon-placeholder">` that no rule ever
 * drew, so every card in the app showed a blank square where the item's picture belongs. Vanilla
 * gear still shows the bare frame — its textures are in the client jar rather than under
 * `mods/`, and the extractor's rule is to report that gap rather than invent a glyph for it.
 *
 * ## Floating or laid in
 *
 * `floating` is the hover case: `position: fixed` at the pointer, portalled into `document.body`
 * so no scroll box can clip it, click-through. Laid into the panel it is an ordinary block.
 *
 * The footer's in-game hotkey hints are commented out rather than deleted: Shift, Ctrl and Alt do
 * nothing on this card yet, and a legend for three keys that do nothing reads as a feature the
 * reader cannot find. The markup is still there, a key away from being true again.
 */

import type { Item, Jewel } from "@cte2/schema";
import {
  affix,
  auraName,
  gearTypeName,
  isAuraEnabled,
  itemName,
  jewelItemId,
  jewelName,
  statName,
  uniqueName,
} from "@cte2/schema";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { checkRequirements } from "@cte2/engine";
import { useBuild } from "../state/build-store.js";
import { useDerived } from "../state/derived.js";
import { useWorld } from "../state/snapshot.js";
import { GearIcon, ItemIcon } from "./GearIcon.js";
import { itemSections, jewelSections, type ItemSection, type StatLine } from "./item-stats.js";

/**
 * The card's assumed size, for flipping it near the edge of the window.
 *
 * Assumed rather than measured: it is only ever a few dozen pixels out, and measuring would mean
 * a second render on every mouse move.
 */
const CARD = { width: 320, height: 350 };

type At = { x: number; y: number };

/**
 * Split a resolved stat line into its numbers and its words.
 *
 * The engine hands back `"+40 Armor"` as one string and the game colours the halves differently —
 * the value green, the stat white — so the line is cut on the run that looks like a number. Done
 * here rather than by the callers because every section prints lines and they must colour alike.
 */
function renderFormattedStatLine(line: string): ReactNode {
  const parts: string[] = line.split(/([\+\-]?\d+(?:\.\d+)?%?\w?)/g);

  return parts.map((part: string, index: number) => {
    const isValue = /[\+\-]?\d+(?:\.\d+)?%?\w?/.test(part);
    return (
      <span key={index} className={isValue ? "stat-val" : "stat-text"}>
        {part}
      </span>
    );
  });
}

export function useItemTooltip(item: Item | undefined) {
  const [at, setAt] = useState<At | null>(null);

  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => setAt(null), []);

  return {
    props: { onMouseEnter: track, onMouseMove: track, onMouseLeave: clear },
    /**
     * Take the card down without the pointer having left.
     *
     * `onMouseLeave` is the normal way out and it does not fire when the element carrying these
     * handlers is *unmounted* under the cursor — which is exactly what a paperdoll row does when
     * it swaps itself for its slot list. The card then hung around over the list, pinned to a
     * position the pointer had long since moved on from.
     */
    clear,
    node:
      at === null || item === undefined
        ? null
        : createPortal(<ItemWindow item={item} floating at={at} />, document.body),
  };
}

/**
 * Where to put a floating card, given the pointer.
 *
 * Flipped towards the inside of the window when it would otherwise run off the right or the
 * bottom edge, because a tooltip half off the screen is one you have to move the mouse to read.
 */
function floatingStyle(at: At): CSSProperties {
  const flipX = at.x > window.innerWidth - CARD.width - 24;
  const flipY = at.y > window.innerHeight - CARD.height;
  return {
    left: flipX ? undefined : at.x + 16,
    right: flipX ? window.innerWidth - at.x + 16 : undefined,
    top: flipY ? undefined : at.y + 16,
    bottom: flipY ? window.innerHeight - at.y + 16 : undefined,
  };
}

/**
 * The card itself, with no opinion about where it goes.
 *
 * `floating` changes exactly two things: the element is positioned against the viewport at `at`
 * rather than flowing into its parent, and the hotkey hints in the footer are drawn.
 *
 * It is exported because the Items panel draws it too — see `EditorCard` in `GearPanel`, where it
 * is the item editor's answer to "what is this piece worth" and sits beside the swap diff.
 */
export function ItemWindow({
  item,
  floating = false,
  at,
}: {
  item: Item;
  /** Pinned to the viewport at `at`, as a hover card. */
  floating?: boolean;
  /** Where the pointer is. Read only when `floating`. */
  at?: At;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const stats = useDerived().stats;
  const level = useBuild((s) => s.doc.character.level);

  // Requirements checks
  const checks = useMemo(
    () => checkRequirements(snapshot, item, stats),
    [snapshot, item, stats]
  );
  const isLevelMet = item.itemLevel <= level;

  // Stat lines, split by the part of the item that produced them — base, implicits, each affix
  // list, uniques, runes and gems. The engine tags every modifier with its origin, so this is a
  // regroup of one collection pass rather than five passes over doctored copies of the item.
  const sections = useMemo(
    () => itemSections(snapshot, item, level),
    [snapshot, item, level]
  );

  // The name the game builds: strongest prefix, the implicit-or-base, strongest suffix. The
  // subtitle then says what it *is*, because the title often no longer does — an implicit
  // renames the base outright ("Amethyst Ring", not "Ring"), so a player reading "Azure
  // Amethyst Ring of Venom" still needs to be told it is a ring. It is dropped when the title
  // is already the base, which is the plain, affixless case.
  const name = itemName(snapshot, item);
  const base = gearTypeName(snapshot, item.base);
  const baseTypeName = name === base ? null : base;

  const rarityClass = `rarity-${(item.rarity ?? "common").toLowerCase()}`;

  const hasRequirements = checks.length > 0 || item.itemLevel > 0;

  return (
    <div
      className={`item-window ${rarityClass}${floating ? " floating" : ""}`}
      style={floating && at !== undefined ? floatingStyle(at) : undefined}
    >
      {/* 1. Header */}
      <div className="tt-header">
        <div className="tt-icon-frame">
          <GearIcon baseId={item.base} size={30} />
        </div>
        <div className="tt-title-container">
          <div className="tt-title">{name}</div>
          {baseTypeName && <div className="tt-subtitle">{baseTypeName}</div>}
        </div>
      </div>

      <div className="tt-divider" />

      {/* 2. Requirements */}
      {hasRequirements && (
        <>
          <div className="tt-section tt-requirements">
            {item.itemLevel > 0 && (
              <div className={`tt-req ${isLevelMet ? "met" : "unmet"}`}>
                <span className="tt-icon">{isLevelMet ? "✔" : "✘"}</span>
                <span>Player Level Min: {item.itemLevel}</span>
              </div>
            )}

            {checks.map((check: { statId: string; required: number; met: boolean }) => (
              <div key={check.statId} className={`tt-req ${check.met ? "met" : "unmet"}`}>
                <span className="tt-icon">{check.met ? "✔" : "✘"}</span>
                <span>
                  {statName(snapshot, check.statId)} Min: {check.required}
                </span>
              </div>
            ))}
          </div>

          <div className="tt-divider" />
        </>
      )}

      {/* 3. Stat Categories */}
      <div className="tt-section tt-stats">
        {sections.map((section) => (
          <CategoryGroup key={section.kind} section={section} />
        ))}
      </div>

      <div className="tt-divider" />

      {/* 4. Sockets */}
      {item.sockets && item.sockets.length > 0 && (
        <>
          <div className="tt-section tt-sockets">
            {item.sockets.map((_: string, i: number) => (
              <div key={i} className="tt-socket-line">[Socket]</div>
            ))}
          </div>
          <div className="tt-divider" />
        </>
      )}

      {/* 5. Footer */}
      <div className="tt-footer">
        <div className="tt-rarity-label">{item.rarity ? `${item.rarity} Item` : "Item"}</div>
        {/*
          The game's own footer hints, kept verbatim for when the keys they name exist here.

          In game Shift expands every roll to its range, Ctrl folds the card and Alt swaps the
          stats for the flavour text. This card does none of the three, so the line was an
          instruction for three keys that do nothing — worse than no line, because it reads as a
          feature the reader cannot find. Restore it a key at a time, as each one lands.

          <div className="tt-hotkeys">
            <span className="key">[Shift]</span> Detail <span className="key">[Ctrl]</span> Hide{" "}
            <span className="key">[Alt]</span> Desc
          </div>
        */}
      </div>
    </div>
  );
}

/**
 * One heading and the lines under it, coloured the way the game colours that heading.
 *
 * Shared by both cards rather than closed over inside one of them, because a jewel's sections
 * and an item's are the same thing printed the same way — the only difference is which list
 * produced them.
 */
function CategoryGroup({ section }: { section: ItemSection }): ReactNode {
  if (section.lines.length === 0) return null;

  return (
    <div className="tt-category-group">
      <div className={`tt-category-title ${section.kind}`}>{section.label}:</div>
      {section.lines.map((line: StatLine, i: number) => (
        // `worse` rather than "negative": the game colours a line by `minus_is_good`, so −15
        // Mana Cost stays green and −40% Attack Speed does not. `totalLines` has already
        // applied that rule — this only paints what it decided.
        <div key={i} className={`tt-line${line.good ? "" : " worse"}`} title={line.statId}>
          {renderFormattedStatLine(line.text)}
        </div>
      ))}
    </div>
  );
}

/**
 * `useItemTooltip` for a jewel.
 *
 * Its own hook rather than a union on the other one because the two cards take different
 * things and answer to different collectors; sharing the pointer tracking is all that was
 * worth sharing, and that is three lines.
 */
export function useJewelTooltip(jewel: Jewel | undefined) {
  const [at, setAt] = useState<At | null>(null);

  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => setAt(null), []);

  return {
    props: { onMouseEnter: track, onMouseMove: track, onMouseLeave: clear },
    clear,
    node:
      at === null || jewel === undefined
        ? null
        : createPortal(<JewelWindow jewel={jewel} floating at={at} />, document.body),
  };
}

/**
 * A jewel, drawn as the game draws it.
 *
 * The same card as {@link ItemWindow} — same shell, same headings, same colours — over a
 * different item. What differs is what a jewel *has*: no base and so no base stats, no
 * implicit, no sockets, and one undivided affix list rather than prefixes and suffixes.
 *
 * ## No requirements block
 *
 * A jewel's level is not a gate. `GearData.isUsableBy` refuses an item above the character's
 * level and `checkRequirements` reads the `req_*` stats off a gear base — a jewel has neither,
 * and `collectJewels` accordingly checks nothing before resolving the rolls. Printing "Player
 * Level Min" here would be a rule this item does not have. The level still decides what every
 * roll is worth, so it goes in the footer, stated rather than judged.
 *
 * ## The one gate a jewel does have
 *
 * A socket. It is not on this card because it is not a property of the jewel — the same jewel
 * one socket further up the list is worth everything it says here. The list badges it and the
 * panel explains it; see `JewelList`.
 */
export function JewelWindow({
  jewel,
  floating = false,
  at,
}: {
  jewel: Jewel;
  /** Pinned to the viewport at `at`, as a hover card. */
  floating?: boolean;
  /** Where the pointer is. Read only when `floating`. */
  at?: At;
}): ReactNode {
  const { snapshot } = useWorld();
  const level = useBuild((s) => s.doc.character.level);
  const auras = useBuild((s) => s.doc.auras);

  /**
   * The auras the build is actually running, which is what decides whether a Watcher's Eye
   * line counts. The build's own set rather than "all of them", so the card and the sheet
   * cannot disagree about a stat that is switched off.
   */
  const aurasOn = useMemo(
    () => new Set((auras ?? []).filter(isAuraEnabled).map((aura) => aura.id)),
    [auras],
  );

  const sections = useMemo(
    () => jewelSections(snapshot, jewel, level, aurasOn),
    [snapshot, jewel, level, aurasOn],
  );

  /**
   * Aura lines the jewel carries that are not currently live.
   *
   * They are absent from `sections` by design — the card prints what the sheet counts — but
   * absent with no explanation reads as a broken Watcher's Eye. Named by their aura, so the
   * reader knows which switch turns them back on.
   */
  const dormant = useMemo(() => {
    const names = new Set<string>();
    for (const line of jewel.auraStats ?? []) {
      const required = affix(snapshot, line.affixId)?.eyeAuraReq ?? "";
      if (required.length > 0 && !aurasOn.has(required)) names.add(auraName(snapshot, required));
    }
    return [...names].sort();
  }, [snapshot, jewel, aurasOn]);

  const name = jewelName(snapshot, jewel);
  // The unique is in the subtitle, not the title, because `JewelItemData.getItem()` does not
  // consult it — a Watcher's Eye crafted onto a Viridian Jewel is still called a Viridian
  // Jewel in game, and the tooltip is where the unique is named.
  const unique = jewel.unique === undefined ? null : uniqueName(snapshot, jewel.unique.id);
  const rarityClass = `rarity-${(jewel.rarity ?? "common").toLowerCase()}`;

  return (
    <div
      className={`item-window ${rarityClass}${floating ? " floating" : ""}`}
      style={floating && at !== undefined ? floatingStyle(at) : undefined}
    >
      <div className="tt-header">
        <div className="tt-icon-frame">
          <ItemIcon itemId={jewelItemId(jewel)} size={30} />
        </div>
        <div className="tt-title-container">
          <div className="tt-title">{name}</div>
          {unique !== null && <div className="tt-subtitle">{unique}</div>}
        </div>
      </div>

      <div className="tt-divider" />

      <div className="tt-section tt-stats">
        {sections.length === 0 ? (
          <div className="tt-line">
            <span className="stat-text">No stats</span>
          </div>
        ) : (
          sections.map((section) => <CategoryGroup key={section.kind} section={section} />)
        )}
      </div>

      {dormant.length > 0 && (
        <>
          <div className="tt-divider" />
          <div className="tt-section tt-dormant">
            {dormant.map((aura) => (
              <div key={aura}>Needs {aura} — not running</div>
            ))}
          </div>
        </>
      )}

      <div className="tt-divider" />

      <div className="tt-footer">
        <div className="tt-rarity-label">{jewel.rarity ? `${jewel.rarity} Jewel` : "Jewel"}</div>
        {/* Not a requirement — see the note above. Every roll on the card is resolved at it. */}
        <div className="tt-durability">Item Level {jewel.itemLevel}</div>
      </div>
    </div>
  );
}
