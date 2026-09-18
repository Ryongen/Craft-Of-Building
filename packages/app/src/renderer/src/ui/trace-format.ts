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

import { num, smart } from "./format.js";

export function formatStep(step: LayerStep): string {
  if (step.action === "MULTIPLY") return `x${num(step.multiplier ?? 1, 3)}`;
  if (step.action === "ADD") return `${step.amount >= 0 ? "+" : ""}${smart(step.amount)}`;
  if (step.conversion.length > 0) {
    return step.conversion.map((c) => `${num(c.percent, 1)}% ${c.element}`).join(", ");
  }
  return `${num(step.amount, 1)}%`;
}
