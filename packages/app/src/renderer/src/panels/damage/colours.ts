/**
 * The element colours the Damage panel paints with.
 */

import { INK } from "../../ui/palette.js";

// Keyed by the enum **name**, which is what `DamageResult` carries. `Shadow` displays as
// "Chaos" and `Nature` as "Lightning" — the name and the GUID differ for three of the five
// elements, which is exactly the trap `elements.ts` exists to handle. Names come from
// `ELEMENTS[...].displayName` rather than from this map.
//
// Physical is the pack's own GOLD rather than the grey it used to be here. `COLOR-CODING.md`
// has said gold since it was written and `palette.ts`'s `ELEMENT` compiles it that way, so the
// grey was this file disagreeing with both — and disagreeing in the one place where the colour
// is doing the most work, since a physical build's whole trace is painted in it.
export const COLOURS: Record<string, string> = {
  Physical: INK.gold,
  Fire: "#e07a4a",
  Cold: "#5fb8d9",
  Nature: "#d9d04a",
  Shadow: "#a86ad9",
  Elemental: "#8fd9c0",
  ALL: "#d7dbe4",
};
