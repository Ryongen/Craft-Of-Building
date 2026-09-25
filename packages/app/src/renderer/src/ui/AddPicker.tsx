/**
 * An "add" button that asks what to add.
 *
 * The pattern this replaces was everywhere: a button that added `list[0]` — the first base for
 * the slot, the first spell id in the registry, the first gem, the first rune — and then left you
 * to find the real one in the editor that opened. `SupportGemPicker`'s own header comment already
 * called it out as a bug it had fixed for gems; it was still live in eight other places.
 *
 * It is worse than it sounds, because element zero is not a neutral default. It is whatever the
 * registry happened to order first, so "Add skill" on a fresh bar added a specific spell nobody
 * chose, and a build document that was never edited further silently claimed the character had
 * it. A picker cannot make that mistake: nothing is added until something is named.
 *
 * Renders as a button until it is pressed, then as a {@link Picker} with the list open — so the
 * common case costs one click and a search, and the row does not grow a permanently-open combo
 * box that reads as a filter.
 */

import { useState, type ReactNode } from "react";

import type { At } from "./HoverCard.js";
import { Picker, type PickerOption } from "./Picker.js";

export function AddPicker({
  label,
  options,
  onAdd,
  disabled = false,
  title,
  placeholder,
  width,
  primary = false,
  renderHover,
}: {
  /** The button's text — "Add skill", "Add gem". */
  label: string;
  options: readonly PickerOption[];
  onAdd: (id: string) => void;
  disabled?: boolean;
  /** Why it is disabled, or what it does. */
  title?: string;
  /** The picker's own prompt. Defaults to the button's label. */
  placeholder?: string;
  width?: number | string;
  primary?: boolean;
  /** Passed to the picker — see {@link Picker}. */
  renderHover?: ((option: PickerOption, at: At) => ReactNode) | undefined;
}): ReactNode {
  const [picking, setPicking] = useState(false);

  // Nothing to choose from is a different state from "not chosen yet", and offering a picker
  // over an empty list is a dead end. The button stays, disabled, with its reason on the hover.
  const empty = options.length === 0;

  if (!picking || disabled || empty) {
    return (
      <button
        className={primary ? "primary" : undefined}
        disabled={disabled || empty}
        title={empty && title === undefined ? "Nothing available to add" : title}
        onClick={() => setPicking(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <Picker
      options={options}
      value={undefined}
      autoFocus
      placeholder={placeholder ?? label}
      {...(width === undefined ? {} : { width })}
      renderHover={renderHover}
      onChange={(id) => {
        setPicking(false);
        // `undefined` is the picker's "cleared" answer, which here means the user dismissed it
        // without choosing. Adding nothing is the right response to that.
        if (id !== undefined) onAdd(id);
      }}
    />
  );
}
