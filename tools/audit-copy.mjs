#!/usr/bin/env node
/**
 * Which player-facing sentences still have an engine identifier in them.
 *
 *   node tools/audit-copy.mjs
 *
 * ## Why this exists
 *
 * Roughly half the planner's hover text was written while the port was being worked out, and it
 * shows: a hint would name the stat it read rather than the thing the stat means — "cast_time_ticks,
 * divided by your cast or attack speed", or once "`shatterAccumulated` fires an
 * `EventBuilder.ofDamage` of its own". That wording is how you check a figure against the game and
 * noise to everyone else, so it now lives behind the Technical toggle (`ui/detail-mode.ts`) with a
 * plain wording beside it (`ui/copy/`).
 *
 * Moving ~200 sentences across is the kind of job that gets handed to a cheap model a panel at a
 * time, and the failure mode there is silent: a `plain` that still says `dmg_received`, or one left
 * as a TODO, looks exactly like a finished one in a diff. So the check is mechanical.
 *
 * ## What it checks
 *
 *   1. no `plain` in `ui/copy/` still contains an identifier-shaped token, or is still a TODO;
 *   2. no `<code>` sits outside a `<Tech>` block, since that is an identifier shown to a reader
 *      who did not ask for one;
 *   3. how many copy props in the panels are still un-migrated, reported as a backlog rather than
 *      as a failure — the migration is per-panel and a number that only goes down is the point.
 *
 * Nothing here looks at anything the pack supplies. Stat names, skill descriptions, affixes and
 * tree nodes are the game's own words, rendered by `@cte2/schema`'s `display.ts`, and an
 * identifier showing up *there* means the pack has no lang key for it — a different problem with a
 * different fix, and not one this file has an opinion about.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Repo-relative and forward-slashed, so a path reads the same on either platform. */
const where = (path) => relative(".", path).split(sep).join("/");

const ROOT = "packages/app/src/renderer/src";
const COPY_DIR = `${ROOT}/ui/copy`;

/**
 * What an engine identifier looks like in the middle of a sentence.
 *
 * `snake_case` needs three characters either side of the underscore so that ordinary hyphenated
 * prose and the odd `per_second` unit do not swamp the report. The dotted form catches the Java
 * that leaked in — `DamageEvent.canAvoidHit`, `EventBuilder.ofDamage`. Backticks are their own
 * signal: prose does not quote itself.
 */
const IDENTIFIER = [
  /[a-z][a-z0-9]{2,}_[a-z0-9_]{2,}/,
  /\b[A-Za-z]+[a-z]\.[a-z][A-Za-z]*\(/,
  /`[^`]+`/,
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** Every `plain:` value in the copy tables, with the line it is on. */
function plainStrings(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^\s*plain:\s*(.*)$/.exec(lines[i]);
    if (start === null) continue;
    // A value wraps onto the next lines when it is concatenated with `+`, so take lines until the
    // one that ends the property. Reading them as one string is the point: an identifier can be
    // split across the join and still be an identifier on screen.
    let body = start[1];
    let j = i;
    while (!/,\s*$/.test(body) && j + 1 < lines.length) body += " " + lines[++j].trim();
    const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (parts.length > 0) found.push({ line: i + 1, value: parts.join("") });
  }
  return found;
}

/**
 * Files the identifier checks do not apply to.
 *
 * `ui/copy/` is where the technical wording is supposed to live, and the Data tab is a
 * diagnostics surface whose whole audience is someone reading the extract — its prose stays
 * technical throughout rather than growing a plain half nobody wants.
 */
const skip = (path) => {
  const p = where(path);
  return p.includes("/ui/copy/") || p.endsWith("/panels/data/DataPanel.tsx");
};

/** Whether a line is comment, where a `<code>` or a stat id is documentation and not output. */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

const problems = [];

// --- 1. the copy tables themselves -------------------------------------------------------------
let checked = 0;
for (const path of walk(COPY_DIR)) {
  if (path.endsWith("hint.tsx")) continue;
  for (const { line, value } of plainStrings(path)) {
    checked++;
    const at = `${where(path)}:${line}`;
    if (/^TODO\b/i.test(value.trim()) || value.trim() === "") {
      problems.push(`${at}  plain is still a stub — "${value}"`);
      continue;
    }
    const hit = IDENTIFIER.find((re) => re.test(value));
    if (hit !== undefined) {
      problems.push(`${at}  plain still names an identifier: "${hit.exec(value)[0]}"\n    ${value}`);
    }
  }
}

// --- 2. <code> outside <Tech> ------------------------------------------------------------------
//
// Deliberately crude: a `<code>` and a `<Tech>` on the same line, or a `<code>` inside a `<Tech>`
// block that opens and closes across lines. Anything cleverer would be parsing JSX to catch a
// mistake that is obvious once it is pointed at.
const codeOutsideTech = [];
for (const path of walk(ROOT)) {
  if (skip(path)) continue;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/<Tech>/g) ?? []).length;
    const closes = (line.match(/<\/Tech>/g) ?? []).length;
    if (/<code>/.test(line) && depth + opens === 0 && !isComment(line)) {
      codeOutsideTech.push(`${where(path)}:${i + 1}`);
    }
    depth += opens - closes;
  }
}

// --- 3. the backlog ----------------------------------------------------------------------------
let backlog = 0;
for (const path of walk(ROOT)) {
  if (skip(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /(?:hint|lead|summary|title)=\{?"([^"]{25,})"/.exec(line);
    if (m !== null && IDENTIFIER.some((re) => re.test(m[1]))) backlog++;
  }
}

// --- report ------------------------------------------------------------------------------------
console.log(`copy tables: ${checked} plain string(s) checked`);
if (codeOutsideTech.length > 0) {
  console.log(`\n<code> outside <Tech> — ${codeOutsideTech.length}:`);
  for (const at of codeOutsideTech) console.log(`  ${at}`);
}
console.log(`\nun-migrated copy props still naming an identifier: ${backlog}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in the copy tables:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("\ncopy tables clean");
