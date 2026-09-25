#!/usr/bin/env node
/**
 * Ground-truth fixture runner.
 *
 *   npm run fixtures -- --snapshot data/snapshot.json [--fixtures fixtures] [--verbose]
 *
 * Validates every fixture's build document, then diffs the engine's stats against what was
 * observed in-game.
 *
 * It lives here rather than in `@cte2/schema` because it needs an engine to be worth running,
 * and schema deliberately does not depend on one — `compareFixture` and `parseFixture` stay
 * there as pure functions that work with no calculator at all.
 *
 * A fixture with no observations reports `pending` rather than passing. Nothing here folds an
 * unchecked stat into a success.
 */

import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

import type { Snapshot } from "@cte2/extractor";

import type { StatContext } from "./context.js";
import {
  compareFixture,
  parseFixture,
  type ComputedStat,
  type DamageCalculator,
  type ObservedAilmentEvent,
  type ObservedDamageEvent,
  type ObservedLayer,
  type ObservedSource,
  type Diagnostic,
  type Fixture,
  type FixtureResult,
  type StatCalculator,
} from "@cte2/schema";

import { calculate } from "./calculate.js";
import { EVENT } from "./damage/event.js";
import type { AilmentResult } from "./damage/ailments.js";
import type { EventTrace } from "./damage/breakdown.js";
import { simulateHit } from "./index.js";

/**
 * Engine diagnostics for the fixture currently being compared.
 *
 * `StatCalculator` returns a plain map — deliberately, so `@cte2/schema` keeps working with no
 * engine present — which means anything the engine *says* while computing is dropped on the
 * floor. That is the wrong place to lose it: "this effect was computed at 0% because no
 * applying spell was recorded" explains a whole column of mismatches, and the fixture run is
 * exactly where someone is looking. So the CLI keeps its own calculator closure and stashes
 * them here for `report` to print under the fixture they belong to.
 */
let engineDiagnostics: Diagnostic[] = [];

/** The engine's own contexts for the fixture being compared, to sit beside the game's. */
let engineContexts: StatContext[] = [];

const CALCULATOR: StatCalculator | null = (build, snapshot) => {
  const result = calculate(build, snapshot);
  engineDiagnostics = result.diagnostics;
  engineContexts = result.contexts;
  const out = new Map<string, ComputedStat>();
  for (const [id, stat] of result.stats) {
    out.set(id, {
      value: stat.value,
      dmgMulti: stat.dmgMulti,
      softcap: stat.softcap,
      hardcap: stat.hardcap,
      ...(stat.usableValue === undefined ? {} : { usableValue: stat.usableValue }),
    });
  }
  return out;
};

/**
 * The damage half of the runner.
 *
 * `hit` and `crit` are reported separately rather than averaged, matching the capture format:
 * a player can observe one hit or one crit, never the mean of the two.
 */
