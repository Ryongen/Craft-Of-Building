/**
 * The engine's numbers against the game's, for whoever is asking.
 *
 * This used to live inside the Capture panel, which meant the one fact a planner most needs to
 * assert — *these numbers have been checked* — was only visible on a tab nobody opens by
 * default. The status bar said "unverified — no fixture pins a number yet" permanently, and
 * went on saying it with a matching capture loaded.
 *
 * So the comparison is a selector: the panel renders the rows, the status bar renders the
 * verdict, and both read the same arithmetic. It is the same rule `compareFixture` applies on
 * the command line — `toleranceFor` picks the bound from how the capture was taken, because a
 * transcription off the stat screen and a float read out of the synced container are not
 * equally precise.
 */

import { toleranceFor, type Observation, type ObservedStat } from "@cte2/schema";
import { useMemo } from "react";

import { useBuild } from "./build-store.js";
import { useDerived } from "./derived.js";

export type CaptureRow = {
  statId: string;
  /** What the game reported. */
  expected: number;
  /** What this app computes. */
  actual: number;
  delta: number;
  /** How far apart the two were allowed to be, for this capture's source. */
  allowed: number;
  ok: boolean;
};

export type CaptureCheck =
  | { kind: "none"; dirty: boolean }
  | {
      kind: "checked";
      observed: Observation;
      rows: CaptureRow[];
      matched: number;
      wrong: number;
    };

export function compareObserved(
  observed: Observation,
  stats: ReadonlyMap<string, { value: number }>,
): CaptureRow[] {
  const limit = toleranceFor("currentValue", observed.source);
  return observed.stats.map((o: ObservedStat) => {
    // A stat neither container holds reads 0, exactly as `Unit.getCalculatedStat` returns
    // `new StatData(guid, 0, 1)` for one it does not have.
    const actual = stats.get(o.statId)?.value ?? 0;
    const delta = actual - o.currentValue;
    const allowed = limit.absolute + Math.abs(o.currentValue) * limit.relative;
    return { statId: o.statId, expected: o.currentValue, actual, delta, allowed, ok: Math.abs(delta) <= allowed };
  });
}

/**
 * Whether the document on screen has been checked against the game, and how it did.
 *
 * `none` covers both "this build was never a capture" and "it was, and you have since edited
 * it" — the store drops `observed` on the first edit, because the moment a piece of gear changes
 * the capture describes a different character and comparing against it would be worse than not
 * comparing at all. `dirty` is what tells those two apart.
 */
export function useCaptureCheck(): CaptureCheck {
  const observed = useBuild((s) => s.observed);
  const dirty = useBuild((s) => s.dirty);
  const derived = useDerived();

  return useMemo(() => {
    if (observed === null) return { kind: "none", dirty } as const;
    const rows = compareObserved(observed, derived.stats);
    const wrong = rows.filter((r) => !r.ok).length;
    return { kind: "checked", observed, rows, matched: rows.length - wrong, wrong } as const;
  }, [observed, dirty, derived.stats]);
}
