/**
 * Small form pieces, extracted only where the same behaviour appears in several panels.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A number input that keeps what was typed until it is committed.
 *
 * Binding a number field straight to the store makes it impossible to clear the box or type a
 * leading minus — the store rewrites it mid-keystroke. This holds the text locally and only
 * pushes a valid, clamped number up.
 *
 * ## When "committed" is
 *
 * `commitAs` picks between the two, and the default is the conservative one:
 *
 *  - **`"blur"`** — on leaving the box or pressing Enter. Right for a field you *explore* with,
 *    which is most of them: an item level or a roll is dragged towards an answer, and a store
 *    write per keystroke is a full engine pass per keystroke on values nobody is reading yet.
 *  - **`"type"`** — as soon as what is in the box parses to a number in range. Right for a field
 *    you already know the answer for. The character level is the one: typing `100` there and
 *    watching nothing happen reads as a field that only the steppers drive, which is exactly how
 *    it was reported. Out-of-range and half-typed text (`""`, `"-"`) still wait for the blur, so
 *    clearing the box does not write a 1 into the document on the way to `12`.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 70,
  disabled = false,
  commitAs = "blur",
}: {
  value: number;
  onChange: (value: number) => void;
  /**
   * Explicitly `| undefined` rather than merely optional: under `exactOptionalPropertyTypes`
   * those are different types, and a bound that comes from the snapshot is not always there —
   * `maxQuality` is `undefined` when the pack ships no currency that caps it. "No maximum" and
   * "maximum not mentioned" mean the same thing to the clamp below, so the type should say so
   * instead of making every such caller spread a conditional object.
   */
  min?: number | undefined;
  max?: number | undefined;
  step?: number;
  width?: number;
  disabled?: boolean;
  commitAs?: "blur" | "type";
}): ReactNode {
  const [text, setText] = useState(String(value));

  // Re-sync when the value changes from elsewhere (undo, loading a build).
  useEffect(() => setText(String(value)), [value]);

  const clamp = (n: number): number => {
    let next = n;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = clamp(parsed);
    setText(String(next));
    if (next !== value) onChange(next);
  };

  /**
   * What `commitAs: "type"` does on each keystroke.
   *
   * Only a value that is already legal is published — the clamp is *not* applied here. Clamping
   * mid-type is what would make `1` unreachable in a field whose minimum is 10: the keystroke
   * before `12` would be rewritten to `10` and the caret would be left after it. An illegal or
   * half-typed box simply waits for the blur, which does clamp.
   */
  const typed = (raw: string): void => {
    setText(raw);
    if (commitAs !== "type") return;
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    if (parsed !== clamp(parsed)) return;
    if (parsed !== value) onChange(parsed);
  };

  return (
    <input
      type="number"
      style={{ width }}
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => typed(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit((event.target as HTMLInputElement).value);
      }}
    />
  );
}

/**
 * A roll percent, editable three ways: drag, type, or step.
 *
 * `AffixData.p` is an `Integer`, so every legal roll is a whole percent and the slider steps
 * by one. What the slider alone could not do is *land* on one — a 110px track spanning 0–100
 * gives a pixel per step, and a tier band of 17 values (epic is 52–68) is worse, because the
 * useful range is a sixth of the track. So the number beside it is an input rather than a
 * label, and there are unit steppers for the last percent.
 *
 * `min` and `max` are the band, and they are enforced rather than advisory: a roll outside
 * its tier's band is one of the few things the game provably cannot produce
 * (`AffixData.getMinMax()` returns `getRarity().stat_percents`, and the six bands do not
 * overlap), so the field will not emit one. The band is printed next to the box so a refused
 * keystroke is explicable rather than mysterious.
 */
/** Where in a roll band to sit. */
export type BandEnd = "min" | "avg" | "max";

export const BAND_ENDS: readonly BandEnd[] = ["min", "avg", "max"];

/**
 * A band's value at one of its three ends, defined once.
 *
 * `avg` is the midpoint **rounded to an integer**, because `AffixData.p` is an `int` and a 37.5%
 * roll is not one the game can produce. The slider already rounds everything a person types or
 * drags; this is what keeps a programmatic set — "roll everything at average" — to the same rule
 * rather than writing halves into the document.
 *
 * It is a function rather than three expressions at the call sites because three places set a
 * roll to an end of its band, and "average" drifting between them would be invisible.
 */
export function bandEnd(band: { min: number; max: number }, end: BandEnd): number {
  if (end === "min") return band.min;
  if (end === "max") return band.max;
  return Math.round((band.min + band.max) / 2);
}