const DAMAGE: DamageCalculator | null = (build, snapshot, spellId, observed) => {
  const skill = (build.skills ?? []).find((s) => s.spellId === spellId);
  // A logged hit is a moment in combat, and the state it was made in is part of the reading.
  // `observed.effects` is the closed world the mod recorded at the instant of the hit; without
  // it the comparison is against the planner's defaults, which assume every buff the build
  // *could* put up is up. That difference is not small — a build whose `brutality` is granted
  // by `brutality_on_basic_hit` carries a whole extra MORE the hit never had.
  const withState =
    observed?.effects === undefined
      ? build
      : { ...build, config: { ...(build.config ?? {}), effects: { ...observed.effects } } };
  // A breakdown is opt-in because it allocates a trace per event, so ask for one exactly when
  // the capture has rows to compare it against — either the hit's blocks or an ailment's.
  const wantsTrace = observed?.log !== undefined || (observed?.ailments ?? []).length > 0;
  const result = simulateHit(withState, snapshot, {
    ...(skill ? { skill } : {}),
    ...(wantsTrace ? { breakdown: true } : {}),
  });
  if (!result) return undefined;

  // Which branch the log recorded. `critical_damage` is a multiplicative layer, so comparing a
  // logged crit against the non-crit branch is wrong by that whole factor.
  const outcome = observed?.wasCrit === true ? result.crit : result.hit;

  const ailmentPerSecond: Record<string, number> = {};
  const ailments: ObservedAilmentEvent[] = [];
  for (const ailment of outcome.ailments) {
    ailmentPerSecond[ailment.ailment] = ailment.damagePerSecond;
    const applied = ailment.trace === undefined ? undefined : flattenTrace(ailment.trace)[0];
    const proc = procBlock(ailment);
    if (applied !== undefined || proc !== undefined) {
      ailments.push({
        ailment: ailment.ailment,
        ...(applied === undefined ? {} : { applied }),
        ...(proc === undefined ? {} : { proc }),
      });
    }
  }
  const log = outcome.trace === undefined ? undefined : flattenTrace(outcome.trace);
  return {
    baseValue: result.baseValue,
    hit: result.hit.total,
    crit: result.crit.total,
    ailmentPerSecond,
    ...(log === undefined ? {} : { log, totalCombined: outcome.total }),
    ...(ailments.length === 0 ? {} : { ailments }),
  };
};

/**
 * The `Ailment Proc:` block one application of a strength ailment would fire.
 *
 * There is no event to flatten here, and that is the finding rather than a gap:
 * `EntityAilmentData.shatterAccumulated` builds its event with `calcSourceEffects =
 * calcTargetEffects = false`, so the pool goes out untouched and the log prints an empty
 * `Damage Info:` with `Final Damage` equal to `Base Damage`. Synthesising the block from
 * `accumulated` says exactly that, and a capture showing a layer in it is a real disagreement.
 *
 * `accumulated` is one application's contribution, so this is comparable only against a proc
 * captured after a single hit — see {@link ObservedAilmentEvent}.
 */
function procBlock(ailment: AilmentResult): ObservedDamageEvent | undefined {
  if (ailment.procChance <= 0 || ailment.accumulated <= 0) return undefined;
  return {
    element: ailment.element.toLowerCase(),
    baseDamage: ailment.accumulated,
    layers: [],
    moreMultis: [],
    finalDamage: ailment.accumulated,
  };
}

/**
 * Projects an {@link EventTrace} onto the shape the damage log prints.
 *
 * Three things the hover does that this has to do too, or the two lists will not line up:
 *
 * - **only `EventData.NUMBER` rows appear.** `getInfoHoverMessage` filters both the layers and
 *   the MOREs on it, so a layer that wrote into `before_conversion_number` is invisible there.
 * - **the tree is flattened.** A bonus element is a nested event in the engine and a repeated
 *   block in the log, one after another, so the children come out as siblings.
 * - **a conversion prints one row per target element**, not one per layer.
 */
function flattenTrace(root: EventTrace): ObservedDamageEvent[] {
  const out: ObservedDamageEvent[] = [];
  const visit = (trace: EventTrace): void => {
    const layers: ObservedLayer[] = [];
    for (const step of trace.steps) {
      if (step.numberId !== EVENT.NUMBER) continue;
      if (step.conversion.length > 0) {
        for (const conv of step.conversion) {
          layers.push({
            layerId: step.layerId,
            side: step.side,
            // Same normalisation as the block's own element, and for the same reason: a
            // conversion row's identity includes the element it points at.
            element: conv.element.toLowerCase(),
            amount: conv.percent,
          });
        }
      } else if (step.additionalTo !== undefined) {
        layers.push({
          layerId: step.layerId,
          side: step.side,
          element: step.additionalTo.toLowerCase(),
          amount: step.amount,
        });
      } else if (step.action === "ADD") {
        layers.push({ layerId: step.layerId, side: step.side, amount: step.amount });
      } else if (step.multiplier !== undefined) {
        layers.push({ layerId: step.layerId, side: step.side, multiplier: step.multiplier });
      }
    }
    out.push({
      // Lowercased to match `ObservedLayer.element`'s documented form. The engine carries
      // `ElementName` ("Cold"); the log and therefore a transcription print `cold`, and the
      // comparison keys blocks by this string — so a mismatch here reports every row of a
      // correct engine as missing.
      element: trace.element.toLowerCase(),
      baseDamage: trace.baseNumber,
      layers,
      moreMultis: trace.moreMultis
        .filter((m) => m.numberId === EVENT.NUMBER)
        .map((m) => ({ statId: m.statId, multi: m.multi })),
      finalDamage: trace.finalNumber,
    });
    for (const child of trace.children) visit(child);
  };
  visit(root);
  return out;
}

