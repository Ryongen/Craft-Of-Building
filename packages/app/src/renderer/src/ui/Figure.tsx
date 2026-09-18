/**
 * A label with a number under it.
 *
 * There were three of these — `Headline`, `DamagePanel` and `DefencePanel` each defined one
 * privately, all three taking exactly `{label, value, hint}`, and none of them exported. They had
 * drifted to three type scales (9.5/15, 11/16, 10.5/20) and three different wrappers, so the same
 * figure read differently depending on which panel you were looking at.
 *
 * The labels are now on the scale: the 9.5/10.5/11 spread collapsed into `--text-xs` and
 * `--text-sm`, which is why the `md`/`lg` label branch that used to be a ternary is a single class.
 * The **values** are not, quite — 16 and 20 are steps, but `sm`'s 15px is not, and it stays a
 * literal rather than being rounded to 16, which would make the topbar's figure the same size as
 * the Damage panel's and flatten the one hierarchy these three variants exist to express.
 *
 * The `sm` branch keeps its own structure rather than being folded into the other two, and that is
 * load-bearing: `.field` sets `color: var(--text-dim)`, so the topbar's figures are dimmer than the
 * panels' by inheritance. Dropping the wrapper would silently brighten every number in the chrome.
 */

import type { ReactNode } from "react";

/**
 * The delta, or nothing at all.
 *
 * An inline `<span>` rather than a flex row around the value, deliberately: the value's element
 * is shared with the Damage and Defence panels, which pass no delta, and turning it into a flex
 * container would move their numbers for a feature they do not use. Rendering nothing when there
 * is nothing keeps that markup byte-identical.
 */
function DeltaTag({ delta }: { delta?: ReactNode }): ReactNode {
  if (delta === undefined) return null;
  return (
    <span className="text-sm" style={{ marginLeft: 6, fontWeight: 500 }}>
      {delta}
    </span>
  );
}

/**
 * Which of the three existing treatments to use.
 *
 * `sm` is the topbar chrome, `md` the Damage panel's cards, `lg` the Defence panel's headline
 * pools. The names describe the value's size, which is the only thing that orders them.
 */
export type FigureSize = "sm" | "md" | "lg";

export function Figure({
  label,
  value,
  hint,
  size = "md",
  delta,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  size?: FigureSize;
  /**
   * How this figure has moved, where something is measuring it.
   *
   * Beside the value rather than under it: the topbar has a fixed height and a third line would
   * push the figures out of it. Absent for every caller that is not comparing against anything,
   * which is the normal case.
   */
  delta?: ReactNode;
  /** Opens where the number came from, where the caller can show that. */
  onClick?: () => void;
}): ReactNode {
  if (size === "sm") {
    return (
      <div
        className={`field${onClick ? " pick" : ""}`}
        title={hint}
        onClick={onClick}
        style={{ display: "flex", flexDirection: "column", gap: 0, lineHeight: 1.15 }}
      >
        <label className="text-xs" style={{ opacity: 0.65, letterSpacing: 0.3 }}>{label}</label>
        <span style={{ fontSize: 15, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
          {value}
          <DeltaTag delta={delta} />
        </span>
      </div>
    );
  }

  // `md` reads its value in the mono face (`.num`); `lg` does not, and sets tabular figures
  // inline instead. That difference is as-found, not a decision made here.
  const large = size === "lg";
  return (
    <div title={hint}>
      <div className="faint text-sm">
        {label}
      </div>
      {large ? (
        <div className="text-xl" style={{ fontVariantNumeric: "tabular-nums" }}>
          {value}
          <DeltaTag delta={delta} />
        </div>
      ) : (
        <div className="num text-lg">
          {value}
          <DeltaTag delta={delta} />
        </div>
      )}
    </div>
  );
}
