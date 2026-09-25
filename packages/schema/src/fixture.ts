/**
 * Ground-truth fixtures: a build document paired with what the game actually reported for
 * it.
 *
 * Until the companion mod exists (deferred to after phase 3), `observed` blocks are
 * transcribed by hand from the in-game stat GUI. That screen exposes exactly the fields the
 * engine has to reproduce — `current_value`, `usable_value`, `dmg_multi`, `softcap`,
 * `hardcap`, `min` — which is what makes hand transcription viable rather than a poor
 * substitute.
 *
 * `dmgMulti` is the load-bearing one. `InCalcStatData.getCalculated()` splits a stat into
 * two fields:
 *
 *     float mu = 1;
 *     if (GetStat().getMultiUseType() == Stat.MultiUseType.MULTIPLICATIVE_DAMAGE) { mu = Multi; }
 *     return new StatData(this.id, calcValue(), mu);
 *
 * and `StatData.getValue()` returns the value *without* `mu`. An engine that folded MORE
 * modifiers into the value everywhere would match `currentValue` on most stats and be
 * silently wrong on the ~150 `MULTIPLICATIVE_DAMAGE` ones. Recording both fields is what
 * catches that.
 *
 * The `source` field is why this format outlives the transcription era: when the mod lands
 * it emits `"mod_dump"` into the same shape, so nothing captured now has to be re-entered.
 */

import type { Snapshot } from "@cte2/extractor";

import type { BuildDoc } from "./build-doc.js";
import { baseGearType } from "./queries.js";
import { validateBuild, type Diagnostic, type ValidateOptions } from "./validate.js";

/**
 * Where an `observed` block was read from.
 *
 * `damage_log` is the mod's own per-hit breakdown, behind the `damage_messages` player config
 * and shown as a hover on the combat message. It is the richest capture available without the
 * companion mod: one hover carries base damage, every layer with its multiplier, every named
 * MORE and the final number, so it pins the whole damage pipeline rather than the one figure at
 * the end of it.
 */
