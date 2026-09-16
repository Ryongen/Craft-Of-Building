/**
 * One spell's raw registry entry, as the snapshot holds it.
 *
 *   node tools/spell.mjs <spell id>
 *
 * Step 1 of `SKILL-MODELLING.md` — read the JSON before running the engine, so that a
 * disagreement between the two tells you which one is wrong. Use `spell-tree.mjs` for the
 * readable version and this one when you need a field it strips.
 */
import fs from 'fs';
const s = JSON.parse(fs.readFileSync('data/snapshot.json','utf8'));
const id = process.argv[2];
const e = s.registries['mmorpg_spells'][id];
if (!e) { console.log('no such spell'); process.exit(1); }
console.log(JSON.stringify(e.data, null, 1));
