#!/usr/bin/env node
/**
 * Write the finished wordings from `copy-packet.json` into the renderer.
 *
 *   node tools/apply-to-source.mjs [--dry]
 *
 * Two shapes, because the packet holds two:
 *
 *   - `hint`  — a string prop. The pair goes into `ui/copy/<panel>.ts` and the prop becomes a
 *     reference to it.
 *   - `prose` — a JSX paragraph. The block is wrapped in `<Tech>` unchanged, and a `<Plain>`
 *     sibling is written above it carrying the same wrapper element so the styling is identical.
 *
 * ## Putting the runtime values back
 *
 * A plain wording holds `{…}` where the original had a real expression — `{num(x, 1)}`,
 * `{pool.name}`. Those are substituted back **in order**, which is the entire reason the merge
 * step refuses an answer whose placeholder count does not match: a wording that dropped one would
 * otherwise silently lose a number here, or shift every later value by one position.
 *
 * Entries marked `needsHand`, or still `TODO`/`SKIP`, are left alone.
 */

import { readFileSync, writeFileSync } from "node:fs";

const dry = process.argv.includes("--dry");
const packet = JSON.parse(readFileSync("copy-packet.json", "utf8"));
const done = (e) => e.plain !== undefined && !["TODO", "SKIP", "BY-HAND"].includes(e.plain);
const usable = packet.entries.filter((e) => e.needsHand !== true && done(e));

/** Source expressions in the order they appear, minus the `{" "}` spacers that are not values. */
function expressions(snippet) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const text = snippet.slice(start, i + 1);
        if (!/^\{\s*["']\s*["']\s*\}$/.test(text)) out.push(text);
        start = -1;
      }
    }
  }
  return out;
}

/** The plain text with `{…}` filled from `exprs`, in order. */
function rehydrate(plain, exprs) {
  let n = 0;
  return plain.replace(/\{…\}/g, () => exprs[n++] ?? "{}");
}

const edits = new Map();
const push = (file, edit) => {
  if (!edits.has(file)) edits.set(file, []);
  edits.get(file).push(edit);
};

for (const e of usable.filter((x) => x.kind === "prose")) push(e.file, e);

let wrapped = 0, skippedCount = 0;
const notes = [];

for (const [file, list] of edits) {
  const original = readFileSync(file, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);

  // Bottom-up, so an earlier edit never shifts a later line number.
  list.sort((a, b) => b.line - a.line);

  for (const e of list) {
    const start = e.line - 1;
    const end = e.endLine - 1;
    const block = lines.slice(start, end + 1);
    const snippet = block.join("\n");
    const pad = " ".repeat(block[0].length - block[0].trimStart().length);

    // The wrapper's opening tag, however many lines it spans, and its closing tag.
    const openEnd = block.findIndex((l) => />\s*$/.test(l) || /^[^<]*>/.test(l.trim().slice(1)));
    const tagName = /^\s*<([A-Za-z][\w.]*)/.exec(block[0])?.[1];
    if (tagName === undefined || openEnd < 0) { notes.push(`${e.id}: could not find a wrapper tag`); skippedCount++; continue; }

    const openTag = block.slice(0, openEnd + 1);
    const closeTag = `${pad}</${tagName}>`;
    if (!new RegExp(`</${tagName}>`).test(block[block.length - 1])) {
      notes.push(`${e.id}: block does not end on </${tagName}>`); skippedCount++; continue;
    }

    const inner = block.slice(openEnd + 1, block.length - 1).join("\n");
    const filled = rehydrate(e.plain, expressions(inner));

    // A fragment around the pair, always. Where the block was the only child of a `{cond && (…)}`
    // or a bare `return (…)`, two siblings are a syntax error; a fragment is a valid single element
    // everywhere else too, so there is no case worth branching on.
    const out = [
      `${pad}<>`,
      `${pad}<Plain>`,
      ...openTag.map((l) => `  ${l}`),
      `${pad}    ${filled}`,
      `  ${closeTag}`,
      `${pad}</Plain>`,
      `${pad}<Tech>`,
      ...block.map((l) => `  ${l}`),
      `${pad}</Tech>`,
      `${pad}</>`,
    ];
    lines.splice(start, block.length, ...out);
    wrapped++;
  }

  if (!dry) writeFileSync(file, lines.join(eol));
}

console.log(`${dry ? "[dry] " : ""}prose blocks wrapped: ${wrapped}`);
if (skippedCount > 0) {
  console.log(`  not applied: ${skippedCount}`);
  for (const n of notes) console.log(`    ${n}`);
}
