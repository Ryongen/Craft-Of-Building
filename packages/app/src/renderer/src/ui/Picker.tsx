/**
 * A searchable single-select over a registry.
 *
 * A native `<select>` is unusable here: the affix pool for one base runs to a few hundred
 * entries, the spell list is 372, and the ids are not the labels. This filters on both the
 * display name and the id, because a fixture author who knows the id should be able to type it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type PickerOption = {
  id: string;
  label: string;
  /** Optional right-aligned hint — a tier, a slot, a rarity. */
  hint?: string;
  /** Extra text that should match a search without being displayed. */
  keywords?: string;
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
}): ReactNode {
  const [open, setOpen] = useState(autoFocus);
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
            if (option) commit(option.id);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="picker-list">
          {allowClear && (
            <div className="picker-option faint" onMouseDown={() => commit(undefined)}>
              (none)
            </div>
          )}
          {matches.length === 0 && <div className="picker-option faint">No match</div>}
          {hidden > 0 && (
            <div className="picker-option faint" style={{ pointerEvents: "none" }}>
              {hidden} more — keep typing to narrow it down
            </div>
          )}
          {matches.map((option, index) => (
            <div
              key={option.id}
              className={`picker-option${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={() => commit(option.id)}
            >
              <span className="ellipsis">{option.label}</span>
              {option.hint !== undefined && <span className="badge">{option.hint}</span>}
              <span className="id">{option.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