type Args = { snapshot: string; fixtures: string; verbose: boolean };

function parseArgs(argv: string[]): Args {
  let snapshot: string | null = null;
  let fixtures = "fixtures";
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--snapshot" || arg === "-s") snapshot = argv[++i] ?? null;
    else if (arg === "--fixtures" || arg === "-f") fixtures = argv[++i] ?? fixtures;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage(1);
    }
  }

  if (!snapshot) {
    console.error("Missing required --snapshot <path>");
    console.error("Build one with: npm run extract -- --install <path> --out data/snapshot.json");
    usage(1);
  }
  return { snapshot: snapshot!, fixtures, verbose };
}

function usage(code: number): never {
  console.log(
    [
      "Usage: cte2-fixtures --snapshot <file> [--fixtures <dir>] [--verbose]",
      "",
      "  --snapshot, -s  Extractor snapshot to validate against. Required.",
      "  --fixtures, -f  Directory of fixture JSON files (default: fixtures).",
      "  --verbose, -v   List every stat comparison, not just failures.",
    ].join("\n"),
  );
  process.exit(code);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const snapshotPath = resolve(args.snapshot);
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  } catch (err) {
    console.error(`Could not read the snapshot at ${snapshotPath}: ${asMessage(err)}`);
    process.exit(2);
  }

  const fixturesDir = resolve(args.fixtures);
  const files = findFixtures(fixturesDir);
  if (files.length === 0) {
    console.error(`No fixture files found in ${fixturesDir}`);
    process.exit(2);
  }

  console.log(`snapshot  ${snapshotPath}`);
  console.log(`fixtures  ${fixturesDir} (${files.length} file${files.length === 1 ? "" : "s"})`);
  console.log(`engine    ${CALCULATOR ? "@cte2/engine" : "NOT IMPLEMENTED - stat comparisons cannot run yet"}`);
  console.log("");

  const results: FixtureResult[] = [];
  /** Keyed by fixture name, so `report` can print them where they make sense. */
  const fromEngine = new Map<string, Diagnostic[]>();
  const contextsOf = new Map<string, StatContext[]>();
  const observedOf = new Map<string, readonly ObservedSource[]>();
  const readingSourcesOf = new Map<string, readonly string[]>();
  let loadFailures = 0;

  for (const file of files) {
    let fixture: Fixture;
    try {
      fixture = parseFixture(JSON.parse(readFileSync(file, "utf8")), file);
    } catch (err) {
      console.log(`FAILED TO LOAD  ${file}`);
      console.log(`                ${asMessage(err)}`);
      loadFailures++;
      continue;
    }
    engineDiagnostics = [];
    engineContexts = [];
    const result = compareFixture(fixture, snapshot, CALCULATOR, { damage: DAMAGE });
    fromEngine.set(result.name, engineDiagnostics);
    contextsOf.set(result.name, engineContexts);
    observedOf.set(result.name, fixture.observed.sources ?? []);
    readingSourcesOf.set(
      result.name,
      (fixture.observed.damage ?? [])
        .map((d) => d.source)
        .filter((x): x is NonNullable<typeof x> => x !== undefined && x !== fixture.observed.source),
    );
    results.push(result);
  }

  for (const result of results) {
    report(
      result,
      args.verbose,
      fromEngine.get(result.name) ?? [],
      {
        engine: contextsOf.get(result.name) ?? [],
        observed: observedOf.get(result.name) ?? [],
      },
      readingSourcesOf.get(result.name) ?? [],
    );
  }

  const errors = results.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === "error").length, 0);
  const warnings = results.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === "warning").length, 0);
  const mismatched = countStatus(results, "mismatch") + countStatus(results, "missing");
  const unimplemented = countStatus(results, "unimplemented");
  const matched = countStatus(results, "match");

  const pending = results.filter((r) => r.comparisons.length === 0).length;

  console.log("summary");
  console.log(`  fixtures loaded       ${results.length}${loadFailures > 0 ? `  (${loadFailures} failed to load)` : ""}`);
  console.log(`  awaiting capture      ${pending}`);
  console.log(`  legality errors       ${errors}`);
  console.log(`  legality warnings     ${warnings}`);
  console.log(`  stats matched         ${matched}`);
  console.log(`  stats wrong           ${mismatched}`);
  console.log(`  stats unimplemented   ${unimplemented}`);

  if (unimplemented > 0) {
    console.log("");
    console.log(`  ${unimplemented} stat(s) could not be checked: there is no engine yet.`);
  }
  if (pending > 0) {
    console.log("");
    console.log(`  ${pending} fixture(s) have no observed numbers, so they pin nothing.`);
    console.log("  Capture one from the in-game stat sheet - see fixtures/README.md.");
  }
  if (matched === 0 && mismatched === 0) {
    console.log("");
    console.log("  No calculation was checked by this run. It proves the fixtures are");
    console.log("  well-formed and legal, and nothing more.");
  }

  process.exit(loadFailures > 0 || errors > 0 || mismatched > 0 ? 1 : 0);
}

