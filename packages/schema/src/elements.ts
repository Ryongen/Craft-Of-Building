/**
 * `Elements` — the damage-type model, ported from the enum.
 *
 * This lives in `@cte2/schema` rather than the engine because both need it: the validator
 * checks that an enemy's declared resists name real elements, and the damage pipeline keys
 * almost everything on element identity.
 *
 * The trap is that the enum's **name** and its **GUID** differ for three of the five, and both
 * spellings appear in the registries. JSON `ele` / `element` fields carry the enum name
 * (`Cold`, `Nature`, `Shadow`); stat ids carry the GUID (`water_resist`,
 * `lightning_penetration`, `chaos_resist`). Confusing the two silently drops a whole element.
 *
 *     Cold(..., "Cold", ChatFormatting.AQUA, ElementIds.WATER, ...)
 *     Nature(..., "Lightning", ChatFormatting.YELLOW, ElementIds.NATURE, ...)
 *     Shadow(..., "Chaos", ChatFormatting.DARK_PURPLE, "chaos", ...)
 *
 * — Elements.java:22-33, with `ElementIds.NATURE = "lightning"` and `ElementIds.WATER =
 * "water"` (ElementIds.java:5-7). `GUID()` returns `guidName`.
 */

/** The enum constant names, as they appear in JSON `ele` and `element` fields. */
export const ELEMENT_NAMES = [
  "Physical",
  "Fire",
  "Cold",
  "Nature",
  "Shadow",
  "Elemental",
  "ALL",
] as const;

export type ElementName = (typeof ELEMENT_NAMES)[number];

export type ElementView = {
  name: ElementName;
  /** `Elements.GUID()` — what stat ids are built from. */
  guid: string;
  /** The name shown to players. `Nature` renders as "Lightning". */
  displayName: string;
  /** `Elements.multiElements`, in GUIDs. Empty for a single element. */
  multi: readonly string[];
  /** `tags.contains(ElementTags.ELEMENTAL)`. */
  isElemental: boolean;
};

export const ELEMENTS: Record<ElementName, ElementView> = {
  Physical: { name: "Physical", guid: "physical", displayName: "Physical", multi: [], isElemental: false },
  Fire: { name: "Fire", guid: "fire", displayName: "Fire", multi: [], isElemental: true },
  Cold: { name: "Cold", guid: "water", displayName: "Cold", multi: [], isElemental: true },
  Nature: { name: "Nature", guid: "lightning", displayName: "Lightning", multi: [], isElemental: true },
  Shadow: { name: "Shadow", guid: "chaos", displayName: "Chaos", multi: [], isElemental: false },
  Elemental: {
    name: "Elemental",
    guid: "elemental",
    displayName: "Elemental",
    multi: ["lightning", "fire", "water"],
    isElemental: true,
  },
  ALL: { name: "ALL", guid: "all", displayName: "", multi: ["lightning", "fire", "water", "chaos"], isElemental: false },
};

/** `Elements.isValid()` — everything but `ALL`. */
export function isValidElement(e: ElementView): boolean {
  return e.name !== "ALL";
}

/** `Elements.isSingleElement()`. */
export function isSingleElement(e: ElementView): boolean {
  return e.multi.length === 0;
}

/** `Elements.getAllSingle()`: Physical, Fire, Cold, Nature, Shadow. */
export const SINGLE_ELEMENTS: readonly ElementView[] = ELEMENT_NAMES.map((n) => ELEMENTS[n]).filter(
  (e) => isSingleElement(e) && isValidElement(e),
);

/**
 * The elements the physical-conversion family is generated for: every single element, **and ALL**.
 *
 * `ElementalStat.generateAllPossibleStatVariations` is
 *
 *     Arrays.stream(Elements.values()).forEach(x -> list.add(newGeneratedInstance(x)));
 *
 * — every constant, aggregates included. Of the two aggregates only one survives to the damage
 * event, which is why this is neither `SINGLE_ELEMENTS` nor all seven:
 *
 *   - **`Elemental` does not**, because `ElementalStat.transferStats` splits an `Elemental`
 *     variant across `getAllSingleElemental()` and clears it while the stat container is still
 *     being built. `phys_to_elemental` therefore *is* `phys_to_fire` + `phys_to_water` +
 *     `phys_to_lightning` by the time any hit is rolled, and generating it as well would count
 *     it twice.
 *   - **`ALL` does.** `transferStats` only ever tests `element == Elements.Elemental`, so
 *     nothing redistributes `phys_to_all`; it reaches `convertDamage(Elements.ALL, …)` and
 *     spawns a child event whose element is the aggregate. `ALL` lists all four of
 *     lightning/fire/water/chaos, so `elementsMatch` makes that child pick up the increases,
 *     penetration and resistances of every one of them.
 *
 * Leaving `ALL` out silently dropped the only conversion content the engine was losing: the
 * `phys_to_all` and `phys_to_all_big` perks, at 10% and 25%.
 */
export const CONVERTED_ELEMENTS: readonly ElementView[] = [...SINGLE_ELEMENTS, ELEMENTS.ALL];

/** `Elements.getAllSingleElemental()`: Fire, Cold, Nature. */
export const SINGLE_ELEMENTAL: readonly ElementView[] = SINGLE_ELEMENTS.filter((e) => e.isElemental);

/** Every element GUID a build document may name, including the two aggregates. */
export const ELEMENT_GUIDS: readonly string[] = ELEMENT_NAMES.map((n) => ELEMENTS[n].guid);

export function elementByName(value: unknown): ElementView | undefined {
  return typeof value === "string" && value in ELEMENTS
    ? ELEMENTS[value as ElementName]
    : undefined;
}

export function elementByGuid(guid: string): ElementView | undefined {
  return ELEMENT_NAMES.map((n) => ELEMENTS[n]).find((e) => e.guid === guid);
}

/**
 * `Elements.elementsMatch` (Elements.java:104-127).
 *
 * Identity, or one is an aggregate containing the other's GUID. Note it is *not* symmetric in
 * implementation but is in effect — both directions are spelled out separately in the Java.
 * Two different aggregates never match, even where their member lists overlap.
 */
export function elementsMatch(a: ElementView | undefined, b: ElementView | undefined): boolean {
  if (!a || !b) return false;
  if (a.name === b.name) return true;
  if (isSingleElement(a) && !isSingleElement(b)) return b.multi.includes(a.guid);
  if (!isSingleElement(a) && isSingleElement(b)) return a.multi.includes(b.guid);
  return false;
}