export const OBSERVATION_SOURCES = ["stat_gui", "damage_log", "mod_dump"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export type ObservedStat = {
  /** `mmorpg_stat` id. */
  statId: string;
  /** The stat sheet's headline number: `StatData.v1`, i.e. `InCalcStatData.calcValue()`. */
  currentValue: number;
  /**
   * The sheet's `usable_value` column, as the percentage it displays: 4,000 armor showing
   * "40.0%" is `40`, not `0.4`. Only the four `IUsableStat` stats have one.
   */
  usableValue?: number;
  /** `StatData.m` — only meaningful for `MULTIPLICATIVE_DAMAGE` stats, where it is 1 otherwise. */
  dmgMulti?: number;
  softcap?: number;
  hardcap?: number;
};

/**
 * A damage number read off the game.
 *
 * Every field is optional except `spellId`, because they come from different screens and a
 * capture rarely has all of them. `baseValue` is the cheapest and most valuable: it is the
 * number the spell tooltip prints (`ValueCalculation.getShortTooltip`), needs no combat, and
 * checks `mmorpg_value_calc` end to end on its own.
 *
 * `hit` and `crit` are separate fields rather than one averaged number on purpose. The engine
 * branches on crit because `critical_damage` gates a multiplicative layer, so an average is
 * not something the game ever displays — only individual hits are. Recording one hit of each
 * kind is what makes the branch checkable at all.
 */
export type ObservedDamage = {
  /** `mmorpg_spells` id this was cast from. */
  spellId: string;
  /**
   * Where this reading came from, when it is not where the rest of the observation came from.
   *
   * The common case for a capture made today: the companion mod writes the stat sheet as a
   * `mod_dump`, which is float-exact, but it cannot read the damage log — those numbers are
   * still a human transcribing a hover, and the log `(int)`-casts and formats to two decimals.
   * Holding them to the dump's bound would fail a correct engine over the log's own rounding.
   *
   * Defaults to {@link Observation.source}. Only the damage fields consult it.
   */
  source?: ObservationSource;
  /** The spell tooltip's damage figure, before any target is involved. */
  baseValue?: number;
  /** A single non-critical hit's damage. */
  hit?: number;
  /** A single critical hit's damage. */
  crit?: number;
  /** One second of a damage-over-time ailment, keyed by ailment id. */
  ailmentPerSecond?: Record<string, number>;
  /**
   * The ailment's own damage-log blocks, one entry per ailment the hit inflicted.
   *
   * Separate from {@link log} because an ailment is **not** part of the hit. `AilmentChance
   * .activate` builds a whole second `DamageEvent` and the log prints it as its own hover, with
   * its own `Total Combined Damage` — so folding it into the hit's element list would be
   * claiming the game printed something it did not.
   *
   * This is the field that pins the two halves of an ailment against each other. A freeze
   * capture is three hovers: the hit, the `Damage Over Time / Ailment: Freeze` block it applied,
   * and the `Ailment Proc: Shatter` block that released the pool. Recording all three is what
   * makes `damageEffectivenessMulti` observable — the proc's base over the ailment's final is
   * the 0.85 in the ailment table, read off the screen rather than off the decompiler.
   */
  ailments?: ObservedAilmentEvent[];
  /** What the hit landed on, for the record — the fixture's `config.enemy` should match. */
  targetNotes?: string;
  /**
   * The damage log's own per-element blocks: the hit's own first, then one per bonus element.
   *
   * This is the field that makes a disagreement diagnosable. `hit` alone says the total is
   * wrong; this says *which layer* is wrong, which is the difference between an afternoon of
   * bisecting and reading one line.
   */
  log?: ObservedDamageEvent[];
  /** The log's `Total Combined Damage` line — every element's block summed, `(int)` cast. */
  totalCombined?: number;
  /**
   * Whether the logged hit was a critical one.
   *
   * The log does not print it, so the capture has to. Without it there is no way to know which
   * of the engine's two branches to compare against, and `critical_damage` is a whole
   * multiplicative layer — guessing costs the entire comparison.
   */
  wasCrit?: boolean;
  /**
   * The exile effects that were up **at the instant of the hit**, id -> stacks.
   *
   * Not the same list as the character capture's. A stacking on-hit buff is the ordinary case:
   * `brutality` is granted by `brutality_on_basic_hit` and the planner assumes it at five
   * stacks, but a hit landed before any basic attack has none of it. Recording the state the
   * hit was actually made in is what lets the runner put the engine in that state rather than
   * comparing a planner default against a moment in combat.
   */
  effects?: Record<string, number>;
  /**
   * The weapon in hand when the hit landed.
   *
   * Separate from the build's mainhand on purpose, because the two can differ and did: a
   * capture taken with the scythe in the selected hotbar slot described a character whose hits
   * were made with a different sword entirely, and every absolute number in that comparison was
   * meaningless until somebody noticed. The runner warns when they disagree.
   */
  weapon?: ObservedWeapon;
};

/**
 * One layer's printed row in the log's `Damage Info:` block.
 *
 * `StatLayer.getTooltip` prints `+N` for an `ADD` layer and `xN` for every other action,
 * both through `MMORPG.DECIMAL_FORMAT` ("0.00"), so exactly one of the two fields is present
 * per row and both are good to half of the last printed digit.
 */
export type ObservedLayer = {
  /** `mmorpg_stat_layer` id — `flat_damage`, `additive_damage`, `physical_mitigation`, ... */
  layerId: string;
  /** Which side of the event wrote it, as the log's `[Source]` / `[Target]` prefix says. */
  side: "Source" | "Target";
  /**
   * The element a conversion row points at.
   *
   * `CONVERT_PERCENT`, `DAMAGE_TAKEN_AS` and `X_AS_BONUS_Y_ELEMENT_DAMAGE` print one row per
   * target element rather than one per layer, so the element is part of the row's identity —
   * without it a physical hit converting to two elements is two rows with one name. Absent on
   * the ordinary `ADD` and `MULTIPLY` rows, which have no target.
   */
  element?: string;
  /**
   * The `+N` an `ADD` layer prints — or, on a conversion row, the percentage it prints instead.
   *
   * The two share a field because the log does: both are the row's single number, and a
   * conversion percentage is printed raw rather than through `DECIMAL_FORMAT`.
   */
  amount?: number;
  /** The `xN` every other layer action prints. */
  multiplier?: number;
};

/** One named MORE from the log's `Multipliers:` block. */
export type ObservedMore = {
  /** `mmorpg_stat` id. The log prints the stat's localised name; the mod writes the id. */
  statId: string;
  multi: number;
};

/**
 * One element's block of the damage log.
 *
 * The hover prints the hit's own element first and then repeats the whole block for each bonus
 * element conversion spawned, which is why this is a list rather than one object.
 */
export type ObservedDamageEvent = {
  /** `Elements` name, lowercased — `physical`, `fire`, ... */
  element: string;
  /** The log's `Base Damage` line. `(int)` cast, so the true value is `[n, n+1)`. */
  baseDamage: number;
  /** Every row of `Damage Info:`, in the order the log printed them (layer priority). */
  layers: ObservedLayer[];
  /** Every row of `Multipliers:`. Absent from the log entirely when there are none. */
  moreMultis: ObservedMore[];
  /** The log's `Final Damage` line. `.intValue()`, so again `[n, n+1)`. */
  finalDamage: number;
};

/**
 * The two blocks one ailment prints: the event that applied it, and the proc that released it.
 *
 * **Both are their own `DamageEvent`, and they carry different amounts of pipeline.** The
 * applying event is the full sweep — `AilmentChance.activate` runs `Activate()` on it, so it has
 * an `additive_damage` row, the target's mitigation and every MORE, exactly like a hit. The proc
 * is the opposite: `EntityAilmentData` fires the accumulated pool with `calcSourceEffects =
 * calcTargetEffects = false`, so its block prints an empty `Damage Info:` and `Final Damage`
 * equal to `Base Damage`. A proc block that shows layers is either a capture error or a real
 * finding, and the difference matters enough to record the empty list rather than omit it.
 *
 * **A proc capture has to be one application's worth.** The pool is a running sum — every hit
 * that freezes adds to it and it decays 10% a second — so a shatter caught after two freezes
 * carries both and cannot be compared against the engine's per-application figure. Capture it by
 * landing one hit and shattering before the next, which is what makes `proc.baseDamage /
 * applied.finalDamage` read as the ailment's `damageEffectivenessMulti` and nothing else.
 */
export type ObservedAilmentEvent = {
  /** `burn`, `poison`, `bleed`, `freeze` or `electrify`. */
  ailment: string;
  /**
   * The block the log printed when the ailment was applied — its `Ailment:` hover.
   *
   * This is the ailment's second `DamageEvent`, *before* `onAilmentCausingDamage` applies
   * `damageEffectivenessMulti`, `<ailment>_strength` and `<ailment>_resistance`. Its
   * `finalDamage` is therefore the engine's `eventDamage`, not what the ailment ends up dealing.
   */
  applied?: ObservedDamageEvent;
  /**
   * The `Ailment Proc:` block — Shatter for freeze, Shock for electrify.
   *
   * Only the two strength ailments have one; the three DoTs tick instead and never print it.
   */
  proc?: ObservedDamageEvent;
};

/**
 * Which weapon a logged hit was made with.
 *
 * Every field is optional because the fallback capture path is a human pasting hover text, who
 * may know only the item's name.
 */
export type ObservedWeapon = {
  /** `mmorpg_base_gear_types` id. */
  baseType?: string;
  /** Which hotbar slot held it, 0-8 — the field that catches a slot-1/slot-2 mix-up. */
  hotbarSlot?: number;
  /** The item's display name, for a human reading the fixture. */
  name?: string;
};

export type Observation = {
  source: ObservationSource;
  /** ISO date the numbers were read off. Drift matters after a pack update. */
  capturedAt: string;
  mineAndSlashVersion: string;
  packVersion: string;
  /** Free text: which character, which screen, anything odd about the capture. */
  notes?: string;
  stats: ObservedStat[];
  /** Damage readings. Absent in a stat-sheet-only capture, which is the common case. */
  damage?: ObservedDamage[];
  /**
   * The game's own per-context breakdown of every stat — what
   * `/mine_and_slash list_stat_sources <stat>` prints, as data.
   *
   * This is not another number to check; it is the answer to *why* a number is what it is.
   * `ListStatSourcesCommand` walks `Load.player(en).ctxs.list`, and each entry names the
   * `StatCtxType` a contribution came from. Working that out from the outside means searching
   * every registry for anything that grants the stat and then proving the character has it —
   * which is exactly the expensive part of diagnosing a mismatch.
   *
   * Absent from older captures and from any capture whose round trip did not land in time, so
   * everything that reads it must cope with it missing.
   */
  sources?: ObservedSource[];
};

/** One contribution, as the game recorded it. */
export type ObservedSource = {
  /** `mmorpg_stat` id. */
  statId: string;
  /** `StatContext.StatCtxType` — GEAR, AURA, TALENT, PASSIVES, BASE_STAT, ... */
  ctx: string;
  /** `StatContext.gear_slot`, set only for GEAR. */
  slot?: string;
  /** `ModType`: FLAT, PERCENT or MORE. */
  type: string;
  value: number;
};

export type Fixture = {
  name: string;
  notes?: string;
  build: BuildDoc;
  observed: Observation;
};

/**
 * What the engine returns per stat.
 *
 * `value` and `dmgMulti` are the calculation. The two caps are properties of the stat rather
 * than results, and they are here because the sheet prints them: comparing them turns every
 * capture into a check of the ported code-only stat definitions, which is the cheapest
 * validation available for the part of the engine with no JSON behind it. `usableValue` is
 * the `IUsableStat` curve — armor's 4,000 becoming 40% mitigation.
 */
export type ComputedStat = {
  value: number;
  dmgMulti: number;
  softcap?: number;
  hardcap?: number;
  usableValue?: number;
};

/**
 * The engine's entry point, as far as fixtures are concerned.
 *
 * Declaring it here rather than importing it keeps this package free of a dependency on the
 * engine — the fixture runner works with no engine at all, which is the state it ships in.
 */
export type StatCalculator = (build: BuildDoc, snapshot: Snapshot) => Map<string, ComputedStat>;

/**
 * How far off a computed number may be.
 *
 * The limit is not the engine's arithmetic, it is **how the number was captured**, which is
 * why it depends on `observed.source` as well as on the field — see {@link toleranceFor}.
 *
 * For a transcription from the stat GUI the bound is the screen: it formats with
 * `DecimalFormat("0.00")` for `current_value` and `dmg_multi` (MMORPG.java:116) and one decimal
 * for `usable_value` (NumberUtils.java:45-47), so a capture cannot be more precise than half of
 * the last printed digit, however carefully it was transcribed. Comparing tighter than that
 * would fail honest fixtures. Comparing looser would let a real error through.
 *
 * `softcap` and `hardcap` print as integers, so they stay exact.
 */
export type Tolerance = { absolute: number; relative: number };

export const EXACT: Tolerance = { absolute: 1e-6, relative: 0 };

/** Half of the last digit the sheet prints, plus a hair for float representation noise. */
export const TWO_DECIMALS: Tolerance = { absolute: 0.005 + 1e-9, relative: 0 };
export const ONE_DECIMAL: Tolerance = { absolute: 0.05 + 1e-9, relative: 0 };

/**
 * Damage numbers are read off floating combat text and health bars, not a formatted stat row,
 * and the game truncates to an int at several points in `ValueCalculation`. Half a point is
 * the tightest honest bound for a transcribed hit; `baseValue` comes from a tooltip that
 * prints a plain integer, so it stays exact.
 */
export const HALF_POINT: Tolerance = { absolute: 0.5 + 1e-9, relative: 0 };

/**
 * The band an `(int)` cast in the log leaves behind.
 *
 * `Base Damage`, `Final Damage` and `Total Combined Damage` are all printed through a cast,
 * not a rounding — `(int) this.data.getOriginalNumber(...).number` and
 * `info.dmgmap.get(...).intValue()` — so a printed 13041 means the game held something in
 * `[13041, 13042)`. That is not a symmetric tolerance, and treating it as `±0.5` would fail a
 * correct engine on any hit whose fraction happened to exceed one half. {@link compareTruncated}
 * tests the band instead; this constant only carries the float slack at its edges.
 */
export const TRUNCATION_SLACK = 1e-6;

/**
 * The default table: what a human reading a screen can honestly record.
 *
 * Used for `stat_gui` and `damage_log`, and as the fallback for any field a tighter source has
 * no opinion about.
 */
export const FIELD_TOLERANCE: Record<ComparedField, Tolerance> = {
  currentValue: TWO_DECIMALS,
  dmgMulti: TWO_DECIMALS,
  usableValue: ONE_DECIMAL,
  softcap: EXACT,
  hardcap: EXACT,
  baseValue: EXACT,
  hit: HALF_POINT,
  crit: HALF_POINT,
  ailmentPerSecond: HALF_POINT,
  // The three endpoints are int-cast and go through {@link compareTruncated} instead, which
  // ignores this entry; it is here because the table is exhaustive over `ComparedField`.
  baseDamage: EXACT,
  finalDamage: EXACT,
  totalCombined: EXACT,
  // Everything in between is printed through `MMORPG.DECIMAL_FORMAT` ("0.00"), so half of the
  // last digit is the tightest honest bound — the same argument as the stat GUI's, for the same
  // `DecimalFormat`.
  layerAmount: TWO_DECIMALS,
  layerMultiplier: TWO_DECIMALS,
  moreMulti: TWO_DECIMALS,
};

/**
 * What the companion mod's rounding costs: it writes stat values to four decimals
 * (`ObservedExport.round`), so a recorded number is within half of the last digit of the float
 * the game actually held.
 */
const MOD_DUMP_ROUNDING = 0.00005;

/**
 * The gap between the game's arithmetic and this engine's, as a fraction of the value.
 *
 * Mine and Slash computes in 32-bit `float` from end to end — `StatData.v1`, every
 * `ExactStatData`, the whole container — and this engine computes in doubles. A single float
 * rounding is at most `2^-24` (about 6e-8) of the value, and a stat's number is the result of a
 * chain of them: a base, a sum of flats, a percent multiply, a MORE multiply, a level scale, a
 * clamp. A few dozen roundings puts the worst case near 3e-6; `1e-5` is that with room to
 * spare.
 *
 * This term is the reason a mod dump needs a *relative* bound rather than a tighter absolute
 * one. At 18 attack speed it allows 0.00023 where the stat GUI's rule allowed 0.005 — twenty
 * times stricter. At 50,000 health it allows 0.5, which sounds loose until you notice that one
 * float32 step at that magnitude is already 0.0039: the old flat 0.005 was asking for agreement
 * finer than the game can represent, and would have failed a correct engine rather than caught
 * a wrong one.
 */
const FLOAT32_DRIFT = 1e-5;

/**
 * A stat read straight out of the synced container, not off a screen.
 *
 * `{ i, v, m }` per stat, written by `UnitNbt.Save` — no formatting, no truncation, no
 * transcription. The only two things between that number and this comparison are the
 * exporter's four-decimal rounding and the float/double difference above.
 */
export const MOD_DUMP: Tolerance = {
  absolute: MOD_DUMP_ROUNDING + 1e-9,
  relative: FLOAT32_DRIFT,
};

/**
 * Per-source overrides. A field absent here falls through to {@link FIELD_TOLERANCE}.
 *
 * `softcap` and `hardcap` are left out on purpose even for a mod dump: they are integers read
 * off the stat registry rather than computed, so `EXACT` is already right and loosening them
 * would only hide a wrong cap in the ported table.
 *
 * The damage fields are left out too, and a reading that needs a different bound says so itself
 * rather than inheriting one here: `ObservedDamage.source` overrides the observation's. That is
 * the ordinary case now — the companion mod writes the stat sheet as a float-exact dump but
 * cannot read the damage log, so a fixture routinely carries `mod_dump` stats beside
 * `damage_log` numbers that are still a human transcribing an int-rounded hover.
 */
const SOURCE_OVERRIDES: Record<ObservationSource, Partial<Record<ComparedField, Tolerance>>> = {
  stat_gui: {},
  damage_log: {},
  mod_dump: {
    currentValue: MOD_DUMP,
    dmgMulti: MOD_DUMP,
    usableValue: MOD_DUMP,
  },
};

/**
 * How close this field has to be, given where the number came from.
 *
 * Two captures of the same stat are not equally precise, and comparing them as though they were
 * is the difference between a runner that catches a 0.1% error and one that cannot. A
 * transcription from the stat GUI is bounded by the screen's two decimals; a dump from the
 * companion mod is bounded by float arithmetic, which is three orders of magnitude tighter at
 * the magnitudes most stats live at.
 */
export function toleranceFor(field: ComparedField, source: ObservationSource): Tolerance {
  return SOURCE_OVERRIDES[source][field] ?? FIELD_TOLERANCE[field];
}

export type ComparisonStatus =
  /** Engine agreed with the game. */
  | "match"
  /** Engine produced a number and it was wrong. */
  | "mismatch"
  /** Engine ran but returned nothing for this stat. */
  | "missing"
  /** No engine to ask. */
  | "unimplemented";

/** Which observed field a comparison is about. `currentValue` is `ComputedStat.value`. */
export const COMPARED_FIELDS = [
  "currentValue",
  "dmgMulti",
  "usableValue",
  "softcap",
  "hardcap",
  "baseValue",
  "hit",
  "crit",
  "ailmentPerSecond",
  "baseDamage",
  "layerAmount",
  "layerMultiplier",
  "moreMulti",
  "finalDamage",
  "totalCombined",
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export type StatComparison = {
  /** The stat id, or for a damage comparison the spell id (suffixed for an ailment). */
  statId: string;
  field: ComparedField;
  expected: number;
  actual: number | null;
  delta: number | null;
  /**
   * How far off this field was allowed to be — `absolute + |expected| * relative` for whichever
   * tolerance applied. Reported so a mismatch can be read without knowing the table: "off by
   * 0.31, allowed 0.0005" says whether the engine is slightly adrift or plainly wrong.
   */
  allowed: number | null;
  status: ComparisonStatus;
};

/**
 * What the engine returns for one damage capture.
 *
 * Declared here rather than imported for the same reason as {@link StatCalculator}: this
 * package must keep working with no engine present.
 */
export type ComputedDamage = {
  baseValue: number;
  hit: number;
  crit: number;
  /** Ailment id -> damage per second. */
  ailmentPerSecond: Record<string, number>;
  /**
   * The engine's own layer stack, in the log's shape, so the two can be walked side by side.
   *
   * Declared with the observed types rather than the engine's `EventTrace` for the reason the
   * whole file is: this package must not depend on the engine. The engine's runner maps one to
   * the other, which is a projection — a trace carries who wrote into each layer and this does
   * not, because the log never printed that.
   */
  log?: ObservedDamageEvent[];
  totalCombined?: number;
  /** The same projection for each ailment the hit inflicted. See {@link ObservedAilmentEvent}. */
  ailments?: ObservedAilmentEvent[];
};

export type DamageCalculator = (
  build: BuildDoc,
  snapshot: Snapshot,
  spellId: string,
  /**
   * The reading to compute, when the capture recorded one.
   *
   * A logged hit is a moment in combat, not the planner's default: it has a crit branch and a
   * set of effects that were actually up. Handing those to the engine is what makes the
   * comparison about the damage pipeline rather than about which buffs a planner assumes.
   */
  observed?: ObservedDamage,
) => ComputedDamage | undefined;

export type FixtureResult = {
  name: string;
  /** What the numbers were read off, which is what decided the tolerance. */
  source: ObservationSource;
  /** Legality problems with the build document itself. */
  diagnostics: Diagnostic[];
  comparisons: StatComparison[];
};

export type CompareOptions = ValidateOptions & {
  tolerance?: Tolerance;
  /** Supply to check `observed.damage`. Without it those readings report `unimplemented`. */
  damage?: DamageCalculator | null;
};

/**
 * Validates a fixture's build and, if an engine is supplied, diffs it against the
 * observation.
 *
 * With no calculator every stat comes back `unimplemented`. That is the honest answer while
 * the engine does not exist, and it is deliberately not `match` — a runner that went green
 * against an empty engine would be worse than no runner.
 */
/**
 * The build as the observation was taken: nothing up that the capture did not record.
 *
 * A fixture is the one place the closed-world reading is right. Everywhere else this project
 * plans — it offers you every effect your build could apply and assumes them on, because that is
 * the question a planner is for. Here the question is whether the engine reproduces a *measured*
 * sheet, and the character whose sheet was measured was not running the buffs the capture did not
 * list. Assuming them would put stats on the engine's side that the game never had, and the
 * mismatch would look like a porting bug.
 *
 * Set here rather than written into the exported document, so that loading the same capture into
 * the app gives you a build to work on rather than a snapshot of one instant.
 */
function measured(build: BuildDoc): BuildDoc {
  return { ...build, config: { ...(build.config ?? {}), assumeEffects: "captured" } };
}

export function compareFixture(
  fixture: Fixture,
  snapshot: Snapshot,
  calculator: StatCalculator | null,
  options: CompareOptions = {},
): FixtureResult {
  // An explicit `options.tolerance` overrides everything, for a caller deliberately widening or
  // narrowing a run. Otherwise the capture's own source decides, per field.
  const tolerance = options.tolerance;
  const source = fixture.observed.source;
  const validateOptions: ValidateOptions =
    options.balanceId === undefined ? {} : { balanceId: options.balanceId };
  const diagnostics = validateBuild(fixture.build, snapshot, validateOptions);

  const computed = calculator ? calculator(measured(fixture.build), snapshot) : null;
  const comparisons: StatComparison[] = [];

  for (const observed of fixture.observed.stats) {
    const actual = computed?.get(observed.statId) ?? null;
    const ran = computed !== null;

    // A stat neither container holds is not unknown — the game has a defined answer for it:
    //
    //     public StatData getCalculatedStat(String guid) {
    //         if (getStats().stats == null) { this.initStats(); }
    //         return getStats().stats.getOrDefault(guid, new StatData(guid, 0, 1));
    //     }
    //
    // — Unit.java:104-109, and `initStats` only allocates an empty map, so the game's own
    // container is sparse exactly as the engine's is. Value 0 and dmgMulti 1 are therefore the
    // right comparison for a stat the engine never touched, not a `missing` report: a capture
    // that observed `armor: 0` on a bare level 1 agrees with an engine that has no armor entry.
    // `usableValue` and the caps are deliberately left out — those are properties of the
    // registered `Stat` rather than of a `StatData`, so an absent one really is unknown here.
    const absentValue = ran && actual === null ? 0 : actual?.value;
    const absentMulti = ran && actual === null ? 1 : actual?.dmgMulti;

    comparisons.push(
      compareField(observed.statId, "currentValue", observed.currentValue, absentValue, ran, tolerance, source),
    );
    // The rest are optional in a capture: the sheet only shows `dmg_multi` on a
    // MULTIPLICATIVE_DAMAGE stat whose multiplier is not 1, `usable_value` on the four
    // `IUsableStat` stats, and no `softcap` row at all while nothing in the mod sets one.
    for (const [field, expected, got] of [
      ["dmgMulti", observed.dmgMulti, absentMulti],
      ["usableValue", observed.usableValue, actual?.usableValue],
      ["softcap", observed.softcap, actual?.softcap],
      ["hardcap", observed.hardcap, actual?.hardcap],
    ] as const) {
      if (expected !== undefined) {
        comparisons.push(compareField(observed.statId, field, expected, got, ran, tolerance, source));
      }
    }
  }

  compareDamage(fixture, snapshot, options.damage ?? null, tolerance, source, comparisons);

  diagnostics.push(...unrecordedContexts(fixture));
  diagnostics.push(...loggedWeaponMismatch(fixture, snapshot));

  return { name: fixture.name, source, diagnostics, comparisons };
}

/**
 * Checks that a logged hit was made with the weapon the capture describes.
 *
 * This exists because they were once not the same, and nothing said so. A capture reads the
 * *selected* hotbar slot, so a character with a scythe in slot 1 and a different sword in slot 2
 * exports the scythe — while the hits being compared against it were swung with the sword. Every
 * absolute number in that comparison is then about a weapon the build document does not contain,
 * and it looks exactly like an engine bug.
 *
 * A warning rather than an error: the reading is still worth keeping, and the ratios in it are
 * still meaningful. What it must not do is go unremarked.
 */
function loggedWeaponMismatch(fixture: Fixture, snapshot: Snapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const equipped = fixture.build.gear ?? [];

  for (const [i, observed] of (fixture.observed.damage ?? []).entries()) {
    const logged = observed.weapon?.baseType;
    if (logged === undefined) continue;

    const slot = baseGearType(snapshot, logged)?.gearSlot;
    // Compare within the slot the logged weapon belongs to. Matching against the whole of `gear`
    // would pass a build that happens to carry the same base in the offhand, which is the very
    // confusion this is here to catch.
    const inSlot = equipped.filter((item) => baseGearType(snapshot, item.base)?.gearSlot === slot);
    if (inSlot.some((item) => item.base === logged)) continue;

    const held = inSlot.length === 0 ? "nothing" : inSlot.map((item) => `\`${item.base}\``).join(", ");
    const where = observed.weapon?.hotbarSlot === undefined ? "" : ` (hotbar slot ${observed.weapon.hotbarSlot})`;
    out.push({
      severity: "warning",
      code: "logged-weapon-not-equipped",
      path: `observed.damage[${i}].weapon`,
      message:
        `The hit on \`${observed.spellId}\` was made with \`${logged}\`${where}, but the build's ` +
        `\`${slot ?? "unknown"}\` slot holds ${held}. The capture and the hit describe different ` +
        `characters, so every absolute number in this reading (base damage, flat damage) is ` +
        `comparing against gear that was not in hand. Re-export with the weapon that made the hit ` +
        `selected. Ratios and the layer structure are still meaningful.`,
    });
  }
  return out;
}

/**
 * Which build-document field produces each `StatCtxType` the game reports a contribution under.
 *
 * Only the types a document can express are listed. A capture whose `sources` name a type the
 * document is empty for is a capture taken by an exporter that did not know about it yet — and
 * the mismatch that follows is a *missing input*, not a wrong calculation. Saying so is the
 * whole point: three stats reading low because lunch was not recorded looks exactly like an
 * engine bug until something names the difference.
 */
const CONTEXT_FIELDS: Readonly<Record<string, { field: string; has: (build: BuildDoc) => boolean }>> = {
  GEAR: { field: "gear", has: (b) => (b.gear ?? []).length > 0 },
  JEWEL: { field: "jewels", has: (b) => (b.jewels ?? []).length > 0 },
  AURA: { field: "auras", has: (b) => (b.auras ?? []).length > 0 },
  FOOD_BUFF: { field: "foodBuffs", has: (b) => (b.foodBuffs ?? []).length > 0 },
  POTION_EFFECT: { field: "exileEffects", has: (b) => (b.exileEffects ?? []).length > 0 },
  TALENT: { field: "tree.talents", has: (b) => (b.tree?.talents ?? []).length > 0 },
  ASCENDANCY: { field: "tree.ascendancy", has: (b) => (b.tree?.ascendancy ?? []).length > 0 },
  ATLAS: { field: "tree.atlas", has: (b) => (b.tree?.atlas ?? []).length > 0 },
  PASSIVES: { field: "character.schools", has: (b) => Object.keys(b.character.schools ?? {}).length > 0 },
  STAT_POINTS: {
    field: "character.statPoints",
    has: (b) => Object.keys(b.character.statPoints ?? {}).length > 0,
  },
  VANILLA_STAT_COMPAT: {
    field: "character.attributes",
    has: (b) => Object.keys(b.character.attributes ?? {}).length > 0,
  },
  ENCHANT_COMPAT: {
    field: "character.attributes",
    has: (b) => Object.keys(b.character.attributes ?? {}).length > 0,
  },
};

function unrecordedContexts(fixture: Fixture): Diagnostic[] {
  const sources = fixture.observed.sources ?? [];
  if (sources.length === 0) return [];

  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const known = CONTEXT_FIELDS[source.ctx];
    if (!known || seen.has(source.ctx) || known.has(fixture.build)) continue;
    seen.add(source.ctx);
    const count = sources.filter((s) => s.ctx === source.ctx).length;
    out.push({
      severity: "warning",
      code: "capture-missing-context",
      path: known.field,
      message:
        `The capture records ${count} ${source.ctx} contribution(s) but \`${known.field}\` is empty, ` +
        `so the engine has nothing to reproduce them from. Any stat they touch will read low, and ` +
        `that is the capture missing an input rather than the engine being wrong. Re-export with ` +
        `a companion mod that records this.`,
    });
  }
  return out;
}

/**
 * Diffs the `observed.damage` block.
 *
 * Same posture as the stat comparison: with no calculator every reading is `unimplemented`,
 * never `match`. Only fields the capture actually recorded are compared, so a fixture holding
 * just a tooltip `baseValue` checks exactly that and claims nothing about the layer stack.
 */
function compareDamage(
  fixture: Fixture,
  snapshot: Snapshot,
  calculator: DamageCalculator | null,
  tolerance: Tolerance | undefined,
  observationSource: ObservationSource,
  out: StatComparison[],
): void {
  for (const observed of fixture.observed.damage ?? []) {
    const computed = calculator
      ? calculator(measured(fixture.build), snapshot, observed.spellId, observed)
      : undefined;
    const ran = calculator !== null;
    // A reading's own provenance wins over the observation's. See `ObservedDamage.source`.
    const source = observed.source ?? observationSource;

    for (const [field, expected, got] of [
      ["baseValue", observed.baseValue, computed?.baseValue],
      ["hit", observed.hit, computed?.hit],
      ["crit", observed.crit, computed?.crit],
    ] as const) {
      if (expected !== undefined) {
        out.push(compareField(observed.spellId, field, expected, got, ran, tolerance, source));
      }
    }

    for (const [ailment, expected] of Object.entries(observed.ailmentPerSecond ?? {})) {
      out.push(
        compareField(
          `${observed.spellId}/${ailment}`,
          "ailmentPerSecond",
          expected,
          computed?.ailmentPerSecond[ailment],
          ran,
          tolerance,
          source,
        ),
      );
    }

    compareLog(observed, computed, ran, tolerance, source, out);
    compareAilmentEvents(observed, computed, ran, tolerance, source, out);
  }
}

/**
 * Walks the log's layer stack against the engine's, row by row.
 *
 * The point of doing it this way rather than comparing the totals is that a damage pipeline is a
 * product of a dozen terms: one wrong factor moves the end, and the end alone cannot say which.
 * Every row here is a named place to be wrong — `quake/physical.additive_damage` disagreeing is
 * an afternoon shorter than `quake` disagreeing.
 *
 * Rows the engine produced and the log did not are **not** reported. The log prints only layers
 * that actually did something and only MOREs that are not exactly 1, and the far commoner cause
 * of an extra engine row is a capture that did not transcribe every line. A missing row on the
 * engine's side is reported, because that one is always the engine's.
 */
function compareLog(
  observed: ObservedDamage,
  computed: ComputedDamage | undefined,
  ran: boolean,
  tolerance: Tolerance | undefined,
  source: ObservationSource,
  out: StatComparison[],
): void {
  if (observed.totalCombined !== undefined) {
    out.push(
      compareTruncated(
        observed.spellId,
        "totalCombined",
        observed.totalCombined,
        computed?.totalCombined,
        ran,
      ),
    );
  }
  if (observed.log === undefined) return;

  for (const event of observed.log) {
    // Keyed by element rather than by position: the hover prints the hit's own element first
    // and then the bonus ones in map order, and a capture that transcribed them in another
    // order should still line up.
    const mine = computed?.log?.find((e) => e.element === event.element);
    compareEvent(`${observed.spellId}/${event.element}`, event, mine, ran, tolerance, source, out);
  }
}

/**
 * The ailment half of a damage capture: the block that applied each one, and the proc that
 * released it.
 *
 * Keyed by ailment id rather than by position, for the reason the hit's blocks are keyed by
 * element — a capture is a human reading hovers in whatever order they scrolled past.
 *
 * Nothing here is keyed off `ailmentPerSecond`. The two record different things and a capture
 * can have either: that field is one second of a DoT ticking, this is the event that applied it.
 */
function compareAilmentEvents(
  observed: ObservedDamage,
  computed: ComputedDamage | undefined,
  ran: boolean,
  tolerance: Tolerance | undefined,
  source: ObservationSource,
  out: StatComparison[],
): void {
  for (const event of observed.ailments ?? []) {
    const mine = computed?.ailments?.find((a) => a.ailment === event.ailment);
    const where = `${observed.spellId}/${event.ailment}`;
    if (event.applied !== undefined) {
      compareEvent(`${where}:applied`, event.applied, mine?.applied, ran, tolerance, source, out);
    }
    if (event.proc !== undefined) {
      compareEvent(`${where}:proc`, event.proc, mine?.proc, ran, tolerance, source, out);
    }
  }
}

/**
 * Walks one printed block — base, every layer row, every MORE, final — against the engine's.
 *
 * Shared by the hit's elements and by an ailment's two blocks because the log prints all of them
 * in the same shape, which is the whole reason the trace was built to match it.
 */
function compareEvent(
  where: string,
  event: ObservedDamageEvent,
  mine: ObservedDamageEvent | undefined,
  ran: boolean,
  tolerance: Tolerance | undefined,
  source: ObservationSource,
  out: StatComparison[],
): void {
  out.push(compareTruncated(where, "baseDamage", event.baseDamage, mine?.baseDamage, ran));
  out.push(compareTruncated(where, "finalDamage", event.finalDamage, mine?.finalDamage, ran));

  for (const layer of event.layers) {
    // Side is part of the identity. `additive_damage` is written by both halves of the event
    // and the log prints the prefix precisely because the two rows are different rows.
    const got = mine?.layers.find(
      (l) => l.layerId === layer.layerId && l.side === layer.side && l.element === layer.element,
    );
    const id = `${where}.${layer.layerId}${layer.element === undefined ? "" : `>${layer.element}`}[${layer.side}]`;
    if (layer.amount !== undefined) {
      out.push(compareField(id, "layerAmount", layer.amount, got?.amount, ran, tolerance, source));
    }
    if (layer.multiplier !== undefined) {
      out.push(
        compareField(id, "layerMultiplier", layer.multiplier, got?.multiplier, ran, tolerance, source),
      );
    }
  }

  for (const more of event.moreMultis) {
    out.push(
      compareField(
        `${where}.${more.statId}`,
        "moreMulti",
        more.multi,
        mine?.moreMultis.find((m) => m.statId === more.statId)?.multi,
        ran,
        tolerance,
        source,
      ),
    );
  }
}

/**
 * Compares against a number the game printed through an `(int)` cast.
 *
 * A printed `n` means the game held something in `[n, n + 1)`, so the test is the band and not
 * a distance. `delta` is reported as the signed distance *outside* it — zero when the engine
 * agrees, negative when it came in under the band, positive when it overshot — so the runner's
 * "off by X, allowed Y" line stays readable for a bound that is not symmetric.
 */
function compareTruncated(
  statId: string,
  field: ComparedField,
  expected: number,
  actual: number | undefined,
  engineRan: boolean,
): StatComparison {
  if (!engineRan) {
    return { statId, field, expected, actual: null, delta: null, allowed: null, status: "unimplemented" };
  }
  if (actual === undefined) {
    return { statId, field, expected, actual: null, delta: null, allowed: null, status: "missing" };
  }
  const low = expected - TRUNCATION_SLACK;
  const high = expected + 1 + TRUNCATION_SLACK;
  const delta = actual < low ? actual - expected : actual >= high ? actual - (expected + 1) : 0;
  return { statId, field, expected, actual, delta, allowed: 0, status: delta === 0 ? "match" : "mismatch" };
}

function compareField(
  statId: string,
  field: ComparedField,
  expected: number,
  actual: number | undefined,
  engineRan: boolean,
  tolerance: Tolerance | undefined,
  source: ObservationSource,
): StatComparison {
  if (!engineRan) {
    return { statId, field, expected, actual: null, delta: null, allowed: null, status: "unimplemented" };
  }
  if (actual === undefined) {
    return { statId, field, expected, actual: null, delta: null, allowed: null, status: "missing" };
  }
  const limit = tolerance ?? toleranceFor(field, source);
  const delta = actual - expected;
  const allowed = limit.absolute + Math.abs(expected) * limit.relative;
  return {
    statId,
    field,
    expected,
    actual,
    delta,
    allowed,
    status: Math.abs(delta) <= allowed ? "match" : "mismatch",
  };
}

/**
 * Parses and structurally checks a fixture file.
 *
 * Throws rather than returning diagnostics: a malformed fixture is a broken test, not a
 * finding about a character.
 */
export function parseFixture(value: unknown, origin: string): Fixture {
  const fail = (message: string): never => {
    throw new Error(`${origin}: ${message}`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected a JSON object at the top level");
  }
  const root = value as Record<string, unknown>;

  const name = root["name"];
  if (typeof name !== "string" || name.length === 0) return fail("missing `name`");

  const build = root["build"];
  if (build === null || typeof build !== "object" || Array.isArray(build)) {
    return fail("missing `build` object");
  }

  const observedRaw = root["observed"];
  if (observedRaw === null || typeof observedRaw !== "object" || Array.isArray(observedRaw)) {
    return fail("missing `observed` object");
  }
  const observed = observedRaw as Record<string, unknown>;

  const source = observed["source"];
  if (typeof source !== "string" || !(OBSERVATION_SOURCES as readonly string[]).includes(source)) {
    return fail(`observed.source must be one of ${OBSERVATION_SOURCES.join(" | ")}, got ${JSON.stringify(source)}`);
  }

  const statsRaw = observed["stats"];
  if (!Array.isArray(statsRaw)) return fail("observed.stats must be an array");

  const stats: ObservedStat[] = statsRaw.map((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`observed.stats[${i}] must be an object`);
    }
    const stat = raw as Record<string, unknown>;
    const statId = stat["statId"];
    if (typeof statId !== "string" || statId.length === 0) {
      return fail(`observed.stats[${i}].statId must be a non-empty string`);
    }
    const currentValue = stat["currentValue"];
    if (typeof currentValue !== "number" || !Number.isFinite(currentValue)) {
      return fail(`observed.stats[${i}].currentValue must be a finite number`);
    }
    return {
      statId,
      currentValue,
      ...optionalNumber(stat, "usableValue", i, fail),
      ...optionalNumber(stat, "dmgMulti", i, fail),
      ...optionalNumber(stat, "softcap", i, fail),
      ...optionalNumber(stat, "hardcap", i, fail),
    };
  });

  const damageRaw = observed["damage"];
  if (damageRaw !== undefined && !Array.isArray(damageRaw)) {
    return fail("observed.damage must be an array when present");
  }
  const damage: ObservedDamage[] = (damageRaw ?? []).map((raw: unknown, i: number) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`observed.damage[${i}] must be an object`);
    }
    const node = raw as Record<string, unknown>;
    const spellId = node["spellId"];
    if (typeof spellId !== "string" || spellId.length === 0) {
      return fail(`observed.damage[${i}].spellId must be a non-empty string`);
    }

    const perSecond = node["ailmentPerSecond"];
    const ailments: Record<string, number> = {};
    if (perSecond !== undefined) {
      if (perSecond === null || typeof perSecond !== "object" || Array.isArray(perSecond)) {
        return fail(`observed.damage[${i}].ailmentPerSecond must be an object`);
      }
      for (const [ailment, value] of Object.entries(perSecond as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return fail(`observed.damage[${i}].ailmentPerSecond.${ailment} must be a finite number`);
        }
        ailments[ailment] = value;
      }
    }

    const logRaw = node["log"];
    if (logRaw !== undefined && !Array.isArray(logRaw)) {
      return fail(`observed.damage[${i}].log must be an array when present`);
    }
    const log: ObservedDamageEvent[] = (logRaw ?? []).map((rawEvent: unknown, j: number) =>
      parseEvent(rawEvent, `observed.damage[${i}].log[${j}]`, fail),
    );

    const ailmentsRaw = node["ailments"];
    if (ailmentsRaw !== undefined && !Array.isArray(ailmentsRaw)) {
      return fail(`observed.damage[${i}].ailments must be an array when present`);
    }
    const ailmentEvents: ObservedAilmentEvent[] = (ailmentsRaw ?? []).map(
      (rawAilment: unknown, j: number) => {
        const at = `observed.damage[${i}].ailments[${j}]`;
        if (rawAilment === null || typeof rawAilment !== "object" || Array.isArray(rawAilment)) {
          return fail(`${at} must be an object`);
        }
        const node2 = rawAilment as Record<string, unknown>;
        const ailment = node2["ailment"];
        if (typeof ailment !== "string" || ailment.length === 0) {
          return fail(`${at}.ailment must be a non-empty string`);
        }
        return {
          ailment,
          ...(node2["applied"] === undefined
            ? {}
            : { applied: parseEvent(node2["applied"], `${at}.applied`, fail) }),
          ...(node2["proc"] === undefined
            ? {}
            : { proc: parseEvent(node2["proc"], `${at}.proc`, fail) }),
        };
      },
    );

    const readingSource = node["source"];
    if (
      readingSource !== undefined &&
      (typeof readingSource !== "string" ||
        !(OBSERVATION_SOURCES as readonly string[]).includes(readingSource))
    ) {
      return fail(
        `observed.damage[${i}].source must be one of ${OBSERVATION_SOURCES.join(" | ")} when present`,
      );
    }

    const effectsRaw = node["effects"];
    const effects: Record<string, number> = {};
    if (effectsRaw !== undefined) {
      if (effectsRaw === null || typeof effectsRaw !== "object" || Array.isArray(effectsRaw)) {
        return fail(`observed.damage[${i}].effects must be an object`);
      }
      for (const [id, stacks] of Object.entries(effectsRaw as Record<string, unknown>)) {
        if (typeof stacks !== "number" || !Number.isFinite(stacks)) {
          return fail(`observed.damage[${i}].effects.${id} must be a finite number`);
        }
        effects[id] = stacks;
      }
    }

    const weaponRaw = node["weapon"];
    if (
      weaponRaw !== undefined &&
      (weaponRaw === null || typeof weaponRaw !== "object" || Array.isArray(weaponRaw))
    ) {
      return fail(`observed.damage[${i}].weapon must be an object when present`);
    }
    const weaponNode = (weaponRaw ?? {}) as Record<string, unknown>;
    const weapon: ObservedWeapon = {
      ...(typeof weaponNode["baseType"] === "string" ? { baseType: weaponNode["baseType"] } : {}),
      ...(typeof weaponNode["name"] === "string" ? { name: weaponNode["name"] } : {}),
      ...optionalNumber(weaponNode, "hotbarSlot", i, fail),
    };

    return {
      spellId,
      ...optionalNumber(node, "baseValue", i, fail),
      ...optionalNumber(node, "hit", i, fail),
      ...optionalNumber(node, "crit", i, fail),
      ...optionalNumber(node, "totalCombined", i, fail),
      ...(typeof node["wasCrit"] === "boolean" ? { wasCrit: node["wasCrit"] } : {}),
      ...(perSecond === undefined ? {} : { ailmentPerSecond: ailments }),
      ...(logRaw === undefined ? {} : { log }),
      ...(ailmentsRaw === undefined ? {} : { ailments: ailmentEvents }),
      ...(readingSource === undefined ? {} : { source: readingSource as ObservationSource }),
      ...(effectsRaw === undefined ? {} : { effects }),
      ...(weaponRaw === undefined ? {} : { weapon }),
      ...(typeof node["targetNotes"] === "string" ? { targetNotes: node["targetNotes"] } : {}),
    };
  });

  // Provenance, not readings: a malformed row is dropped rather than failing the fixture, so
  // an older capture or a round trip that did not land still loads and still checks numbers.
  const sourcesRaw = observed["sources"];
  const sources: ObservedSource[] = (Array.isArray(sourcesRaw) ? sourcesRaw : [])
    .map((raw: unknown) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const node = raw as Record<string, unknown>;
      const statId = node["statId"];
      const value = node["value"];
      if (typeof statId !== "string" || statId.length === 0) return undefined;
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      return {
        statId,
        ctx: typeof node["ctx"] === "string" ? node["ctx"] : "",
        ...(typeof node["slot"] === "string" && node["slot"].length > 0 ? { slot: node["slot"] } : {}),
        type: typeof node["type"] === "string" ? node["type"] : "",
        value,
      };
    })
    .filter((row): row is ObservedSource => row !== undefined);

  return {
    name,
    ...(typeof root["notes"] === "string" ? { notes: root["notes"] } : {}),
    build: build as BuildDoc,
    observed: {
      ...(sources.length === 0 ? {} : { sources }),
      source: source as ObservationSource,
      capturedAt: asString(observed, "capturedAt"),
      mineAndSlashVersion: asString(observed, "mineAndSlashVersion"),
      packVersion: asString(observed, "packVersion"),
      ...(typeof observed["notes"] === "string" ? { notes: observed["notes"] } : {}),
      stats,
      ...(damageRaw === undefined ? {} : { damage }),
    },
  };
}