/**
 * Both breakdowns for one stat, side by side.
 *
 * The game's half is what `/mine_and_slash list_stat_sources` prints, captured as data — and it
 * names the `StatCtxType`, which is the expensive thing to work out from the outside. Printing
 * it next to the engine's own contexts turns "search every registry for anything that grants
 * this stat" into reading two short lists and spotting the row that is in one and not the
 * other. It is only printed for stats that actually disagree, because that is the only time
 * anybody wants sixty lines of provenance.
 */
function explain(statId: string, sources: Sources): string[] {
  const observed = sources.observed.filter((s) => s.statId === statId);
  const engine = sources.engine.flatMap((ctx) =>
    ctx.stats.filter((m) => m.statId === statId).map((m) => ({ ctx: ctx.type, source: ctx.source, m })),
  );
  if (observed.length === 0 && engine.length === 0) return [];

  const out: string[] = [];
  if (observed.length === 0) {
    out.push("           game:   (no breakdown captured; re-export to get one)");
  } else {
    for (const s of observed) {
      const slot = s.slot === undefined ? "" : ` ${s.slot}.`;
      out.push(`           game:   ${s.ctx}${slot} ${format(s.value)} ${s.type}`);
    }
  }
  for (const e of engine) {
    out.push(`           engine: ${e.ctx} ${e.source} ${format(e.m.value)} ${e.m.type}`);
  }
  return out;
}

type Sources = { engine: readonly StatContext[]; observed: readonly ObservedSource[] };

