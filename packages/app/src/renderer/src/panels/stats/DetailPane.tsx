/**
 * A tab's own drill-down, docked to the bottom of it.
 *
 * Three screens want the same thing — the Stats tab, the Damage tab and the Defence tab — and
 * they want it in the same place with the same behaviour: click a number, the explanation opens
 * under it, drag the splitter to make room, click the same number again to close it. Written
 * three times that would be three slightly different panes; this is the one.
 *
 * The sidebar deliberately does **not** use it. That pane is part of the shell rather than part
 * of a tab: it stays where it is while you change tab, which is the whole reason the sidebar
 * exists, so it keeps its own state in `app.tsx` next to the sheet it belongs to.
 */

import { useState, type ReactNode } from "react";

import { Splitter } from "../../ui/Splitter.js";
import { SheetDetail, type SheetFocus } from "./SheetDetail.js";

export type DetailPane = {
  /** What is open, or `null`. */
  focus: SheetFocus | null;
  /** Opens a focus, or closes it when it is already the one open. */
  open: (next: SheetFocus) => void;
  /** The stat id open on the character sheet, for rows that highlight themselves. */
  selectedStat: string | null;
  /** Render last inside the panel, as a sibling of the scrolling body. */
  pane: ReactNode;
};

/** Whether two focuses name the same thing, so clicking a row twice closes its pane. */
export function sameFocus(a: SheetFocus | null, b: SheetFocus): boolean {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind === "figure" && b.kind === "figure") return a.id === b.id;
  if ((a.kind === "ehp" || a.kind === "max-hit") && "element" in b) return a.element === b.element;
  if ((a.kind === "stat" || a.kind === "skill-stat") && "statId" in b) return a.statId === b.statId;
  return false;
}

export function useDetailPane(initialHeight = 320): DetailPane {
  const [focus, setFocus] = useState<SheetFocus | null>(null);
  // Held across selections rather than per breakdown: somebody who made room to read one
  // explanation wants the same room for the next.
  const [height, setHeight] = useState(initialHeight);

  return {
    focus,
    open: (next) => setFocus(sameFocus(focus, next) ? null : next),
    selectedStat: focus?.kind === "stat" ? focus.statId : null,
    pane:
      focus === null ? null : (
        <>
          <Splitter height={height} onChange={setHeight} />
          <div className="breakdown-pane" style={{ height }}>
            <SheetDetail focus={focus} onFocus={setFocus} />
          </div>
        </>
      ),
  };
}
