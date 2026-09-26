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
 * A tick count as time first, ticks second — `0.30s/6t`.
 *
 * The mod counts in server ticks (20 a second) and so does the engine, but a player reads
 * seconds. The ticks stay beside it because every `_ticks` field in the pack is written in them.
 * Fractional ticks (cast speed after scaling) keep one decimal.
 */
export function ticksAsTime(ticks: number): string {
  if (!Number.isFinite(ticks)) return "∞";
  const t = Number.isInteger(ticks) ? String(ticks) : num(ticks, 1);
  return `${num(ticks / 20, 2)}s/${t}t`;
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

/**
 * What a stat's `usableValue` is a percentage *of*.
 *
 * `IUsableStat` returns a fraction and the app prints it as a percent, but the word differs per
 * stat and the word is most of the meaning: 43% of armour is damage not taken, 43% of dodge is
 * hits that miss, and 43% of a resist is just the resist. A stat absent from this map falls back
 * to the neutral "effective", which is right for the resists.
 *
 * Here rather than in the stat sheet because two surfaces print it now — the sheet and the
 * what-if diff — and a hover that called armour "mitigation" in one and "effective" in the other
 * would read as two different stats.
 */
export const USABLE_NOUN: Record<string, string> = {
  armor: "mitigation",
  dodge: "avoided",
  spell_dodge: "spells avoided",
  block_chance: "blocked",
};

/**
 * A stat that has a usable value, written the way it is actually read: **the percent first**.
 *
 * `1575.9 (43.1% mitigation)` puts the number nobody can act on in the reading position. 2679
 * armour is not a quantity anyone has an intuition for — it is a rating on a hyperbolic curve,
 * and the only question ever asked of it is what share of a hit it stops. So the share leads and
 * the rating is the parenthetical that explains where it came from:
 *
 *     56.29% (2,679)
 *
 * The noun goes on the hover rather than inline. Inline it doubled the width of every armour and
 * dodge row in a 320px sidebar, and the two stats it distinguishes are already told apart by
 * their own labels.
 *
 * `rawIsPercent` is for the family where the parenthetical is *also* a percentage — the resists
 * and block chance, whose raw value is already the number the game prints with a `%` after it.
 * `75.00% (120)` reads as 120 of something; `75.00% (120%)` reads as what it is, which is 120%
 * resistance capped to the 75 that `ElementalResist.getUsableValue` will actually use. Armour and
 * dodge are ratings on a curve and take the bare number, because a `%` there would be a lie.
 */
export function usable(usableValue: number, raw: number, rawIsPercent = false): string {
  return `${num(usableValue, 2)}% (${smart(round(raw))}${rawIsPercent ? "%" : ""})`;
}