function report(
  result: FixtureResult,
  verbose: boolean,
  engine: readonly Diagnostic[],
  sources: Sources,
  /** Sources that a `damage` reading declared for itself, where they differ from the fixture's. */
  readingSources: readonly string[],
): void {
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  const bad = result.comparisons.filter((c) => c.status === "mismatch" || c.status === "missing");

  const verdict = errors.length > 0 ? "ILLEGAL" : bad.length > 0 ? "WRONG" : "legal";
  // The source is printed because it decides how tightly this fixture was compared: a mod dump
  // is held to float drift, a transcription to the two decimals its screen prints.
  // A damage reading may declare its own source — the ordinary case being log numbers
  // transcribed beside a float-exact dump — and then one phrase would be claiming a precision
  // half the fixture was not held to.
  const alsoAt = [...new Set(readingSources)]
    .map((s) => `, damage ${s}: ${precisionOf(s)}`)
    .join("");
  console.log(
    `${verdict.padEnd(8)} ${result.name}  [${result.source}: ${precisionOf(result.source)}${alsoAt}]`,
  );

  for (const d of errors) console.log(`         error   ${d.path}  [${d.code}] ${d.message}`);
  for (const d of warnings) console.log(`         warn    ${d.path}  [${d.code}] ${d.message}`);
  // The engine's own complaints. These are not legality problems — the document is fine — they
  // are the engine saying which numbers it could not compute properly and why.
  for (const d of engine) {
    console.log(`         ${d.severity === "error" ? "engine!" : "engine "} ${d.path}  [${d.code}] ${d.message}`);
  }

  // A fixture with no observations is a placeholder, not a test. Say so every run rather
  // than letting it sit in the directory looking like coverage.
  if (result.comparisons.length === 0) {
    console.log("         pending no observations captured yet - see fixtures/README.md");
  }

  for (const c of bad) {
    const actual = c.actual === null ? "(nothing)" : String(c.actual);
    // "off by 0.31, allowed 0.0005" is the difference between "slightly adrift" and "plainly
    // wrong", and it saves looking the tolerance table up while reading a failure.
    const by =
      c.delta === null || c.allowed === null
        ? ""
        : `  (off by ${format(c.delta)}, allowed ${format(c.allowed)})`;
    console.log(
      `         ${c.status.padEnd(7)} ${c.statId}.${c.field}: expected ${c.expected}, got ${actual}${by}`,
    );
    // Only for the headline number: a `usableValue` or a cap disagreeing is not a question
    // about where contributions came from.
    if (c.field === "currentValue") {
      for (const line of explain(c.statId, sources)) console.log(line);
    }
  }

  if (verbose) {
    for (const c of result.comparisons.filter((x) => x.status === "match" || x.status === "unimplemented")) {
      console.log(`         ${c.status.padEnd(7)} ${c.statId}.${c.field}: expected ${c.expected}`);
    }
  }
}

/** What the tolerance for this source is, in one phrase, for the fixture's header line. */
function precisionOf(source: string): string {
  switch (source) {
    case "mod_dump":
      return "compared at float precision";
    case "damage_log":
      return "compared at the log's whole numbers";
    default:
      return "compared at the stat screen's 2 decimals";
  }
}

/** Short enough to read in a column, without pretending to precision the number lacks. */
function format(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.001 || abs >= 1e6) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

function countStatus(results: readonly FixtureResult[], status: string): number {
  return results.reduce((n, r) => n + r.comparisons.filter((c) => c.status === status).length, 0);
}

/**
 * Every fixture under `dir`, including the ones in `local/`.
 *
 * It recurses because that is where the captures actually are. `fixtures/local/` is git-ignored
 * so a real character's gear and tree never reach the repository, and the exporter's own
 * instructions put a capture there — but a runner that skipped the directory meant the default
 * command checked nothing but the committed placeholder, and the only fixtures that pin a number
 * had to be pointed at by hand.
 *
 * `*.raw.json` is the exporter's companion file: every equipped stack's NBT, written only when
 * asked for (`/pobexport raw`) and kept so a capture never has to be retaken. It is not a fixture
 * and would fail to parse as one.
 */
function findFixtures(dir: string): string[] {
  const out: string[] = [];

  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".raw.json")) {
        out.push(path);
      }
    }
  };

  walk(dir);
  return out.sort();
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main();
