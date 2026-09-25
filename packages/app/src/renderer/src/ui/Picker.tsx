/**
 * A searchable single-select over a registry.
 *
 * A native `<select>` is unusable here: the affix pool for one base runs to a few hundred
 * entries, the spell list is 372, and the ids are not the labels. This filters on both the
 * display name and the id, because a fixture author who knows the id should be able to type it.
 *
 * **Searching on the id is not the same as showing it.** The registry id is the one part of a
 * row a player has never seen: they know "Kobold Influence" and "of the Yeti", not
 * `unique_necklace_kobold` and `suffix_cold_res_3`. Printed on every row it took the width the
 * name and its value needed and made two lists of near-identical ids look like the thing to
 * read. So it lives on the row's hover, where someone writing a fixture can still get at it,
 * and {@link PickerOption.hint} carries what a *player* would use to tell two rows apart.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { At } from "./HoverCard.js";

export type PickerOption = {
  id: string;
  label: string;
  /** Optional right-aligned hint — a tier, a slot, a rarity. */
  hint?: string;
  /** Extra text that should match a search without being displayed. */
  keywords?: string;
  /**
   * What this option would give you, for the row's hover.
   *
   * Several lines is normal and expected — an Augment's stat lines, a unique's mods. The id is
   * appended below it, so a row's hover answers both "what does this do" and "what is it
   * called in the data".
   */
  detail?: string;
  /**
   * Why this option cannot be chosen right now, which also makes it unchoosable.
   *
   * Greyed out rather than filtered out: an affix vanishing from the list reads as "this base
   * cannot roll it", and the real answer — "you already have it" — belongs on the row's hover.
   */
  disabled?: string;
};

/** How many rows the dropdown draws. Anything past this is counted, not dropped silently. */
const MAX_SHOWN = 200;

export function Picker({
  options,
  value,
  onChange,
  placeholder = "Search…",
  allowClear = false,
  width,
  autoFocus = false,
  renderHover,
}: {
  options: readonly PickerOption[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  placeholder?: string;
  allowClear?: boolean;
  width?: number | string;
  /**
   * Take focus, and open, as soon as this mounts.
   *
   * For {@link AddPicker}, which swaps a button out for a picker on click: without it the picker
   * appears closed and the user has to click a second time, on the thing they just clicked.
   */
  autoFocus?: boolean;
  /**
   * A card of the caller's own for the row under the pointer, in place of the browser's `title`.
   *
   * The `title` popup is one flat string in the desktop's colours, which is fine for "what is
   * this" and useless for "what would this do to my build" — a priced answer needs a heading, a
   * table and a moment to compute. Given this, rows carry no `title` at all.
   */
  renderHover?: ((option: PickerOption, at: At) => ReactNode) | undefined;
}): ReactNode {
  const [open, setOpen] = useState(autoFocus);
  const [hover, setHover] = useState<{ option: PickerOption; at: At } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.id === value),
    [options, value],
  );

  /**
   * The matches, and how many were left off the end.
   *
   * The list is still capped — rendering 372 spells into a dropdown is slow and unreadable — but
   * the cap used to be invisible: `slice(0, 200)` and a `break` at 200, with nothing on screen
   * to say so. On a search that matched more than that, the entry you wanted could simply not be
   * in the list and there was no way to tell that from it not existing.
   */
  const { matches, hidden } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found =
      needle.length === 0
        ? options
        : options.filter((option) =>
            `${option.label} ${option.id} ${option.keywords ?? ""}`.toLowerCase().includes(needle),
          );
    return { matches: found.slice(0, MAX_SHOWN), hidden: Math.max(0, found.length - MAX_SHOWN) };
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => document.removeEventListener("mousedown", onDocumentDown);
  }, [open]);

  const commit = (id: string | undefined): void => {
    onChange(id);
    setOpen(false);
    setQuery("");
    setHover(null);
  };

  return (
    <div className="picker" ref={wrapRef} style={{ width: width ?? 220 }}>
      <input
        type="text"
        autoFocus={autoFocus}
        value={open ? query : (selected?.label ?? "")}
        placeholder={selected === undefined ? placeholder : selected.label}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = matches[active];
            if (option && option.disabled === undefined) commit(option.id);
          } else if (event.key === "Escape") {
            setOpen(false);
            setHover(null);
          }
        }}
      />
      {open && (
        <div className="picker-list" onMouseLeave={() => setHover(null)}>
          {allowClear && (
            <div className="picker-option faint" onMouseDown={() => commit(undefined)}>
              (none)
            </div>
          )}
          {matches.length === 0 && <div className="picker-option faint">No match</div>}
          {hidden > 0 && (
            <div className="picker-option faint" style={{ pointerEvents: "none" }}>
              {hidden} more, keep typing to narrow it down
            </div>
          )}
          {matches.map((option, index) => (
            <div
              key={option.id}
              className={`picker-option${index === active ? " active" : ""}${option.disabled === undefined ? "" : " disabled"}`}
              title={
                renderHover === undefined
                  ? [option.disabled, option.detail, option.id]
                      .filter((line) => line !== undefined)
                      .join("\n\n")
                  : undefined
              }
              aria-disabled={option.disabled !== undefined}
              onMouseEnter={() => setActive(index)}
              onMouseMove={
                renderHover === undefined
                  ? undefined
                  : (event) => setHover({ option, at: { x: event.clientX, y: event.clientY } })
              }
              onMouseDown={(event) => {
                // Still keep the list open on a greyed row: the click was a question, not a choice.
                if (option.disabled !== undefined) event.preventDefault();
                else commit(option.id);
              }}
            >
              <span className="ellipsis">{option.label}</span>
              {option.hint !== undefined && <span className="badge">{option.hint}</span>}
            </div>
          ))}
        </div>
      )}
      {open &&
        hover !== null &&
        renderHover !== undefined &&
        createPortal(renderHover(hover.option, hover.at), document.body)}
    </div>
  );
}
