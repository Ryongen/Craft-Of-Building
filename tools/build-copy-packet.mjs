#!/usr/bin/env node
/**
 * Everything still waiting for a plain wording, as one JSON file somebody can hand to a model.
 *
 *   node tools/build-copy-packet.mjs
 *
 * Writes `copy-packet.json` and `copy-packet.md` to the repo root. Neither is committed; they are
 * the intermediate a batch of writing happens against.
 *
 * ## Why a packet rather than pointing a model at the files
 *
 * Two different jobs are left, and only one of them is writing. Filling a `plain` from a known
 * `tech` is copy, and a cheap model is fine at it. Wrapping 106 JSX paragraphs in `<Plain>` and
 * `<Tech>` is a mechanical edit across twenty-five files whose failure mode is a compile error or
 * a silently dropped element, and that is not a job to hand to a model that cannot run the
 * typechecker. So the model only ever sees strings, and `tools/apply-copy-packet.mjs` puts the
 * answers back.
 *
 * ## The two kinds of entry
 *
 *   - `hint`  — a string prop. The model writes `plain`; it goes in a `ui/copy/<panel>.ts` table.
 *   - `prose` — a JSX paragraph with `<code>` in it. The model writes one plain paragraph as
 *     **plain text**; the existing markup becomes the `<Tech>` half untouched.
 *
 * Every entry carries the flattened current text, so nobody has to read JSX to write English.
 *
 * ## `<code>` is not always an identifier
 *
 * `<code>1.0</code>` and `<code>0.5</code>` in `ConfigPanel` are config *values*, and a player
 * reading "Craft to Exile 2 ships 1.0" is not being shown an internal name. Those are classified
 * `literal` and are a reason to leave a paragraph alone, so the packet says which is which rather
 * than implying all 106 need rewriting.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "packages/app/src/renderer/src";
const where = (p) => relative(".", p).split(sep).join("/");
const skip = (p) => where(p).includes("/ui/copy/") || where(p).endsWith("/panels/data/DataPanel.tsx");

const IDENT = [/[a-z][a-z0-9]{2,}_[a-z0-9_]{2,}/, /\b[A-Za-z]+[a-z]\.[a-z][A-Za-z]*/];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const indent = (line) => line.length - line.trimStart().length;

