#!/usr/bin/env node
/**
 * Read `copy-review.md` back into `copy-packet.json`.
 *
 *   node tools/ingest-copy-review.mjs
 *
 * The review file is the one artefact a person actually edits by hand — it is the 56 wordings laid
 * out as prose, with no JSON to fight. Whatever is under a `**new**` heading wins over what the
 * model returned, so the packet ends up holding the edited text and the apply step never has to
 * know which sentences came from where.
 *
 * Reports what changed rather than applying silently: a hand edit is the one input here nothing
 * else validates, and the person who made it is the only one who can confirm it was picked up.
 */

import { readFileSync, writeFileSync } from "node:fs";

const review = readFileSync("copy-review.md", "utf8");
const packet = JSON.parse(readFileSync("copy-packet.json", "utf8"));
const byId = new Map(packet.entries.map((e) => [e.id, e]));

// Split on the entry headings, then take everything after `**new**` up to the next heading.
const blocks = review.split(/^### /m).slice(1);
const changed = [];
const missing = [];
let seen = 0;

for (const block of blocks) {
  const id = /^(\S+)/.exec(block)?.[1];
  const entry = byId.get(id);
  if (entry === undefined) { missing.push(id); continue; }

  const m = /\*\*new\*\*\s*([\s\S]*?)\s*$/.exec(block);
  if (m === null) { missing.push(id); continue; }
  const text = m[1].replace(/\s+/g, " ").trim();
  if (text === "") { missing.push(id); continue; }

  seen++;
  if (text !== entry.plain) {
    changed.push({ id, file: `${entry.file}:${entry.line}`, from: entry.plain, to: text });
    entry.plain = text;
  }
}

writeFileSync("copy-packet.json", JSON.stringify(packet, null, 2) + "\n");

console.log(`read ${seen} wording(s) from copy-review.md`);
if (missing.length > 0) console.log(`  could not read: ${missing.join(", ")}`);
console.log(`  edited by hand: ${changed.length}`);
for (const c of changed) {
  console.log(`\n  ${c.id}  ${c.file.replace("packages/app/src/renderer/src/", "")}`);
  console.log(`    was: ${c.from.slice(0, 150)}`);
  console.log(`    now: ${c.to.slice(0, 150)}`);
}