/**
 * One printed block — `Base Damage`, the `Damage Info:` rows, the `Multipliers:` rows, `Final
 * Damage`.
 *
 * Shared by `log[]` and by an ailment's two blocks, because the log prints all of them in the
 * same shape. `layers` and `moreMultis` default to empty rather than being required: an
 * `Ailment Proc:` block genuinely has none, and a capture that writes `"layers": []` is stating
 * that, not omitting it.
 */
function parseEvent(
  rawEvent: unknown,
  at: string,
  fail: (message: string) => never,
): ObservedDamageEvent {
  if (rawEvent === null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    return fail(`${at} must be an object`);
  }
  const ev = rawEvent as Record<string, unknown>;
  const element = ev["element"];
  if (typeof element !== "string" || element.length === 0) {
    return fail(`${at}.element must be a non-empty string`);
  }
  for (const key of ["baseDamage", "finalDamage"] as const) {
    if (typeof ev[key] !== "number" || !Number.isFinite(ev[key])) {
      return fail(`${at}.${key} must be a finite number`);
    }
  }
  const layersRaw = ev["layers"];
  if (layersRaw !== undefined && !Array.isArray(layersRaw)) {
    return fail(`${at}.layers must be an array when present`);
  }
  const layers: ObservedLayer[] = (layersRaw ?? []).map((rawLayer: unknown, k: number) => {
    if (rawLayer === null || typeof rawLayer !== "object" || Array.isArray(rawLayer)) {
      return fail(`${at}.layers[${k}] must be an object`);
    }
    const l = rawLayer as Record<string, unknown>;
    const layerId = l["layerId"];
    if (typeof layerId !== "string" || layerId.length === 0) {
      return fail(`${at}.layers[${k}].layerId must be a non-empty string`);
    }
    const side = l["side"];
    if (side !== "Source" && side !== "Target") {
      return fail(`${at}.layers[${k}].side must be "Source" or "Target"`);
    }
    // Exactly one of the two, because the log prints exactly one: `+N` for an ADD layer and
    // `xN` for every other action. A row carrying both is a transcription that guessed.
    const hasAmount = l["amount"] !== undefined;
    const hasMulti = l["multiplier"] !== undefined;
    if (hasAmount === hasMulti) {
      return fail(`${at}.layers[${k}] needs exactly one of "amount" or "multiplier"`);
    }
    return {
      layerId,
      side,
      ...(typeof l["element"] === "string" ? { element: l["element"] } : {}),
      ...optionalNumber(l, "amount", k, fail),
      ...optionalNumber(l, "multiplier", k, fail),
    };
  });

  const moreRaw = ev["moreMultis"];
  if (moreRaw !== undefined && !Array.isArray(moreRaw)) {
    return fail(`${at}.moreMultis must be an array when present`);
  }
  const moreMultis: ObservedMore[] = (moreRaw ?? []).map((rawMore: unknown, k: number) => {
    if (rawMore === null || typeof rawMore !== "object" || Array.isArray(rawMore)) {
      return fail(`${at}.moreMultis[${k}] must be an object`);
    }
    const m = rawMore as Record<string, unknown>;
    const statId = m["statId"];
    if (typeof statId !== "string" || statId.length === 0) {
      return fail(`${at}.moreMultis[${k}].statId must be a non-empty string`);
    }
    if (typeof m["multi"] !== "number" || !Number.isFinite(m["multi"])) {
      return fail(`${at}.moreMultis[${k}].multi must be a finite number`);
    }
    return { statId, multi: m["multi"] as number };
  });

  return {
    element,
    baseDamage: ev["baseDamage"] as number,
    layers,
    moreMultis,
    finalDamage: ev["finalDamage"] as number,
  };
}

function optionalNumber(
  node: Record<string, unknown>,
  key: string,
  index: number,
  fail: (message: string) => never,
): Record<string, number> {
  const v = node[key];
  if (v === undefined) return {};
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`[${index}].${key} must be a finite number`);
  }
  return { [key]: v as number };
}

function asString(node: Record<string, unknown>, key: string): string {
  const v = node[key];
  return typeof v === "string" ? v : "";
}