/**
 * A roll being dragged, held locally until the thumb is let go.
 *
 * The drag is the whole performance problem on this app's sliders. A roll is an edit like any
 * other: it produces a new `BuildDoc`, which is the key `useDerived` memoises on, so every value
 * that reaches the store is a full engine pass (7-12 ms) plus a re-render of the sheet, the
 * damage tab and every panel watching the document. A range input emits a move event per pixel.
 *
 * This used to be throttled to eight stores a second, which kept the thumb attached to the
 * cursor and still spent eight engine passes per second of dragging — on answers nobody reads,
 * because a value you are still sliding past is not a value you are reading. Now nothing reaches
 * the store until the drag ends, and the numbers beside the slider follow this draft instead.
 *
 * Hold it in the component that renders *both* the slider and whatever shows its value:
 *
 *     const roll = useRollDraft(aura.rollPercent ?? band.min);
 *     <RollSlider value={roll.shown} onPreview={roll.preview} onChange={commit} />
 *     <StatLines rollPercent={roll.shown} ... />
 *
 * The draft clears itself whenever the committed value changes, which covers both ends: the
 * commit on release (the draft and the new value are the same number, so nothing flickers) and a
 * change from elsewhere — an undo, a tier switch, loading a build — which must win over a
 * draft the user has stopped touching.
 */
export function useRollDraft(value: number): {
  /** What to render: the drag in progress, or the committed value when there is none. */
  shown: number;
  /** Called per pixel of drag. Cheap: one `setState` in this component. */
  preview: (next: number) => void;
} {
  const [draft, setDraft] = useState<number | undefined>(undefined);
  useEffect(() => setDraft(undefined), [value]);
  return { shown: draft ?? value, preview: setDraft };
}

export function RollSlider({
  value,
  onChange,
  onPreview,
  min = 0,
  max = 100,
  label,
  showBand = true,
  ends = false,
}: {
  value: number;
  /** The committed roll. Called when the drag ends, never during it. */
  onChange: (value: number) => void;
  /**
   * Called per pixel while dragging, for a caller holding a {@link useRollDraft}.
   *
   * Omitted, the thumb still tracks the cursor — the slider keeps its own drag state — but
   * anything *else* on screen showing this roll stays where it was until the drag ends.
   */
  onPreview?: (value: number) => void;
  min?: number;
  max?: number;
  label?: string;
  /** Print the legal band beside the box. Off where the band is the full 0–100. */
  showBand?: boolean;
  /**
   * Offer the three ends of the band as buttons.
   *
   * On where a roll is one of many on an item and dragging each slider is the work — an affix
   * row. Off by default: on a control that is the only roll on screen, three more buttons is
   * clutter around a slider that already reaches both ends.
   */
  ends?: boolean;
}): ReactNode {
  const clamp = (next: number): number => Math.min(Math.max(Math.round(next), min), max);

  /**
   * What the thumb is on while it is being dragged, before the store has heard about it.
   *
   * `undefined` means "not dragging", which is different from "dragging at the stored value":
   * the stored value is what the slider must snap back to when an undo or a tier change moves
   * it from elsewhere, and only an idle slider should follow that.
   */
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const current = dragging ?? clamp(value);

  // `commit` runs from an unmount cleanup, which fires after the render that scheduled it, so it
  // must not close over that render's `onChange`. A ref is the usual way to let a callback
  // outlive the render it was created in.
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  });

  /** The value the thumb is on that the store has not been told about. */
  const pending = useRef<number | undefined>(undefined);

  const commit = useCallback((): void => {
    const next = pending.current;
    pending.current = undefined;
    if (next !== undefined) handler.current(next);
  }, []);

  // A drag abandoned by an unmount — switching tabs mid-drag, removing the affix — must still
  // land where the thumb was left, not where it started.
  useEffect(() => () => commit(), [commit]);

  /**
   * Paint now; tell the store on release.
   *
   * Nothing here reaches the document. `setDragging` moves this component's own thumb and
   * `onPreview` moves whatever else the caller is showing for this roll — both are one
   * `setState` in one subtree, where a store write is an engine pass and a re-render of the app.
   */
  const drag = (next: number): void => {
    setDragging(next);
    pending.current = next;
    onPreview?.(next);
  };

  /** The thumb is down no longer: store what it landed on and follow the document again. */
  const release = (): void => {
    commit();
    setDragging(undefined);
  };

  const step = (by: number): void => {
    const next = clamp(current + by);
    if (next !== value) onChange(next);
  };

  return (
    <div className="row" style={{ gap: 5 }}>
      {label !== undefined && <span className="faint">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={current}
        onChange={(event) => drag(clamp(Number(event.target.value)))}
        // Three ways a drag ends and no single event covers them: the pointer lifting, an
        // arrow key coming back up, and focus leaving the control while the value is still
        // only local. Each one flushes, and flushing twice is a no-op.
        onPointerUp={release}
        onKeyUp={release}
        onBlur={release}
        style={{ width: 132 }}
      />
      <button
        className="nudge"
        title={`-1% (min ${min})`}
        disabled={current <= min}
        onClick={() => step(-1)}
      >
        −
      </button>
      {/* 56, not 48: a roll reaches 100 and three digits plus the spinner clipped the last
          one, which read as "10" — a legal roll, and the wrong one. */}
      <NumberField value={current} min={min} max={max} width={56} onChange={(next) => onChange(clamp(next))} />
      <button
        className="nudge"
        title={`+1% (max ${max})`}
        disabled={current >= max}
        onClick={() => step(1)}
      >
        +
      </button>
      {ends &&
        BAND_ENDS.map((end) => {
          const target = bandEnd({ min, max }, end);
          return (
            <button
              key={end}
              className="nudge word"
              title={`Roll this one at the ${end} of its band (${target}%)`}
              disabled={current === target}
              onClick={() => onChange(target)}
            >
              {end}
            </button>
          );
        })}
      <span className="faint text-xs" style={{ width: showBand ? 46 : 0, overflow: "hidden" }}>
        {showBand ? `${min}–${max}%` : ""}
      </span>
    </div>
  );
}

