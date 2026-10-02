/**
 * The one place the engine is called from the UI.
 *
 * The work itself is `deriveBuild` in `@cte2/engine`, which the build catalogue and the Discord
 * bot call too, so every surface computes the same numbers from the same document. What lives here
 * is the part that is about React: one cached answer per document, shared by every component that
 * asks.
 *
 * Comfortably inside a frame (~7 ms for a new level-100 document), so this runs synchronously on
 * the render path rather than behind a debounce that would make the numbers lag the click that
 * caused them. Keeping every caller behind this one hook is what makes moving the work to a Web
 * Worker a one-file change if a build ever gets heavy enough to need it.
 */

import type { Snapshot } from "@cte2/extractor";
import { deriveBuild, type DerivedBuild } from "@cte2/engine";
import type { BuildDoc } from "@cte2/schema";
import { useMemo } from "react";

import { useBuild } from "./build-store.js";
import { useWorld } from "@cte2/view";

export { breakdownsOf, mainSkillIndex } from "@cte2/engine";
export type { DerivedBuild, ModContribution, StatBreakdown } from "@cte2/engine";

/**
 * The last answer, shared by every component that asks for one.
 *
 * `useMemo` caches **per component instance**, which is the wrong granularity here and was
 * quietly expensive: a panel that renders a row component per stat calls `useDerived` once per
 * row, and each of those has its own memo cell, so the whole derivation ran once per row on every
 * edit. The new Stats tab has fourteen such boxes and the sidebar's vitals block a dozen rows —
 * that tab took 284ms to open, almost all of it re-deriving the same document.
 *
 * The engine's own caches hide most of the cost of a second ask — `resolveEffects` memoises the
 * exile-effect fixed point against the document — but not all of it: the validator runs, the
 * damage pipeline runs, and the contribution index is rebuilt over a few thousand modifiers.
 *
 * One entry is the right size. Every component in a single render pass sees the same document
 * object, because the store hands out one and nothing mutates it in place, so they all hit. A
 * new document misses once and then hits for the rest of the pass.
 */
let lastDerived: { doc: BuildDoc; snapshot: Snapshot; value: DerivedBuild } | null = null;

function derivedFor(doc: BuildDoc, snapshot: Snapshot): DerivedBuild {
  if (lastDerived !== null && lastDerived.doc === doc && lastDerived.snapshot === snapshot) {
    return lastDerived.value;
  }
  const value = deriveBuild(doc, snapshot);
  lastDerived = { doc, snapshot, value };
  return value;
}

/**
 * The derived view of the current build.
 *
 * Keyed on document identity: every mutator in the store produces a new object, and nothing
 * mutates one in place, so reference equality is a sound cache key here. The `useMemo` keeps the
 * hook honest about its dependencies; {@link derivedFor} is what makes the *second* caller in the
 * same render free.
 */
export function useDerived(): DerivedBuild {
  const doc = useBuild((state) => state.doc);
  const { snapshot } = useWorld();
  return useMemo(() => derivedFor(doc, snapshot), [doc, snapshot]);
}
