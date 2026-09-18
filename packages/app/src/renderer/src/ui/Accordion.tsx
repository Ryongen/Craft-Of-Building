/**
 * A titled section that can be folded away.
 *
 * The item editor was eleven stacked lists with no way to put any of them down: implicits,
 * prefixes, suffixes, corruptions, sockets, runewords, two kinds of enchantment and the base
 * stats, every one of them fully drawn whether or not the item had anything in it. Editing a
 * suffix meant scrolling past four empty sections to reach it, and the summary of what the item
 * was actually worth sat below all of them, off the bottom of the window.
 *
 * So each list folds, and the ones people open first are the ones that start open. `count` is
 * what makes a folded row still worth reading — "Corruptions 0" is a section you can leave
 * folded and know you have lost nothing, which is the whole bargain a collapsed section makes.
 *
 * It renders the `.collapsible` classes the Augment rows already use, with an `accordion`
 * modifier for the tighter spacing this column needs, so the two read as the same control.
 *
 * ## Why the body is kept mounted
 *
 * `hidden` rather than unmounting: the affix rows hold picker state and a draft roll, and
 * unmounting the body threw both away — folding a section while a picker was open and unfolding
 * it put you back at the top of an unsearched list. The cost is that a collapsed section still
 * renders, which at this size is a handful of rows, and the benefit is that folding never loses
 * anything.
 */

import { useState, type ReactNode } from "react";

export function Accordion({
  title,
  count,
  summary,
  defaultOpen = false,
  tone,
  children,
}: {
  title: string;
  /** How many entries the section holds, shown beside the title so a folded row still says. */
  count?: number | undefined;
  /** A short line on the right of the header — the state of the thing while it is folded. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** `warn` or `bad`, to carry a problem out of a folded section onto its header. */
  tone?: "warn" | "bad" | undefined;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`collapsible accordion${open ? " open" : ""}`}>
      <div
        className="collapsible-head"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span className="faint caret">{open ? "▾" : "▸"}</span>
        <strong>{title}</strong>
        {count !== undefined && (
          <span className={tone === undefined ? "badge" : `badge ${tone}`}>{count}</span>
        )}
        {summary !== undefined && (
          <span className="faint grow ellipsis text-sm accordion-summary">{summary}</span>
        )}
      </div>

      {/* Kept in the tree while folded — see the note above on picker state. */}
      <div className="collapsible-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
