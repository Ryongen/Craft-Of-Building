/**
 * Whether the app explains itself to a player or to someone chasing a number.
 *
 * Most of the hover text here was written while the engine was being ported, and it shows: a
 * hint would name the stat it read rather than the thing the stat means — "cast_time_ticks,
 * divided by your cast or attack speed" — which is the right sentence if you are holding the
 * Java open beside it and the wrong one every other time.
 *
 * Deleting that layer would have cost something real, because it is genuinely how you find out
 * why a figure moved. So it is kept and put behind this: off, a hint says what the number is;
 * on, it says where the number came from. See `ui/copy/hint.ts` for how a string carries both.
 *
 * ## Why this is not in the build store
 *
 * It is a preference about the app, not a fact about the character — exactly the reasoning in
 * `ui/Panel.tsx` for the fold state, and the mechanism here is deliberately the same one:
 * `localStorage`, plus an event, because two `useState`s reading one key do not otherwise hear
 * each other. Putting it in `state/build-store.ts` would make "I turned tooltips up" a change
 * to the document, and autosave would write it into the user's build.
 */

import { useCallback, useEffect, useState } from "react";

/** Where the preference lives. A rename is a reset to plain, which is the safe direction. */
const STORE_KEY = "cob.detail.technical";

/** Fires on every write, so each `useTechnical` in the tree re-reads the one key. */
const DETAIL_CHANGED = "cte2:detail-changed";

function read(): boolean {
  try {
    return window.localStorage.getItem(STORE_KEY) === "1";
  } catch {
    // A blocked or full store is not worth an error path: plain is the default anyway.
    return false;
  }
}

function write(on: boolean): void {
  try {
    window.localStorage.setItem(STORE_KEY, on ? "1" : "0");
  } catch {
    // Nothing to do and nothing worth saying: the toggle still works for this session.
  }
}

/**
 * Whether technical wording is on, and the setter that turns it over everywhere at once.
 *
 * Called from every `Figure`, `Detail` and `Panel` on screen, so it stays a plain `useState`
 * over a synchronous read rather than a context — there is no provider to forget to mount, and
 * a tooltip that renders outside the tree in a portal still gets the right answer.
 */
export function useTechnical(): [boolean, (on: boolean) => void] {
  const [technical, setTechnical] = useState<boolean>(read);

  useEffect(() => {
    const onChange = (): void => setTechnical(read());
    window.addEventListener(DETAIL_CHANGED, onChange);
    return () => window.removeEventListener(DETAIL_CHANGED, onChange);
  }, []);

  const set = useCallback((on: boolean) => {
    write(on);
    window.dispatchEvent(new Event(DETAIL_CHANGED));
  }, []);

  return [technical, set];
}