/**
 * The number the item actually shows, typed in directly.
 *
 * Reading a roll percent off an item is not something a player can do — the tooltip prints the
 * *value*, and the percent only exists inside `AffixData`. So this takes the value and solves
 * back for the percent it implies.
 *
 * The solve is a plain inverse-lerp, and it is exact for the same reason the importer's is:
 * `ExactStatData.fromStatModifier` interpolates `min + (max - min) * p / 100` and then applies
 * a level multiplier to the whole thing, so the value is linear in `p` and two evaluations
 * pin the line. `valueAt` is handed in rather than recomputed here so the caller can use the
 * engine's own `rollToExact` — which means the number in this box is the number the character
 * sheet will use, level scaling included, not a display approximation of it.
 *
 * A value outside the band's reach is clamped to the band rather than accepted, because a roll
 * that cannot happen is exactly what the validator would then reject.
 */
export function ValueField({
  rollPercent,
  min,
  max,
  valueAt,
  onChange,
  width = 72,
}: {
  rollPercent: number;
  /** The roll band, which bounds what values are reachable. */
  min: number;
  max: number;
  /** The resolved value at a roll percent — normally the engine's, so scaling is included. */
  valueAt: (rollPercent: number) => number;
  onChange: (rollPercent: number) => void;
  width?: number;
}): ReactNode {
  const low = valueAt(min);
  const high = valueAt(max);
  const current = valueAt(rollPercent);

  // A band whose endpoints render identically carries no information to invert: every roll in
  // it produces this number. Show it, but do not pretend it is editable.
  const flat = Math.abs(high - low) < 1e-9;

  return (
    <NumberField
      value={round2(current)}
      step={0.1}
      width={width}
      disabled={flat}
      onChange={(typed) => {
        if (flat) return;
        const solved = min + ((typed - low) / (high - low)) * (max - min);
        const clamped = Math.min(Math.max(Math.round(solved), min), max);
        if (clamped !== rollPercent) onChange(clamped);
      }}
    />
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A text input that only reaches the store when you stop typing.
 *
 * The sibling of {@link NumberField}, for the same reason and one more. Bound straight to the
 * store, every keystroke in the build-name box was a full document edit: it pushed an undo entry
 * (so naming a build ate twenty of the hundred slots and buried the edit you actually wanted
 * back), and it produced a new `BuildDoc`, which is the key `useDerived` memoises on — so the
 * whole engine re-ran, per character typed.
 *
 * Committing on blur and Enter makes a rename one edit, which is what it always was.
 */
export function TextField({
  value,
  onChange,
  placeholder,
  width = 160,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number;
}): ReactNode {
  const [text, setText] = useState(value);

  // Re-sync when the value changes from elsewhere - undo, or loading a build.
  useEffect(() => setText(value), [value]);

  const commit = (raw: string): void => {
    if (raw !== value) onChange(raw);
  };

  return (
    <input
      type="text"
      style={{ width }}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit((event.target as HTMLInputElement).value);
      }}
    />
  );
}

export function Labelled({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/**
 * Re-exported so the many panels that import `num`/`smart` from here keep working.
 *
 * They live in `format.ts` now, beside `signed`, `percent` and `compact`, because this is a
 * components file and they are not components. New code should import from there.
 */
export { num, smart } from "./format.js";
