/**
 * The filter box above a long list.
 *
 * Five of these existed — the stat sheet, the capture table, the diagnostics list, the tree search
 * and the gem picker — and they had drifted in two ways worth fixing rather than preserving:
 *
 * - one was `type="text"`, so it alone had no clear button;
 * - **none of them cleared on Escape**, which is the one gesture a filter box owes you. Typing
 *   into a 223-row sheet and then wanting all 223 back meant selecting the text and deleting it.
 *
 * That second point is why this is a component at all. Wrapping six lines of `<input>` in another
 * six lines of `<input>` would be pure indirection; giving all five a behaviour none of them had,
 * once, is not.
 *
 * Escape only clears when there is something to clear. An empty box lets the key through, so a
 * filter inside a dialog does not swallow the Escape that was meant to close the dialog.
 */

import type { ReactNode } from "react";

export function SearchInput({
  value,
  onChange,
  placeholder,
  width,
  grow = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Fixed pixel width, where the layout wants one. */
  width?: number;
  /** Take the remaining space on the row instead. */
  grow?: boolean;
}): ReactNode {
  return (
    <input
      type="search"
      className={grow ? "grow" : undefined}
      placeholder={placeholder}
      value={value}
      style={width === undefined ? undefined : { width }}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || value.length === 0) return;
        event.stopPropagation();
        onChange("");
      }}
    />
  );
}
