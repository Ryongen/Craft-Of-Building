/**
 * A dim label with a number beside it — "Cast time 0.45s", "Crit chance 12.88%".
 *
 * Two of these existed, in `DamagePanel` and `SkillsPanel`. Neither was a clean superset of the
 * other, which is worth knowing because it is why this takes a `layout` prop rather than just
 * being the bigger one:
 *
 * - the Damage panel's carried `was` and `sources`, and rendered as a `<span>` so several sit on
 *   one line;
 * - the Skills panel's rendered as a `<div>` so they stack, sized its label at 11px, and returned
 *   nothing at all for a null value — a fact it has no answer for is omitted rather than shown
 *   empty.
 *
 * Both behaviours are kept exactly. As with `Figure`, the job here is one definition, not a new
 * look; the 11px label survives as-found and belongs to the type scale work, not to this pass.
 */

import type { ReactNode } from "react";

import { num } from "./format.js";

/** `inline` sits several facts on a row; `block` stacks them one per line. */
export type FactLayout = "inline" | "block";

export function Fact({
  label,
  value,
  was,
  sources,
  layout = "inline",
}: {
  label: string;
  /** Null means the fact has no answer, and nothing is rendered. */
  value: string | null;
  /** The declared value, shown only when a stat changed it. A string is compared to `value` as
   *  written, so pass it through the same formatter. */
  was?: number | string;
  /** Where the change came from, listed under the fact. */
  sources?: { source: string; value: number }[];
  layout?: FactLayout;
}): ReactNode {
  if (value === null) return null;

  const changed =
    was !== undefined &&
    (typeof was === "string" ? was !== value : String(was) !== value.replace(/t$/, ""));
  const body = (
    <>
      <span className={layout === "block" ? "faint text-sm" : "faint"}>
        {label}{" "}
      </span>
      <span className="num">{value}</span>
      {changed && <span className="faint"> (was {was})</span>}
      {sources !== undefined && sources.length > 0 && (
        <span className="faint text-sm">
          {" "}
          ={" "}
          {sources.map((s) => `${s.value > 0 ? "+" : ""}${num(s.value, 2)} ${s.source}`).join(", ")}
        </span>
      )}
    </>
  );

  return layout === "block" ? <div>{body}</div> : <span>{body}</span>;
}
