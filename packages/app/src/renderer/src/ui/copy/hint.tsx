/**
 * A string that knows how to say itself twice.
 *
 * The problem this solves is narrow. Roughly half the planner's hover text names an internal
 * identifier in the middle of a sentence — `cast_time_ticks`, `no_attacker_stats_on_selfdmg`,
 * once even `EventBuilder.ofDamage` — which is useful exactly when you are auditing the port
 * and noise the rest of the time. Both audiences are real, so a hint carries both wordings and
 * `ui/detail-mode.ts` picks.
 *
 * ## Why a union rather than a table of pairs
 *
 * Most hints are already fine: "Absorbs before health", "The Mine and Slash pool, not vanilla
 * hearts". A bare `string` means "this reads the same either way", so those call sites do not
 * change at all and the diff stays the size of the actual defect rather than the size of the
 * app. Only a hint that has something technical to hide becomes a `{ plain, tech }`.
 *
 * ## What belongs in `tech`
 *
 * The sentence that is in the tree today, copied across unchanged. It is not a place for new
 * writing — it is where the existing engineer-voiced text goes on living, so `plain` is the only
 * thing anyone has to compose. `tools/audit-copy.mjs` checks that `plain` came out clean.
 *
 * None of this touches anything the pack supplies. Stat names, skill descriptions, affixes and
 * tree nodes are the game's own words and are rendered by `@cte2/schema`'s `display.ts`
 * untouched; this module is only about the sentences the planner writes around them.
 */

import type { ReactNode } from "react";

import { useTechnical } from "../detail-mode.js";

/** Either one wording for both audiences, or one for each. */
export type Hint = string | { plain: string; tech: string };

/** What a `ui/copy/<panel>.ts` module exports. Keys are read by call sites, not by users. */
export type CopyTable = Record<string, Hint>;

/** The wording for the mode given. Takes the flag rather than reading it, so it stays callable
 *  outside a component — `ui/item-stats.ts` and friends build strings well away from a render. */
export function resolveHint(hint: Hint | undefined, technical: boolean): string | undefined {
  if (hint === undefined) return undefined;
  return typeof hint === "string" ? hint : technical ? hint.tech : hint.plain;
}

/** `resolveHint` against the live preference. The form every component wants. */
export function useHint(hint: Hint | undefined): string | undefined {
  const [technical] = useTechnical();
  return resolveHint(hint, technical);
}

/**
 * Body prose, which cannot be a string.
 *
 * A copy table holds sentences, but a good number of the technical asides are whole JSX
 * paragraphs with `<code>` in them — the identifier is an element, not text, so there is nothing
 * to put in a table. These two render one branch or the other and leave the markup where it is:
 *
 * ```tsx
 * <Plain>Cooldowns and the global cooldown scale with your cast speed.</Plain>
 * <Tech>All 40 of the pack&apos;s <code>*_cast_time</code> stats land in the same number.</Tech>
 * ```
 *
 * A `<code>` outside a `<Tech>` is what the audit flags, because that is an identifier shown to
 * someone who did not ask for one.
 */
export function Tech({ children }: { children: ReactNode }): ReactNode {
  const [technical] = useTechnical();
  return technical ? <>{children}</> : null;
}

/** The other half of `Tech`. Shown unless technical wording is on. */
export function Plain({ children }: { children: ReactNode }): ReactNode {
  const [technical] = useTechnical();
  return technical ? null : <>{children}</>;
}
