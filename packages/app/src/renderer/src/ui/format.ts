/**
 * Every number the app puts on screen.
 *
 * These were six files' worth of private helpers before this module existed: three different
 * `signed`, two independently-written `percent`, and `compact` hidden inside the topbar. They had
 * drifted in three ways that showed on screen — one `signed` rendered `+412.00` where another
 * rendered `+412`, the two `percent` disagreed about nothing but were maintained twice, and
 * `compact` pinned `en-US` while `num` and `smart` followed the system locale, so on a non-English
 * Windows the topbar and the stat sheet printed the same magnitude two different ways.
 *
 * Two rules live here so no caller has to choose again:
 *
 * **Locale is `en-US`, always.** Not the system's — see {@link LOCALE}, which is the one line that
 * decision is written on.
 *
 * **The minus sign depends on whether it is arithmetic or typography.** A *value* keeps the ASCII
 * `-` that `toLocaleString` produces, so it survives being copied into a calculator. A *sign
 * deliberately rendered beside a `+`* — a delta, a signed stat line — uses the real minus U+2212,
 * because `+5` next to `-5` is visibly lopsided at these type sizes. `—` (em dash) means "no
 * value" and is never a number.
 */

/**
 * The locale every number on screen is formatted in.
 *
 * Deliberately **not** the system's, and the reason is `CaptureCheck`'s `trim()`. That helper is
 * locale-independent by construction — `String(Number(v.toPrecision(6)))` — because its column sits
 * next to the game's own transcribed number and the two have to be comparable at a glance. That
 * rule cannot change without breaking the fixture workflow, whose standing instruction is "never
 * write a number you did not read off the game".
 *
 * So following the system locale does not give a non-English user a localised app. It gives them
 * a *split* one: the Capture tab reading `50.1` while the stat sheet two tabs away reads `50,1`
 * for the same stat. There is no i18n here to be consistent with — the stat names, the prose and
 * the diagnostics are all English — so localising the separators alone buys nothing and costs
 * that.
 *
 * `main/index.ts` forces the renderer to the same locale, so Chromium's `<input type="number">`
 * agrees with these helpers. **Changing the app's mind means changing both**, and nothing else.
 */
const LOCALE = "en-US";

/** U+2212. Paired with `+`, never produced by arithmetic. */
const MINUS = "−";

/** What a cell shows when there is no number to show. Never a zero. */
export const EMPTY = "—";

/** A number with a fixed number of decimals and thousands separators. */
export function num(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Integers stay integers; everything else gets two decimals, as the game's GUI does. */
export function smart(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return Number.isInteger(value) ? value.toLocaleString(LOCALE) : num(value, 2);
}

/**
 * The sign on its own, as typography rather than arithmetic.
 *
 * Zero gets nothing. The old `percent` helpers wrote `pct > 0 ? "+" : MINUS`, which labelled an
 * exactly-zero change as negative.
 */
export function signGlyph(value: number): string {
  return value > 0 ? "+" : value < 0 ? MINUS : "";
}

/**
 * A value with its sign always shown — a stat line, a modifier contribution.
 *
 * Built on {@link smart}, so an integer stays an integer. One of the three implementations this
 * replaces used `num`, which is why a flat `+412` armour roll used to read `+412.00`.
 */
export function signed(value: number): string {
  return signGlyph(value) + smart(Math.abs(value));
}

/**
 * A fraction as a signed percentage.
 *
 * A gain of 1200% is not more informative to two decimals, and a gain of 0.4% is invisible
 * without one.
 */
export function percent(fraction: number): string {
  const pct = fraction * 100;
  const size = Math.abs(pct);
  return `${signGlyph(pct)}${size >= 10 ? size.toFixed(0) : size.toFixed(1)}%`;
}

/** 1.2M rather than 1,234,567: the chrome has no room for seven digits at a readable size. */
export function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return Math.round(value).toLocaleString(LOCALE);
}

/**
 * Whole numbers above 100, two decimals below it.
 *
 * DPS is read in thousands and crit chance in tenths, and the same table holds both. Rounding
 * everything would turn "+0.35% crit" into "+0"; rounding nothing would print eleven digits of
 * a DPS figure whose last six are float noise.
 *
 * The app's two other `round` helpers are deliberately *not* folded in here, because they are not
 * this function under another name: `fields.tsx` rounds to 2dp to feed a number input (a value,
 * not a rendering), and `Effects.tsx` rounds to 3dp because a strength multiplier is quoted as
 * `x1.234` in prose. Merging them would mean one of the three changing behaviour to match a
 * function it never shared a purpose with.
 */
export function round(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
}
