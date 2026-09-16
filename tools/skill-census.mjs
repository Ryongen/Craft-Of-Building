/**
 * Where the damage model stands, across every spell in the snapshot.
 *
 *   npm run build && node tools/skill-census.mjs [path/to/fixture.json]
 *
 * Runs `simulateDps` over all 432 spells and reports what the model made of each: how many of
 * its declared `damage` acts became sources, which coverage method each source resolved by,
 * which component groups nothing reached, and which spells land nothing at all.
 *
 * It is a triage tool, not a test. The numbers move with the build it is run against — a spell's
 * projectile count and cast speed both come from the character — so it answers "which spells is
 * the model failing to describe", never "is this DPS right". `SKILL-MODELLING.md` reads its
 * output into a work queue.
 */

import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `import()` of a bare Windows path is an unsupported URL scheme ("g:"), so go through file://.
const E = await import(pathToFileURL(path.join(root, 'packages/engine/dist/index.js')).href);
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'data/snapshot.json'), 'utf8'));

// A real character, because a blank one has no gear and no support gems, and half of what this
// is looking for only appears once stats reach the spell. Any `mod_dump` fixture will do.
const fixturePath = process.argv[2] ?? findFixture();
const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
console.log('census against', path.basename(fixturePath));
console.log();

function findFixture() {
  const dir = path.join(root, 'fixtures/local');
  const pick = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.raw.json')).sort().pop();
  if (!pick) throw new Error('no fixture in fixtures/local — pass one as an argument');
  return path.join(dir, pick);
}

const spells = snapshot.registries['mmorpg_spells'];
const base = JSON.parse(JSON.stringify(fx.build));
// The captured skill bar is kept beside the spell being measured, because exile-effect gates are
// answered from what the build can produce: `raging_dragon` reports nothing at all without the
// extender that grants `combo_extender`, and that is a fact about the bar, not about the model.
const equipped = base.skills ?? [];

/**
 * The summon skill whose pet casts this spell, when it is a pet basic attack.
 *
 * Read off `summon_basic_atk` across the whole spell registry rather than off a list of the
 * seventeen, so a pack that adds an eighteenth is covered without an edit here.
 */
const PET_BASICS = new Map();
for (const [id, e] of Object.entries(snapshot.registries['mmorpg_spells'])) {
  const basic = e.data?.config?.summon_basic_atk;
  if (typeof basic === 'string' && basic.length > 0 && !PET_BASICS.has(basic)) PET_BASICS.set(basic, id);
}
function petSummonerOf(id) {
  return PET_BASICS.get(id);
}

