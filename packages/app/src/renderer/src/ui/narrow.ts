/**
 * Whether the window is phone- or small-tablet-sized, for the few layout switches CSS alone
 * cannot make (the stat sheet becoming a drawer, closed by default).
 *
 * The desktop app can never answer yes: its window has `minWidth: 1100` (`main/index.ts`), so
 * everything gated on this is the web build on a small screen and nothing else. The same number
 * is the `@media (max-width: 900px)` block at the end of `styles.css`; change both together.
 */

import { useEffect, useRef, useState } from "react";

export const NARROW_QUERY = "(max-width: 900px)";

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matches(NARROW_QUERY));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);

  return narrow;
}

/**
 * Scrolls `target` into view when `key` changes, on a narrow screen only.
 *
 * For the list-and-editor tabs (Items, Skills): wide, the editor is beside the list and already
 * on screen; narrow, the columns stack and picking a row would change something out of sight.
 * The first render is skipped, so opening the tab does not jump. `null` keys never scroll.
 */
export function useRevealOnNarrow(key: string | null, target: () => Element | null | undefined): void {
  const narrow = useNarrow();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!narrow || key === null) return;
    target()?.scrollIntoView({ block: "start", behavior: "smooth" });
    // `target` is a fresh closure every render; only the key decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
