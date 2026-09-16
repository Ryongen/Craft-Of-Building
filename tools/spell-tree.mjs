/**
 * One spell's act tree, with the noise stripped.
 *
 *   node tools/spell-tree.mjs <spell id> [<spell id> ...]
 *
 * Prints every component part that does something — its `ifs`, its target selector, its acts and
 * its `per_entity_hit` sub-parts — and drops the particles, sounds and rendering fields, which
 * are most of the bytes and none of the behaviour. This is what step 1 of `SKILL-MODELLING.md`
 * asks you to read by hand before you let the engine tell you what a spell does.
 *
 * `PEH:` lines are `per_entity_hit`: acts that run once per entity the part above selected, in a
 * `PositionSource.TARGET` context. They are easy to miss in the raw JSON and they are where five
 * of the pack's component groups are reached from.
 */
import fs from 'fs';
const s = JSON.parse(fs.readFileSync('data/snapshot.json','utf8'));
const NOISE = new Set(['particles_in_radius','sound','sound_per_target','sword_sweep_particles','aggro','caster_command']);
const brief = (a) => {
  const m = a.map || {};
  const bits = Object.entries(m).filter(([k]) => !['item','proj_en','block','particle_type','particle_count','motion','sound','pitch','volume','en_predicate','selection_type'].includes(k))
    .map(([k,v]) => `${k}=${v}`).join(' ');
  return a.type + (bits ? ' {' + bits + '}' : '');
};
for (const id of process.argv.slice(2)) {
  const d = s.registries['mmorpg_spells'][id]?.data;
  if (!d) { console.log(id, 'MISSING'); continue; }
  console.log('=== ' + id, JSON.stringify({cast_speed_ticks:d.config.cast_speed_ticks, cooldown:d.config.cooldown_ticks, cast_time:d.config.cast_time_ticks, times:d.config.times_to_cast, tags:d.config.tags.tags.join(',')}));
  const groups = { on_cast: d.attached.on_cast || [], ...(d.attached.entity_components || {}) };
  for (const [g, parts] of Object.entries(groups)) {
    for (const [i, p] of (parts||[]).entries()) {
      const acts = (p.acts||[]).filter(a=>!NOISE.has(a.type));
      const peh = (p.per_entity_hit||[]).flatMap(ip=>(ip.acts||[]).filter(a=>!NOISE.has(a.type)));
      if (!acts.length && !peh.length) continue;
      console.log(` ${g}#${i}`);
      console.log(`   if: ${(p.ifs||[]).map(brief).join(' | ')||'-'}`);
      console.log(`   tgt: ${(p.targets||[]).map(brief).join(' | ')||'-'}`);
      for (const a of acts) console.log(`   act: ${brief(a)}`);
      for (const a of peh) console.log(`   PEH: ${brief(a)}`);
    }
  }
}