const rows = [];
const unmodelledActs = new Map();
const unreachable = new Map();
const coverageMethods = new Map();
const carrierKinds = new Map();
const triggerKinds = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const [id, entry] of Object.entries(spells)) {
  const data = entry.data;
  const maxLvl = typeof data.max_lvl === 'number' ? data.max_lvl : 16;
  const existing = equipped.find((s) => s.spellId === id);
  const skill = existing ?? { spellId: id, level: Math.min(20, maxLvl), gemPercent: 100 };
  const others = equipped.filter((s) => s.spellId !== id).map((s) => ({ ...s, main: false }));
  const doc = { ...base, skills: [{ ...skill, main: true }, ...others] };

  let r;
  try {
    r = E.simulateDps(doc, snapshot, { skill });
  } catch (err) {
    rows.push({ id, error: String(err).slice(0, 120) });
    continue;
  }
  if (!r) { rows.push({ id, error: 'no result' }); continue; }

  for (const a of r.model.unmodelledActs) bump(unmodelledActs, a);
  for (const g of r.model.unreachableGroups) bump(unreachable, `${id}:${g}`);
  for (const s of r.sources) {
    bump(coverageMethods, s.coverage.method);
    bump(carrierKinds, s.source.carrier.kind);
    bump(triggerKinds, s.source.trigger.kind);
  }

  const tags = (data.config?.tags?.tags) ?? [];
  rows.push({
    id,
    tags,
    style: data.config?.style,
    sources: r.sources.length,
    acts: countDamageActs(data),
    dps: r.dps,
    perCast: r.damagePerCast,
    cycle: r.rate.cycleSeconds,
    castSpeedTicks: r.declared.castSpeedTicks,
    offGcd: r.calc.offGlobalCooldown,
    projectiles: r.multiHit.projectiles,
    requires: r.requires,
    overlap: r.overlap.overlapping ? +r.overlap.concurrentCasts.toFixed(1) : 0,
    methods: [...new Set(r.sources.map((s) => s.coverage.method))],
    reach: r.reachDistance,
    channelled: r.rate.channelled,
    blocked: r.model.blockedBy.map((b) => `${b.requirement.negated ? '!' : ''}${b.requirement.effectId}x${b.requirement.minimumStacks}`),
    blockedActs: r.model.blockedBy.reduce((n, b) => n + b.damageActs, 0),
    procs: r.procs.filter((p) => p.dps > 0).length,
    procDps: r.procDps,
    summons: r.summons.length,
    summonDps: r.summonDps,
    // A pet basic attack's one real group is driven by the pet, not by a cast, so walking it
    // from `on_cast` finds nothing. That is not a hole; it is a spell measured through whichever
    // summon skill summons the pet. Counting them as MISSED put 17 permanent entries at the top
    // of the queue that no amount of work on the walk would ever clear.
    petBasicOf: petSummonerOf(data.identifier),
    zeroCoverage: r.sources.filter((s) => s.coverage.hitsPerCast === 0).length,
    unmodelled: r.model.unmodelledActs,
    unreachable: r.model.unreachableGroups,
    summonType: data.config?.summonType,
    channel: tags.includes('channel'),
  });
}

function countDamageActs(data) {
  const att = data.attached ?? {};
  const all = [...(att.on_cast ?? []), ...Object.values(att.entity_components ?? {}).flat()];
  let n = 0;
  // `per_entity_hit` sub-parts carry two of the pack's 427 `damage` acts and the spawns that
  // reach five whole component groups, so a count that skips them under-reports what the model
  // is being asked to find.
  const walk = (p) => {
    for (const a of p.acts ?? []) if (a.type === 'damage') n++;
    for (const inner of p.per_entity_hit ?? []) walk(inner);
  };
  for (const p of all) walk(p);
  return n;
}

const sort = (m) => [...m].sort((a, b) => b[1] - a[1]);
const ok = rows.filter((r) => !r.error);

console.log('=== coverage of the census ===');
console.log('spells', rows.length, '| errored', rows.filter(r => r.error).length);
console.log('spells with >=1 modelled damage source:', ok.filter(r => r.sources > 0).length);
const pets = ok.filter(r => r.petBasicOf !== undefined);
console.log('spells with 0 sources but >0 damage acts (MISSED):', ok.filter(r => r.sources === 0 && r.acts > 0 && r.petBasicOf === undefined).length,
  `(+${pets.filter(r => r.sources === 0).length} pet basics, measured through their summon skill)`);
console.log('summon skills with pets producing damage:', ok.filter(r => r.summonDps > 0).length);
console.log('spells with 0 damage acts at all (buffs/summons):', ok.filter(r => r.acts === 0).length);
console.log('sources found vs damage acts declared:', ok.reduce((s,r)=>s+r.sources,0), 'vs', ok.reduce((s,r)=>s+r.acts,0));

console.log('\n=== spells whose damage acts were NOT all turned into sources ===');
const missed = ok.filter(r => r.sources < r.acts && r.petBasicOf === undefined).sort((a,b)=>(b.acts-b.sources)-(a.acts-a.sources));
const gatedOff = missed.filter(r => r.blockedActs > 0);
console.log('count:', missed.length, '| of those, branches gated off rather than unmodelled:', gatedOff.length);
for (const r of missed.slice(0, 40)) {
  const why = r.blocked.length > 0 ? ` blocked=[${r.blocked.join(',')}]` : '';
  console.log(`  ${r.id.padEnd(28)} acts ${r.acts} -> sources ${r.sources}${why} unreachable=[${r.unreachable.join(',')}] unmodelled=[${r.unmodelled.join(',')}]`);
}

