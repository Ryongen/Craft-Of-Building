/**
 * One expandable row of a nested breakdown.
 *
 * Factored out of `DamagePanel`, which grew the pattern first, so the damage trace and the stat
 * drill-down cannot drift into two different ideas of what a disclosure row looks like. The
 * shape is the same in both: a label, a number on the right, and children that only exist once
 * somebody asks for them.
 *
 * Deliberately dumb. It knows nothing about stats, layers or items — the callers resolve their
 * own names and format their own numbers, because the two have genuinely different ideas about
 * what a number means (a layer prints `x2.72`, a contribution prints `+412`).
 *
 * **`children` may be a function, and for anything expensive it should be.** Passed as JSX, the
 * subtree is built by the caller before this component ever sees it, so `{open && children}` hides
 * the cost without avoiding it — the header above used to claim children "only exist once somebody
 * asks for them", which was true of the DOM and false of the work. The damage trace was paying for
 * it: one `derived.breakdown()` call plus a row per modifier, for every contribution of every
 * layer, on every render, discarded unopened. A thunk is only called when the row is open.
 */

import { useState, type ReactNode } from "react";

export function StepRow({
  label,
  value,
  depth = 0,
  tone,
  title,
  badge,
  onClick,
  defaultOpen = false,
  children,
}: {
  label: ReactNode;
  /** The number on the right, already formatted by whoever knows what it means. */
  value?: ReactNode;
  /** Indent level. 0 is flush with the table. */
  depth?: number;
  /**
   * Colours the row's value: a subtotal, a warning, something switched off, or which way the
   * number moved the result.
   *
   * `undefined` is spelled out because the callers derive it — `valueTone` in the damage trace
   * returns nothing for a row whose sign carries no meaning — and under
   * `exactOptionalPropertyTypes` an optional prop does not accept one.
   */
  tone?: "faint" | "warn" | "good" | "bad" | undefined;
  title?: string;
  /** A short chip before the value — "assumed", "capped", a context type. */
  badge?: ReactNode;
  /**
   * What clicking the row does when it has no children.
   *
   * A row can be a link rather than a disclosure — a transfer's parent stat is somewhere to go,
   * not something to expand — and a row that has both expands, because the children are already
   * on screen and jumping away from them would be a surprise.
   */
  onClick?: () => void;
  defaultOpen?: boolean;
  /** JSX, or a thunk that builds it only once the row is open. */
  children?: ReactNode | (() => ReactNode);
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  // A thunk is always expandable: finding out whether it would return anything means calling it,
  // which is the cost this exists to avoid.
  const expandable =
    typeof children === "function" ||
    (children !== undefined && children !== false && children !== null);
  const interactive = expandable || onClick !== undefined;

  return (
    <>
      <div
        className={`step-row${interactive ? " interactive" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={title}
        onClick={
          interactive
            ? (event) => {
                event.stopPropagation();
                if (expandable) setOpen(!open);
                else onClick?.();
              }
            : undefined
        }
      >
        <span className="step-label">
          {expandable && <span className="faint">{open ? "▾ " : "▸ "}</span>}
          {label}
        </span>
        {badge !== undefined && <span className="badge">{badge}</span>}
        {value !== undefined && <span className={`step-value${tone ? ` ${tone}` : ""}`}>{value}</span>}
      </div>
      {open && (typeof children === "function" ? children() : children)}
    </>
  );
}
