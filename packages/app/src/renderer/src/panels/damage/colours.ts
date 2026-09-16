/**
 * The element colours the Damage panel paints with.
 */

// Keyed by the enum **name**, which is what `DamageResult` carries. `Shadow` displays as
// "Chaos" and `Nature` as "Lightning" — the name and the GUID differ for three of the five
// elements, which is exactly the trap `elements.ts` exists to handle. Names come from
// `ELEMENTS[...].displayName` rather than from this map.
export const COLOURS: Record<string, string> = {
  Physical: "#c9c9c9",
  Fire: "#e07a4a",
  Cold: "#5fb8d9",
  Nature: "#d9d04a",
  Shadow: "#a86ad9",
  Elemental: "#8fd9c0",
  ALL: "#d7dbe4",
};