console.log('\n=== spells with every branch gated off (they need an effect this build cannot produce) ===');
const dark = ok.filter(r => r.sources === 0 && r.acts > 0 && r.blockedActs > 0);
console.log('count:', dark.length);
for (const r of dark.slice(0, 30)) console.log(`  ${r.id.padEnd(28)} needs ${r.blocked.join(', ')}`);

console.log('\n=== procs that fire while casting each skill ===');
const withProcs = ok.filter(r => r.procs > 0).sort((a,b)=>b.procDps-a.procDps);
console.log('count:', withProcs.length);
for (const r of withProcs.slice(0, 20)) console.log(`  ${r.id.padEnd(28)} ${r.procs} proc(s), ${Math.round(r.procDps).toLocaleString('en-US')} dps`);

console.log('\n=== unmodelled act types (inside reached groups) ===');
for (const [k, v] of sort(unmodelledActs)) console.log(String(v).padStart(5), k);

console.log('\n=== coverage methods across all sources ===');
for (const [k, v] of sort(coverageMethods)) console.log(String(v).padStart(5), k);

console.log('\n=== carrier kinds across all sources ===');
for (const [k, v] of sort(carrierKinds)) console.log(String(v).padStart(5), k);

console.log('\n=== trigger kinds across all sources ===');
for (const [k, v] of sort(triggerKinds)) console.log(String(v).padStart(5), k);

console.log('\n=== spells where every source lands 0 at the default placement ===');
const dead = ok.filter(r => r.sources > 0 && r.zeroCoverage === r.sources);
console.log('count:', dead.length, '| out of reach rather than unmodelled:', dead.filter(r => r.reach !== undefined).length);
for (const r of dead.slice(0, 40)) {
  console.log(`  ${r.id.padEnd(28)} reach=${r.reach === undefined ? 'never' : r.reach.toFixed(1)}  tags=${r.tags.join(',')}`);
}

console.log('\n=== spells using "assumed" coverage (homing) ===');
for (const r of ok.filter(r => r.methods.includes('assumed'))) console.log('  ', r.id);

console.log('\n=== spells that require an exile effect before they do anything ===');
const gated = ok.filter(r => r.requires.length > 0);
console.log('count:', gated.length);
for (const r of gated) console.log(`  ${r.id.padEnd(28)} needs ${r.requires.join(',')}  tags=${r.tags.filter(t=>['finisher','extender','channel'].includes(t)).join(',')}`);

console.log('\n=== off-global-cooldown spells (cast_speed_ticks <= 0) ===');
const off = ok.filter(r => r.offGcd);
console.log('count:', off.length);
for (const r of off.slice(0, 25)) console.log(`  ${r.id.padEnd(28)} cd=${r.cycle.toFixed(2)}s acts=${r.acts}`);

console.log('\n=== summon spells (output not modelled) ===');
const summons = ok.filter(r => r.summonType && r.summonType !== 'NONE');
console.log('count:', summons.length);
for (const r of summons) console.log(`  ${r.id.padEnd(28)} summonType=${r.summonType} sources=${r.sources}`);

console.log('\n=== channel spells ===');
for (const r of ok.filter(r => r.channel)) console.log(`  ${r.id.padEnd(28)} cycle=${r.cycle.toFixed(2)}s sources=${r.sources}`);

console.log('\n=== top 25 by DPS on the reference build (sanity: outliers are suspects) ===');
for (const r of [...ok].sort((a,b)=>b.dps-a.dps).slice(0,25)) {
  console.log(`  ${r.id.padEnd(28)} ${Math.round(r.dps).toLocaleString('en-US').padStart(12)}  cycle ${r.cycle.toFixed(2)}s  proj ${String(r.projectiles).padStart(3)}  overlap ${r.overlap}  ${r.methods.join('/')}`);
}

const out = path.join(root, 'census.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
console.log();
console.log('full rows written to', out, '(git-ignored)');
