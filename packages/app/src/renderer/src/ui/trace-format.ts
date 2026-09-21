/**
 * How one row of the mod's damage log is written.
 *
 * `StatLayer.getTooltip` formats a MULTIPLY layer as `xN`, an ADD as `+N` and a conversion as a
 * list of percentages, and matching that exactly is the whole reason the Damage tab is worth
 * trusting — a row here is directly comparable to a hover in game.
 *
 * It lives in `ui/` rather than beside the Damage tab because two screens print these rows now:
 * that tab's full expandable trace, and the sidebar's short "where did this hit come from"
 * summary. The sidebar cannot import the damage panel — the panel is lazily loaded and half the
 * sessions never open it — so the alternative to sharing this was a second copy that would
 * quietly disagree the first time a layer action was added.
 */

import type { LayerStep } from "@cte2/engine";
import type { Snapshot } from "@cte2/extractor";
import { statLayerName } from "@cte2/schema";

import { elementLabel } from "./palette.js";
import { num, smart } from "./format.js";

/**
 * A layer's name, with the elements filled into the three that are templates.
 *
 * Three of the pack's fifteen layer names are `Formatter`-style templates and every screen that
 * printed one printed it raw: `damage_conversion` is `"%1$s to %2$s Conversion"`, and a physical
 * skill converting to cold showed exactly that, placeholders and all. The other two are
 * `damage_taken_as` (`"%1$s Taken as %2$s"`) and `ele_as_extra_flat` (`"Plus %1$s as Extra
 * %2$s"`). The remaining twelve carry no placeholder and pass through untouched, which is why
 * this can be the only way any screen names a layer.
 *
 * `%1$s` is the element the event is *dealt as* — the trace block's own, handed in, because a
 * `LayerStep` does not carry it. `%2$s` is where the damage is going: `additionalTo` names it
 * directly for an ele-as-extra layer, and the two conversion actions keep a per-element map, so
 * a layer converting to two elements at once joins them. That last case is real — one
 * accumulator holds every target element — and printing only the first would name half a row.
 */
export function layerLabel(snapshot: Snapshot, step: LayerStep, element: string): string {
  const name = statLayerName(snapshot, step.layerId);
  if (!name.includes("$s")) return name;

  const to =
    step.additionalTo !== undefined
      ? elementLabel(step.additionalTo)
      : step.conversion.map((c) => elementLabel(c.element)).join(" and ");

  return name.replace(/%(\d+)\$s/g, (whole, digits: string) => {
    const part = digits === "1" ? elementLabel(element) : digits === "2" ? to : undefined;
    // A placeholder with nothing to put in it keeps its own text rather than becoming a blank:
    // a row reading "Physical to  Conversion" hides that the target element was never resolved.
    return part === undefined || part.length === 0 ? whole : part;
  });
}

export function formatStep(step: LayerStep): string {
  if (step.action === "MULTIPLY") return `x${num(step.multiplier ?? 1, 3)}`;
  if (step.action === "ADD") return `${step.amount >= 0 ? "+" : ""}${smart(step.amount)}`;
  if (step.conversion.length > 0) {
    // Through `elementLabel` for the same reason the row's name is: the accumulator is keyed by
    // the `Elements` enum constant, so a cold conversion reads "Water" and a chaos one "Shadow"
    // — two words that appear nowhere in the game.
    return step.conversion.map((c) => `${num(c.percent, 1)}% ${elementLabel(c.element)}`).join(", ");
  }
  return `${num(step.amount, 1)}%`;
}
