/**
 * What the engine makes of one spell, source by source.
 *
 *   npm run build && node tools/skill.mjs <spell id> [<spell id> ...] [--sweep]
 *
 * Step 2 of `SKILL-MODELLING.md`: the model's answer, laid out next to the hand-written list you
 * made from `spell-tree.mjs`. Each source prints its carrier, trigger and selector, the origin
 * chain that placed it, how many instances the cast produces and how many of them land.
 *
 * `--sweep` is step 3 — the same skill at nine distances. A correct model produces a curve with
 * a shape you can explain: monotonic decay for a nova, a plateau then a cliff for a fixed-radius
 * area, a peak at the travel distance for an aimed shot. A flat zero, a flat maximum or a
 * non-monotonic curve is a bug.
 *
 * Runs against the newest fixture in `fixtures/local`, because a blank character has no gear and
 * no support gems and half of what this is for only appears once stats reach the spell.
 */
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(root, 'packages/engine/dist/index.js')).href);
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot.json'), 'utf8'));
const dir = path.join(root, 'fixtures/local');
const pick = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json')).sort().pop();
const fx = JSON.parse(fs.readFileSync(path.join(dir, pick), 'utf8'));
// The whole skill bar is kept, not just the one being reported: a skill's projectile count and
// its exile-effect gates both depend on what else is equipped — `raging_dragon` has no
// `combo_extender` without the extender that grants it, and reports nothing at all.
const base = JSON.parse(JSON.stringify(fx.build));
const equipped = base.skills ?? [];
const sweep = process.argv.includes('--sweep');
for (const id of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const data = snapshot.registries['mmorpg_spells'][id].data;
  const existing = equipped.find((s) => s.spellId === id);
  const skill = existing ?? { spellId: id, level: Math.min(20, data.max_lvl ?? 16), gemPercent: 100 };
  const others = equipped.filter((s) => s.spellId !== id).map((s) => ({ ...s, main: false }));
  const doc = { ...base, skills: [{ ...skill, main: true }, ...others] };
  const r = E.simulateDps(doc, snapshot, { skill });
  console.log('=== ' + id, `dps ${Math.round(r.dps).toLocaleString('en-US')}  cycle ${r.rate.cycleSeconds.toFixed(2)}s  perCast ${Math.round(r.damagePerCast).toLocaleString('en-US')}`);
  for (const s of r.sources) {
    const o = s.source.origin;
    console.log(`  ${s.source.id.padEnd(26)} ${s.source.valueCalcId.padEnd(24)} ${s.source.element}`);
    console.log(`    carrier ${s.source.carrier.kind}×${s.source.carrier.count} life ${s.source.carrier.lifeTicks}  trigger ${JSON.stringify(s.source.trigger)}  target ${JSON.stringify(s.source.target)}`);
    if (o) console.log(`    origin ${o.atTarget ? 'at target' : 'at carrier'} chain=[${o.chain.map(c=>`${c.from.kind}:${c.carrier.kind}x${c.count}@${c.spawnedOn.kind}${c.scatter.x||c.scatter.z?`±${c.scatter.x}/${c.scatter.z}`:''}`).join(' -> ')}]`);
    console.log(`    fires/carrier ${s.source.firesPerCarrier} instances ${s.source.instancesPerCast}  lands ${s.coverage.hitsPerCast.toFixed(2)} (${s.coverage.method}) ${s.coverage.note ?? ''}`);
    console.log(`    hit ${Math.round(s.hit.average.total).toLocaleString('en-US')}  perCast ${Math.round(s.damagePerCast).toLocaleString('en-US')}`);
  }
  console.log('  unreachable', r.model.unreachableGroups, 'unmodelled', r.model.unmodelledActs);
  for (const b of r.model.blockedBy ?? [])
    console.log(`  BLOCKED ${b.requirement.negated ? 'NOT ' : ''}${b.requirement.effectId} x${b.requirement.minimumStacks} (have ${b.activeStacks}) -> ${b.damageActs} damage act(s)`);
  if (r.effects) for (const o of r.effects.options.filter(o => o.stacks > 0))
    console.log(`  effect ${o.id} x${o.stacks}/${o.maxStacks} (${o.side})`);
  if (r.reachDistance !== undefined) console.log("  reachDistance", r.reachDistance.toFixed(1));
  if (sweep) for (const d of [0,1,2,3,4,6,8,12,16]) {
    const res = E.simulateDps(doc, snapshot, { skill, placement: { distance: d, radius: 0.3, bearing: 0, height: 1 } });
    console.log('   d=' + String(d).padStart(2), res.sources.map(s => s.coverage.hitsPerCast.toFixed(2)).join(' '), ' dps', Math.round(res.dps).toLocaleString('en-US'));
  }
}
