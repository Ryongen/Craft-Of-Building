/** One row of a searchable list — what the planner's pickers show and the catalogue's filters reuse. */
export type PickerOption = {
  id: string;
  label: string;
  /** Optional right-aligned hint — a tier, a slot, a rarity. */
  hint?: string;
  /** Extra text that should match a search without being displayed. */
  keywords?: string;
  /**
   * What this option would give you, for the row's hover.
   *
   * Several lines is normal and expected — an Augment's stat lines, a unique's mods. The id is
   * appended below it, so a row's hover answers both "what does this do" and "what is it
   * called in the data".
   */
  detail?: string;
  /**
   * Why this option cannot be chosen right now, which also makes it unchoosable.
   *
   * Greyed out rather than filtered out: an affix vanishing from the list reads as "this base
   * cannot roll it", and the real answer — "you already have it" — belongs on the row's hover.
   */
  disabled?: string;
};
