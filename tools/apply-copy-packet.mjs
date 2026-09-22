#!/usr/bin/env node
/**
 * Merge a model's answers back into the packet, and say what is wrong with them.
 *
 *   node tools/apply-copy-packet.mjs answers.json
 *
 * `answers.json` is what came back: `[{ "id": "c1", "plain": "..." }, ...]`. A reply wrapped in a
 * fenced code block is fine; the first `[` to the last `]` is what gets parsed.
 *
 * This deliberately stops at the packet. It writes the answers into `copy-packet.json` and reports,
 * and it does **not** edit any `.tsx` — the JSX rewiring is a mechanical edit with a typechecker
 * behind it, and doing it from unvalidated model output in the same step would mean a bad batch
 * lands in twenty-five files at once. Read the report, then apply.
 *
 * ## What it checks
 *
 *   - every id answered, exactly once, and no ids invented;
 *   - no `plain` still carrying an identifier, a backtick or a TODO;
 *   - the `{…}` runtime placeholders preserved in number — a dropped one is a sentence with a
 *     missing value in it, and nothing downstream would notice;
 *   - the hedging and padding the brief bans, since that is the failure that survives every other
 *     check and can only otherwise be caught by reading all seventy.
 */

import { readFileSync, writeFileSync } from "node:fs";

const IDENT = [/[a-z][a-z0-9]{2,}_[a-z0-9_]{2,}/, /\b[A-Za-z]+[a-z]\.[a-z][A-Za-z]*/, /`/];
const PADDING = /\b(essentially|simply|it is worth noting|in order to|basically|please note|this value represents|refers to the)\b/i;

const answersPath = process.argv[2];
if (answersPath === undefined) {
  console.error("usage: node tools/apply-copy-packet.mjs answers.json");
  process.exit(2);
}

const raw = readFileSync(answersPath, "utf8");
const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
let answers;
try {
  answers = JSON.parse(json);
} catch (error) {
  console.error(`could not parse ${answersPath} as a JSON array: ${error.message}`);
  process.exit(2);
}

const packet = JSON.parse(readFileSync("copy-packet.json", "utf8"));
const byId = new Map(packet.entries.map((e) => [e.id, e]));
const seen = new Set();
const problems = [];
let filled = 0;
let skipped = 0;

for (const answer of answers) {
  const entry = byId.get(answer?.id);
  if (entry === undefined) { problems.push(`unknown id "${answer?.id}"`); continue; }
  if (seen.has(answer.id)) { problems.push(`${answer.id}: answered twice`); continue; }
  seen.add(answer.id);

  // A by-hand entry is prose interleaved with conditional rendering. It is not in the brief, so an
  // answer for one means the model was working from an older packet — and that answer was written
  // against text that had raw JSX in it. Refusing it is the point: it would read plausibly.
  if (entry.needsHand === true) {
    problems.push(`${entry.id}: is by-hand (${entry.file}:${entry.line}) and must not be answered by a model`);
    continue;
  }

  const plain = String(answer.plain ?? "").trim();
  if (plain === "SKIP") { entry.plain = "SKIP"; skipped++; continue; }
  if (plain === "" || /^TODO\b/i.test(plain)) { problems.push(`${entry.id}: empty or still TODO`); continue; }

  const ident = IDENT.find((re) => re.test(plain));
  if (ident !== undefined) problems.push(`${entry.id}: still names "${ident.exec(plain)[0]}"\n      ${plain}`);

  const want = (entry.tech.match(/…/g) ?? []).length;
  const got = (plain.match(/…/g) ?? []).length;
  if (want !== got) problems.push(`${entry.id}: ${want} runtime value(s) in the original, ${got} in the reply`);

  if (PADDING.test(plain)) problems.push(`${entry.id}: padding — "${PADDING.exec(plain)[0]}"`);

  entry.plain = plain;
  filled++;
}

const missing = packet.entries
  .filter((e) => e.needsHand !== true && !seen.has(e.id))
  .map((e) => e.id);

writeFileSync("copy-packet.json", JSON.stringify(packet, null, 2) + "\n");

const askable = packet.entries.filter((e) => e.needsHand !== true).length;
console.log(`answered : ${seen.size} of ${askable} askable (${packet.entries.length - askable} by hand)`);
console.log(`  written: ${filled}`);
console.log(`  skipped: ${skipped}`);
if (missing.length > 0) console.log(`\nnot answered (${missing.length}): ${missing.join(", ")}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("\nanswers merged into copy-packet.json — nothing applied to source yet");