/** JSX source to something a person can read: tags out, expressions as `{...}`, entities decoded. */
function flatten(snippet) {
  // `{" "}` is JSX's explicit space at a line break, not a value the app fills in. It has to go
  // before the collapse below, or every one of them becomes a placeholder and the packet
  // claims a dozen runtime values a paragraph does not have.
  let text = snippet.replace(/\{\s*["']\s*["']\s*\}/g, " ");
  // Collapse braces innermost-first until none are left. One pass is not enough: a conditional
  // branch holds its own expressions, and a single non-nested sweep leaves the outer block as
  // raw JSX source, which is exactly the shape a model will copy back at you.
  for (let guard = 0; guard < 20 && /\{/.test(text); guard++) {
    const next = text.replace(/\{[^{}]*\}/g, "");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(//g, "{…}")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\{"\s*"\}/g, " ")
    // Innermost-out, repeatedly: a single non-nested pass leaves the whole of a
    // `{cond ? (<>..{x}..</>) : (..)}` block sitting in the output as raw source.
    .replace(/\{[^{}]*\}/g, "{…}")
    .replace(/&(apos|rsquo|lsquo);/g, "'")
    .replace(/&(quot|rdquo|ldquo);/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&times;/g, "×")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The element a `<code>` is sitting inside.
 *
 * Nearest enclosing line that opens a text-bearing tag at a smaller indent, then down to the line
 * that closes it at that same indent. Crude on purpose — every one of these is a hand-written
 * paragraph in a panel, not generated markup, and the shape is consistent.
 */
function enclosing(lines, i) {
  const TAGS = /^\s*<(span|div|p|li|td|small|strong)\b/;
  let start = -1;
  for (let j = i; j >= 0 && i - j < 40; j--) {
    if (TAGS.test(lines[j]) && indent(lines[j]) < indent(lines[i])) { start = j; break; }
  }
  if (start === -1) return null;
  const tag = /^\s*<([A-Za-z]+)/.exec(lines[start])[1];
  const close = new RegExp(`</${tag}>`);
  for (let j = start + 1; j < lines.length && j - start < 60; j++) {
    if (close.test(lines[j]) && indent(lines[j]) <= indent(lines[start])) return { start, end: j, tag };
  }
  return null;
}

/**
 * The membership gate, frozen.
 *
 * Which blocks are in the packet decides the numbering, and the numbering is what a batch of
 * answers is keyed to. So this is deliberately the *original* flattener, kept bug-for-bug: a single
 * non-nested brace pass. Improving `flatten` changes how an entry reads, which is fine and wanted;
 * it must not change which entries exist, or every answer already written silently points at the
 * wrong thing. Nothing but the word count is computed from this.
 */
function legacyFlatten(snippet) {
  return snippet
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\{"\s*"\}/g, " ")
    .replace(/\{[^{}]*\}/g, "{…}")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const entries = [];
let id = 0;

for (const path of walk(ROOT)) {
  if (skip(path)) continue;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const file = where(path);

  // --- hint strings still naming an identifier ---
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
    const m = /(hint|lead|summary|title)=\{?"([^"]{25,})"/.exec(lines[i]);
    if (m === null || !IDENT.some((re) => re.test(m[2]))) continue;
    entries.push({
      id: `c${++id}`, kind: "hint", file, line: i + 1, prop: m[1],
      tech: m[2], plain: "TODO",
    });
  }

  // --- JSX paragraphs carrying <code> ---
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!/<code>/.test(lines[i]) || /^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
    const block = enclosing(lines, i);
    if (block === null || seen.has(block.start)) continue;
    seen.add(block.start);
    const snippet = lines.slice(block.start, block.end + 1).join("\n");
    const flat = flatten(snippet);
    // A block that flattens to placeholders and little else is a table cell or a badge rendering
    // a value, not a paragraph anybody wrote. There is no prose in it to rewrite.
    const words = legacyFlatten(snippet).replace(/[…{}]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length < 6) continue;
    // Prose interleaved with conditional rendering cannot be handed to a model: the paragraph a
    // reader sees depends on a branch, so there is no single "current text" to rewrite and no
    // single answer that could be applied. These are kept in the packet for the record and left
    // out of the pasteable brief, to be done by hand against the real JSX.
    const needsHand = /=>|<>|\?\s*\(|&&\s*\(|\.map\(|\.sort\(/.test(snippet);
    const codes = [...snippet.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => flatten(m[1]));
    entries.push({
      id: `c${++id}`, kind: "prose", file, line: block.start + 1, endLine: block.end + 1,
      codes: codes.map((c) => ({
        text: c,
        // A bare number or a filename is a value the reader wants; a snake_case or dotted name
        // is an internal symbol and is the reason the paragraph is in this packet at all.
        kind: IDENT.some((re) => re.test(c)) ? "identifier"
            : /^[\d.]+$/.test(c) ? "literal" : "other",
      })),
      tech: flat,
      needsHand,
      plain: needsHand ? "BY-HAND" : "TODO",
    });
  }
}

const identifierProse = entries.filter(
  (e) => e.kind === "prose" && e.codes.some((c) => c.kind === "identifier"));

writeFileSync("copy-packet.json", JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  counts: {
    total: entries.length,
    hint: entries.filter((e) => e.kind === "hint").length,
    prose: entries.filter((e) => e.kind === "prose").length,
    proseWithIdentifier: identifierProse.length,
  },
  entries,
}, null, 2) + "\n");

// --- the pasteable brief ------------------------------------------------------------------------
//
// One file rather than two, because the job is "paste this into a chat window". The JSON stays
// beside it for the round trip back through `tools/apply-copy-packet.mjs`.
const brief = readFileSync("tools/copy-packet-brief.md", "utf8");
const askable = entries.filter((e) => e.needsHand !== true);
const rendered = askable.map((e) => {
  const head = `### ${e.id}  (${e.kind})`;
  const codes = e.kind === "prose"
    ? `\ncodes: ${e.codes.map((c) => `${c.text} [${c.kind}]`).join(", ")}`
    : "";
  return `${head}\nfile: ${e.file}:${e.line}${codes}\n\ncurrent text:\n> ${e.tech}\n`;
}).join("\n");

writeFileSync("copy-packet.md",
  `${brief}\n---\n\n# The entries — ${askable.length} in total\n\n${rendered}`);

const handCount = entries.filter((e) => e.needsHand === true).length;
console.log(`entries: ${entries.length}  (askable ${askable.length}, by hand ${handCount})`);
console.log(`  hint strings          : ${entries.filter((e) => e.kind === "hint").length}`);
console.log(`  JSX paragraphs        : ${entries.filter((e) => e.kind === "prose").length}`);
console.log(`    ...with an identifier: ${identifierProse.length}`);
console.log(`    ...values only       : ${entries.filter((e) => e.kind === "prose").length - identifierProse.length}`);
console.log("\nwrote copy-packet.json");
