#!/usr/bin/env node
/**
 * What the engine has *not* ported yet, read straight off the mod source and the pack.
 *
 *   npm run build && node tools/audit-port-coverage.mjs \
 *     --src "/g/Projects/Mine-And-Slash-Rework-1.20-Forge" --snapshot data/snapshot.json
 *
 * ## Why this exists
 *
 * Until this file, a hole in the port was found by *playing the game* — noticing a damage number
 * looked wrong, screenshotting the combat log, and working backwards. That loop only finds holes
 * on the character you happen to be playing, it needs a fresh capture per suspicion, and it is
 * silent about every stat your build does not happen to carry. Nobody can make a character that
 * uses all 1,153 stats and all 432 spells, so most of the port was never checked at all.
 *
 * None of that is necessary. The mod's source says which stats carry behaviour, the pack says
 * which serializers and which spell fields it actually uses, and the engine's own tables say what
 * it implements. Every hole found on 2026-09-15 — the whole `flat_damage` family, `spell_damage`,
 * `en_preds`, `phys_to_chaos` — is a set difference between those, computable in under a second
 * with the game closed.
 *
 * `tools/port-code-only-stats.mjs` already does this for stat *shapes* and fails rather than emit
 * a partial table. This is the same idea for *behaviour*, which is the half that was unguarded.
 *
 * ## What it checks
 *
 *   1. every code-only stat whose Java declares a `statEffect` that nothing in the engine runs;
 *   2. every `mmorpg_stat_condition` serializer with no branch in `conditions.ts`;
 *   3. every `mmorpg_stat_effect` serializer with no branch in `effects.ts`;
 *   4. every key of a spell's `attached` parts, and every `en_preds` and `ifs` type, that nothing reads;
 *   5. every field of a spell's `config` block that nothing reads;
 *   6. every registry category in the snapshot that nothing in the engine or schema mentions;
 *   7. every stat a fixture's character actually carries that the sheet taxonomy has no section
 *      for, so an A-Z dump cannot creep back in as the pack adds stats.
 *
 * Checks 1-7 ask whether the **engine** reads what the snapshot contains. Checks 8-10 ask the
 * other question, which nothing used to ask at all:
 *
 *   8. every registry type the mod family's Java declares, against what the snapshot holds;
 *   9. every namespace directory in the install, against what the extractor opened.
 *
 * That half exists because its absence hid a real bug for the whole life of this repo. The
 * extractor hardcoded `data/mmorpg/` and silently dropped 604 files across four sibling-mod
 * namespaces and three OpenLoader packs — and checks 1-7 could not see it, because every one
 * of them iterates the snapshot. A namespace nobody opened is not in the snapshot to be
 * iterated. Only reading the install itself closes that loop.
 *
 * ## Accounting, not suppression
 *
 * A finding is only silenced by an entry in `ACCOUNTED` that says *why*, and the reasons are of
 * exactly four kinds: handled somewhere the audit cannot see, dead in the game itself, outside
 * what a build planner models at all, or a known gap with a note. Anything else is printed and
 * exits non-zero, so a mod or pack update that introduces a new behaviour breaks this loudly
 * instead of quietly reading as zero.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Why a hole is not a finding. Each key is a stat id, a serializer, or a `prefix*` glob.
 *
 * `kind` is the thing being claimed, and it is worth keeping the three apart when reading the
 * output: `elsewhere` means the engine does implement it, just not through the in-code effect
 * table; `dead` means the *game* does nothing with it and the engine matching that is correct;
 * `scope` means it is real and deliberately out of the planner's remit — crafting, worldgen,
 * professions, loot; `gap` means it really is missing from something the planner does claim to
 * model, and is tracked rather than fixed.
 */
const ACCOUNTED = {
  // --- implemented, but outside the in-code effect table -----------------------------
  "bleed_chance": ["elsewhere", "ailments.ts reads `<ailment>_chance` directly"],
  "burn_chance": ["elsewhere", "ailments.ts reads `<ailment>_chance` directly"],
  "electrify_chance": ["elsewhere", "ailments.ts reads `<ailment>_chance` directly"],
  "freeze_chance": ["elsewhere", "ailments.ts reads `<ailment>_chance` directly"],
  "poison_chance": ["elsewhere", "ailments.ts reads `<ailment>_chance` directly"],
  // These six used to be one gap seen from two angles. `AilmentChance.activate` raises a second
  // `DamageEvent` carrying `EventData.AILMENT`, `simulate.ts` now runs it, and both stats are in
  // the in-code table gated on that field — so they are implemented rather than accounted for.
  "blood_user": ["elsewhere", "resources.ts — rewrites which pool a cost comes out of"],
  "hp_resto_to_blood": ["elsewhere", "resources.ts — the only thing that fills blood"],

  // `ElementalStat.transferStats` hands an `Elemental` variant to `getAllSingleElemental()` and
  // clears itself, so these never reach a damage event under their own id. `CODE_ONLY_TRANSFERS`
  // reproduces it, which is also why a fixture showing a non-zero `elemental_resist` would be a bug.
  "*_elemental": ["elsewhere", "`ElementalStat.transferStats` splits it into the three singles"],
  "elemental_resist": ["elsewhere", "`ElementalStat.transferStats` splits it into the three singles"],
  "elemental_penetration": ["elsewhere", "`ElementalStat.transferStats` splits it into the three singles"],

  // --- dead in the game, so matching it is correct -----------------------------------
  //
  // `transferStats` only moves the `Elemental` variant; `ALL` is never transferred. And both
  // effects gate on `effect.GetElement().equals(stat.getElement())` — strict equality, no
  // `elementsMatch` — so a stat whose element is `ALL` can never match a real hit. Two perks
  // grant each of these and neither does anything in game.
  "all_resist": ["dead", "strict element equality + no ALL transfer: cannot match any hit"],
  "all_penetration": ["dead", "strict element equality + no ALL transfer: cannot match any hit"],

  // --- known gaps, tracked ------------------------------------------------------------
  "summon_health": ["gap", "a pet's hit points; the planner models what pets deal, not how long they live"],
  "spell_dodge": ["gap", "defence.ts models dodge and block, not spell dodge"],
  "bleed_receive_chance": ["gap", "target-side ailment chance; 4 exile effects use it"],
  "burn_receive_chance": ["gap", "target-side ailment chance"],
  "electrify_receive_chance": ["gap", "target-side ailment chance"],
  "freeze_receive_chance": ["gap", "target-side ailment chance"],
  "poison_receive_chance": ["gap", "target-side ailment chance"],
  "*_proc_chance": ["gap", "Shatter/Shock proc rate; nothing in this pack grants one"],
  "phys_to_all": ["gap", "converts to an `ALL`-element event; 2 perks"],
  "plus_phys_to_all": ["gap", "definition only in this pack"],
  "phys_taken_as_all": ["gap", "definition only in this pack"],
  "phys_to_random": ["gap", "a random target element is an average, not a copy; definition only"],
  "phys_taken_as_random": ["gap", "a random target element is an average, not a copy; definition only"],
  "dmg_taken_to_mana": ["gap", "definition only in this pack"],
  "magic_shield_heal": ["gap", "2 perks"],
  "learn_boss_cc_resist": ["dead", "a `learn_` marker, not a damage effect"],
  "heal_cleanse": ["gap", "not a damage or defence stat"],
  "more_food_stats": ["gap", "not a damage or defence stat"],
  "is_dual_wielding": ["gap", "the document has no offhand-weapon field to answer it from"],
  // Read as a `SourceRequirement` of kind `potion` in `damage/skill-model.ts`. A vanilla potion
  // is world state, so it is assumed absent and answerable through
  // `config.conditions["caster_has_potion:<id>"]`. Reading it is what keeps `execute`'s two
  // mutually exclusive damage acts from both being counted — unread, one press reported three
  // times the hit the game deals.
  "caster_has_potion": ["elsewhere", "a `potion` gate in skill-model.ts, assumed absent"],
  // Unread, and true is the right answer anyway — the same reasoning as the stat condition of
  // this name: the cooldown it guards is a *rate* ceiling, which `procs.ts` already applies.
  // Reading it would change nothing today; it is listed so that stops being an accident.
  "is_not_on_cd": ["gap", "unread en_pred, but an unread gate passes, which is the right answer"],

  // --- spell config fields --------------------------------------------------------------
  "summonType": ["gap", "the summon family — the largest unmodelled area"],
  "tracks": ["gap", "homing is `assumed to reach the target`; this is the field that would answer it"],
  "tracking_radius": ["gap", "homing is `assumed`; this is the steering radius"],
  "castingWeapon": ["gap", "a skill's required weapon type; nothing checks you can cast it"],
  "imbues": ["gap", "the imbue mechanic is unmodelled"],
  "charge_name": ["scope", "the display name of a charge; `charges` and `charge_regen` are read"],
  "slows_when_casting": ["scope", "movement while casting, not damage"],
  "swing_arm": ["scope", "animation"],
  "channel_skill": ["elsewhere", "read as `SpellConfig.isChannel` — the pulse gate"],

  // --- whole registries -------------------------------------------------------------------
  //
  // A build planner models a character, not a world. Crafting, professions, loot, worldgen and
  // the dimension tables are all real content that changes nothing about what a build does.
  "recipes": ["scope", "crafting"],
  // The same vanilla datapack directories, qualified because they sit under a sibling mod's
  // namespace rather than `mmorpg` — `library_of_exile:loot_tables`, `dungeon_realm:recipes`.
  // A loot table is a loot table whoever ships it, so these are scoped by shape rather than by
  // owner, and the list names only directories vanilla itself defines. A sibling mod inventing
  // a registry directory of its own still lands in findings.
  "*:recipes": ["scope", "crafting"],
  "*:loot_tables": ["scope", "loot"],
  "*:tags": ["scope", "vanilla tags"],
  "*:worldgen": ["scope", "worldgen"],
  "*:structures": ["scope", "worldgen"],
  "*:advancements": ["scope", "advancements"],
  "*:functions": ["scope", "datapack functions"],
  "loot_tables": ["scope", "loot"],
  "worldgen": ["scope", "worldgen"],
  "curios": ["scope", "the Curios slot registry, not a stat source"],
  "damage_type": ["scope", "vanilla damage type registry"],
  "dimension": ["scope", "worldgen"],
  "dimension_type": ["scope", "worldgen"],
  "mmorpg_dimension": ["scope", "worldgen"],
  "mmorpg_profession": ["scope", "professions"],
  "mmorpg_profession_recipe": ["scope", "professions"],
  "mmorpg_auto_item": ["scope", "crafting"],
  "mmorpg_custom_item": ["scope", "crafting"],
  "mmorpg_orb_extension": ["scope", "crafting currency"],
  "mmorpg_chaos_stat": ["scope", "item ascension tiers — crafting, not a stat on a build"],
  "mmorpg_wizard": ["scope", "an NPC"],
  "mmorpg_atlas_layout": ["scope", "the atlas map layout, not the atlas passives"],
  "mmorpg_map_mob_list - obsolete": ["scope", "named obsolete by the pack itself"],
  "mmorph_shrine_buff": ["scope", "a one-entry typo of mmorpg_shrine_buff"],
  "mmorpg_shrine_buff": ["scope", "a temporary world pickup, not a property of a build"],

  // --- the sibling mods, newly extracted ---------------------------------------------
  // Mine and Slash ships with Library of Exile, Dungeon Realm, Ancient Obelisks and The
  // Harvest, each registering Exile registries under its own namespace. The extractor read
  // only `data/mmorpg/` until now, so none of these had ever been seen; they are classified
  // here from their own data rather than from their names.
  //
  // Relics were the one that looked build-side and is not. A relic is equipped
  // (`library_of_exile_relic_type.max_equipped: 1`), but every one of the 20
  // `library_of_exile_relic_stat` entries is a loot or map-content bonus — `bonus_currency`,
  // `bonus_gear`, `bonus_map`, `prophecy_content`, `guarantee_shrine_content`. None of them
  // reaches a character's stat sheet, so a relic changes what drops, not what you hit for.
  "library_of_exile_relic_stat": ["scope", "20 stats, all loot/map-content bonuses — a relic changes drops, not a sheet"],
  "library_of_exile_relic_affix": ["scope", "49 affixes over the relic stats above"],
  "library_of_exile_relic_type": ["scope", "3 relic items, one per sibling mod"],
  "library_of_exile_relic_rarity": ["scope", "rarity bands for relics"],
  "library_of_exile_currency": ["scope", "crafting currency — same remit as mmorpg_orb_extension"],
  "library_of_exile_orb_edit": ["scope", "what an orb does to an item — crafting"],
  "library_of_exile_item_modification": ["scope", "how currency rewrites an item — crafting"],
  "library_of_exile_item_requirement": ["scope", "what an item must be for a modification to apply — crafting"],
  "library_of_exile_map_content": ["scope", "what a map can contain"],
  "library_of_exile_map_finish_rar": ["scope", "reward rarity for finishing a map"],
  "library_of_exile_mob_list": ["scope", "which mobs a map spawns — the map side, as mmorpg_map_affix is"],
  "dungeon_realm_dungeon": ["scope", "dungeons"],
  "dungeon_realm_atlas_node": ["scope", "the atlas graph, as mmorpg_atlas_layout is"],
  "dungeon_realm_boss_arena": ["scope", "an arena structure"],
  "dungeon_realm_uber_boss": ["scope", "a boss encounter"],
  "ancient_obelisks_obelisk": ["scope", "a world structure"],
  "the_harvest_harvest_arena": ["scope", "an arena structure"],

  // Declared by the Java as datapack-loadable, but shipping no JSON at all — the registry
  // equivalent of a code-only stat. Verified against both the jar and every OpenLoader pack:
  // there is no directory for either, so there is nothing an extractor could read. The jar's
  // own dev-helper list is what says the defaults exist.
  "library_of_exile_map_data_block": ["scope", "code-only; 19 map structure blocks (boss, chest, spawner) — map furniture"],
  "library_of_exile_mob_affix": ["gap", "code-only; 7 map-side mob affixes (fast_mobs, high_health) — same feature as mmorpg_mob_affix"],

  // --- spell `ifs` gates ---------------------------------------------------------------
  // Added with the check itself. An unread gate is the quiet kind of wrong: it does not throw,
  // it reads as true, and the part behind it simply happens more often than the game allows.
  "on_spell_cast": [
    "elsewhere",
    "`triggerOf` reads it by its absence — a part with no tick, expire or hit gate is an on-cast part",
  ],
  "is_first_cast": ["elsewhere", "`onceForTheRun` divides the source by `times_to_cast`"],
  "is_last_cast": ["elsewhere", "`onceForTheRun` divides the source by `times_to_cast`"],
  "is_en_in_radius": [
    "gap",
    "22 parts on 14 trap spells arm only with an enemy within radius × AREA_MULTI of the carrier; benign today because every one of those carriers is thrown and lands on the target, so the gate is satisfied wherever the target stands",
  ],

  // The five that are not out of scope, in the order they are worth doing.
  // Ported in `collect/item-sets.ts` against `StatCalculation.addItemSetStats`, which is in the
  // 6.4.13 jar and not only in the fork. Membership, the duplicate dedupe, the cumulative
  // tiers and the average-item-level scaling are each pinned in `collect/item-sets.test.ts`.
  "mmorpg_sets": ["elsewhere", "collect/item-sets.ts — ITEM_SET contexts off the equipped uniques"],
  "mmorpg_entity": ["gap", "190 mob definitions; would make a target a real mob, not rarity maths"],
  // Ported in `damage/mob-affixes.ts` against `MobAffix.getStatAndContext`: fixed at 100%,
  // scaled to the mob's level, folded into the enemy sheet in the same accumulator as your
  // debuffs. Named on the build as `config.enemy.affixes`, the shape the Training Dummy mod
  // uses — ids rather than numbers, so a planner figure and a dummy figure ask one question.
  "mmorpg_mob_affix": ["elsewhere", "damage/mob-affixes.ts — `config.enemy.affixes` on the target"],
  "mmorpg_map_affix": ["gap", "77 map modifiers, most of which buff the mobs you are measuring against"],
  "mmorpg_prophecy_modifier": ["gap", "64 more map-side modifiers"],
  "mmorpg_weapon_type": ["gap", "13 weapon types; pairs with `castingWeapon`"],
  "mmorpg_mercenary": ["gap", "a whole companion feature"],
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? ".");
  const snapshot = JSON.parse(readFileSync(resolve(args.snapshot), "utf8"));

  const findings = [];
  const accounted = [];
  // A check may offer a `fallback` reason it worked out for itself — `unreadRegistries` knows
  // from the extractor's own inventory whose datapack a category came from. An explicit
  // ACCOUNTED entry still wins, so a hand-written reason is never silently overridden.
  const record = (check, id, detail, fallback) => {
    const reason = reasonFor(id) ?? fallback;
    (reason ? accounted : findings).push({ check, id, detail, reason });
  };

  statEffects(root, args.src, snapshot, record);
  serializers(root, snapshot, record);
  spellFields(root, snapshot, record);
  spellConfig(root, snapshot, record);
  unreadRegistries(root, snapshot, record);
  sheetTaxonomy(root, snapshot, record);
  declaredRegistries(args.src, snapshot, record);
  namespaceCoverage(args.install ?? snapshot.meta?.gameDir, snapshot, record);

  report(findings, accounted);
  process.exitCode = findings.length > 0 ? 1 : 0;
}

/**
 * Check 1 — a code-only stat whose Java declares a `statEffect`, that neither the in-code effect
 * table nor a datapack `effect` block runs.
 *
 * The join is free: `code-only-stats.generated.ts` already carries the Java path of every stat it
 * claims, as the trailing comment on each row. So "which class is this stat" is answered by the
 * table the port tool wrote, and this only has to ask whether that class sets a `statEffect`.
 */
function statEffects(root, src, snapshot, record) {
  const generated = readFileSync(join(root, "packages/engine/src/code-only-stats.generated.ts"), "utf8");
  const rows = [...generated.matchAll(/"([^"]+)":\s*\{[^}]*\},\s*\/\/\s*(\S+\.java)/g)];
  if (rows.length === 0) fail("code-only-stats.generated.ts has no `// <path>.java` comments to join on");

  const inCode = new Set(globalThis.__IN_CODE__ ?? []);
  const datapack = new Set(
    Object.entries(snapshot.registries["mmorpg_stat"] ?? {})
      .filter(([, e]) => (e.data?.effect ?? []).length > 0)
      .map(([id]) => id),
  );

  const cache = new Map();
  for (const [, statId, rel] of rows) {
    if (inCode.has(statId) || datapack.has(statId)) continue;
    const path = join(src, "src/main/java", rel);
    if (!cache.has(path)) cache.set(path, existsSync(path) ? readFileSync(path, "utf8") : "");
    const java = cache.get(path);
    if (java === "") continue;
    if (!/statEffect\s*=\s*new/.test(java)) continue;
    record("stat effect", statId, `${rel.split("/").pop()} declares one; ${usage(snapshot, statId)}`);
  }
}

/** Checks 2 and 3 — a serializer the pack uses that the interpreter has no branch for. */
function serializers(root, snapshot, record) {
  const pairs = [
    ["mmorpg_stat_condition", "packages/engine/src/damage/conditions.ts", "condition"],
    ["mmorpg_stat_effect", "packages/engine/src/damage/effects.ts", "stat effect"],
  ];
  for (const [category, file, label] of pairs) {
    const handled = new Set(
      [...readFileSync(join(root, file), "utf8").matchAll(/case "([a-z0-9_]+)"/g)].map((m) => m[1]),
    );
    const counts = new Map();
    for (const e of Object.values(snapshot.registries[category] ?? {})) {
      const ser = e.data?.ser;
      if (ser) counts.set(ser, (counts.get(ser) ?? 0) + 1);
    }
    for (const [ser, n] of counts) {
      if (handled.has(ser)) continue;
      record(`${label} serializer`, ser, `${n} entr${n === 1 ? "y" : "ies"}, no branch in ${file.split("/").pop()}`);
    }
  }
}

/**
 * Check 4 — a field of a spell's `attached` parts that nothing reads.
 *
 * This is the check that would have caught `en_preds`: the key is all over the pack's spell JSON
 * and the string `"en_preds"` appeared nowhere in the engine, which is as clear a signal as a
 * missing serializer and was never being looked for.
 */
function spellFields(root, snapshot, record) {
  const reader =
    readFileSync(join(root, "packages/engine/src/damage/skill-model.ts"), "utf8") +
    readFileSync(join(root, "packages/engine/src/damage/geometry.ts"), "utf8");

  const partKeys = new Map();
  const predTypes = new Map();
  const ifTypes = new Map();
  const bump = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1);
  const walk = (parts) => {
    for (const part of parts ?? []) {
      for (const key of Object.keys(part)) bump(partKeys, key);
      for (const pred of part.en_preds ?? []) bump(predTypes, pred.type);
      for (const gate of part.ifs ?? []) bump(ifTypes, gate.type);
      walk(part.per_entity_hit);
    }
  };
  for (const e of Object.values(snapshot.registries["mmorpg_spells"] ?? {})) {
    const attached = e.data?.attached ?? {};
    walk(attached.on_cast);
    for (const group of Object.values(attached.entity_components ?? {})) walk(group);
  }

  for (const [key, n] of partKeys) {
    if (reader.includes(`"${key}"`)) continue;
    record("spell part field", key, `used by ${n} part(s), never read`);
  }
  for (const [type, n] of predTypes) {
    if (reader.includes(`"${type}"`)) continue;
    record("en_pred type", type, `${n} use(s), never read`);
  }
  // `ifs` decides *whether* a part runs at all, and was the one half of a component part this
  // check did not cover — so `is_en_in_radius` sat on 22 parts across 14 spells, read by
  // nothing, with the audit green. An unread gate does not fail loudly: it reads as true.
  for (const [type, n] of ifTypes) {
    if (reader.includes(`"${type}"`)) continue;
    record("spell ifs type", type, `${n} use(s), never read — an unread gate reads as always true`);
  }
}

/**
 * Check 5 — a `SpellConfiguration` field nothing reads.
 *
 * Every spell carries all 26, so the count is never the signal; the name is. This is where the
 * the tracking pair (`tracks`, `tracking_radius`) shows up, and it is load-bearing for damage.
 * The summon family used to sit beside it and no longer does: `summons.ts` reads `summon_basic_atk`,
 * `summon_spells`, `summon_spell_chance` and `summon_spell_cd_ticks`, so this check now passes them
 * without an entry — which is the point of driving it off the source rather than off a list.
 */
function spellConfig(root, snapshot, record) {
  const reader = engineAndSchema(root);
  const fields = new Map();
  for (const e of Object.values(snapshot.registries["mmorpg_spells"] ?? {})) {
    for (const key of Object.keys(e.data?.config ?? {})) fields.set(key, (fields.get(key) ?? 0) + 1);
  }
  for (const [key, n] of fields) {
    if (reader.includes(`"${key}"`)) continue;
    record("spell config field", key, `on ${n} spell(s), never read`);
  }
}

/**
 * Check 6 — a whole registry category nothing mentions.
 *
 * The coarsest check and the one that finds whole mechanics rather than fields. `mmorpg_sets`
 * turned up here: ten gear sets over 31 unique items, granting stats at two pieces, and no
 * capture could ever have revealed it because neither captured character wears one.
 */
/**
 * The namespaces Mine and Slash's own mod family registers under.
 *
 * A registry under any other namespace is a third-party mod's datapack. The extractor reads
 * those so that a pack update cannot hide anything, and the engine will never read them, so
 * they are accounted for as a class rather than as 166 hand-written lines about other mods'
 * loot tables.
 *
 * Keeping this set short is the whole point. The day a pack ships an Exile registry under a
 * namespace not named here, it lands in `findings` and this exits non-zero, instead of being
 * scoped away with the recipe files.
 */
const MOD_FAMILY_NAMESPACES = new Set([
  "mmorpg",
  "library_of_exile",
  "dungeon_realm",
  "ancient_obelisks",
  "the_harvest",
]);

function unreadRegistries(root, snapshot, record) {
  const reader = engineAndSchema(root);
  const foreign = foreignCategories(snapshot);

  for (const [category, entries] of Object.entries(snapshot.registries)) {
    if (reader.includes(`"${category}"`)) continue;
    const detail = `${Object.keys(entries).length} entries, nothing reads it`;
    const owners = foreign.get(category);
    record(
      "registry",
      category,
      detail,
      owners &&
        ["scope", `a datapack belonging to ${owners.join(", ")}, not a Mine and Slash registry`],
    );
  }
}

/**
 * Category key -> the namespaces that produced it, for keys produced *only* from outside the
 * mod family.
 *
 * Read off `diagnostics.namespaces`, the extractor's own inventory of what it opened, so the
 * question "whose data is this" is answered by the extraction rather than by parsing the key.
 * A category any family namespace also wrote is left out, so it still needs an explicit entry.
 *
 * A snapshot predating the inventory yields an empty map and every category is then held to an
 * explicit entry — the safe direction to fail in.
 */
function foreignCategories(snapshot) {
  const claims = new Map();
  for (const ns of snapshot.diagnostics?.namespaces ?? []) {
    for (const category of ns.categories) {
      let set = claims.get(category.key);
      if (!set) {
        set = new Set();
        claims.set(category.key, set);
      }
      set.add(ns.namespace);
    }
  }

  const foreign = new Map();
  for (const [key, namespaces] of claims) {
    const outside = [...namespaces].filter((n) => !MOD_FAMILY_NAMESPACES.has(n));
    if (outside.length === namespaces.size) foreign.set(key, outside.sort());
  }
  return foreign;
}

/** Every non-test source file of both packages, concatenated, for a "does anything name this". */
let SOURCES;
function engineAndSchema(root) {
  if (SOURCES !== undefined) return SOURCES;
  const parts = [];
  for (const pkg of ["engine", "schema"]) {
    const dir = join(root, "packages", pkg, "src");
    for (const file of readdirSync(dir, { recursive: true })) {
      const name = String(file);
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      parts.push(readFileSync(join(dir, name), "utf8"));
    }
  }
  // Joined with a space rather than a newline: this is only ever substring-searched, and the
  // separator just has to stop the last line of one file running into the first of the next.
  SOURCES = parts.join(" ");
  return SOURCES;
}

/** How much of the pack actually grants a stat, ignoring its own definition. */
function usage(snapshot, statId) {
  const needle = `"${statId}"`;
  let total = 0;
  for (const [category, entries] of Object.entries(snapshot.registries)) {
    if (category === "mmorpg_stat") continue;
    for (const e of Object.values(entries)) {
      if (JSON.stringify(e.data ?? {}).includes(needle)) total += 1;
    }
  }
  return total === 0 ? "definition only" : `${total} pack reference(s)`;
}

function reasonFor(id) {
  if (ACCOUNTED[id]) return ACCOUNTED[id];
  for (const [pattern, reason] of Object.entries(ACCOUNTED)) {
    if (!pattern.includes("*")) continue;
    const [head, tail] = pattern.split("*");
    if (id.startsWith(head) && id.endsWith(tail)) return reason;
  }
  return undefined;
}

function report(findings, accounted) {
  const byKind = (kind) => accounted.filter((a) => a.reason[0] === kind).length;
  console.log(
    `accounted  ${accounted.length}  (${byKind("elsewhere")} handled elsewhere, ` +
      `${byKind("dead")} dead in game, ${byKind("scope")} out of scope, ${byKind("gap")} known gaps)`,
  );

  const gaps = accounted.filter((a) => a.reason[0] === "gap");
  if (gaps.length > 0) {
    console.log("\nknown gaps, tracked rather than fixed:");
    for (const g of gaps.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`  ${g.id.padEnd(28)} ${g.reason[1]}`);
    }
  }

  console.log(`\nunaccounted  ${findings.length}`);
  if (findings.length === 0) {
    console.log("  none — every behaviour the source and the pack declare is either implemented");
    console.log("  or has a reason in ACCOUNTED.");
    return;
  }
  for (const f of findings.sort((a, b) => a.check.localeCompare(b.check) || a.id.localeCompare(b.id))) {
    console.log(`  [${f.check}] ${f.id}`);
    console.log(`      ${f.detail}`);
  }
  console.log("\nEach is either a behaviour to port or an entry to add to ACCOUNTED with a reason.");
}

/**
 * Check 7 — a stat a real character carries that the sheet taxonomy does not place.
 *
 * The taxonomy in `display.ts` is authored, which is the only way to get a readable sheet out of
 * a pack that files 727 of its 832 stats under `Misc` or under nothing. The cost of authoring it
 * is that it goes stale: a pack update adds a stat, the stat falls through every explicit list
 * and every pattern, and it lands in Uncategorised at the bottom of the sheet where nobody looks.
 * That failure is silent, which is exactly the shape of failure this file exists to end.
 *
 * So the check is driven by the fixtures rather than by the whole registry. Placing all 832
 * stats would be busywork against stats no character has; placing the 223 a real build carries
 * is the part that shows on screen. A fixture is the evidence that somebody really has this
 * stat.
 */
function sheetTaxonomy(root, snapshot, record) {
  const dist = join(root, "packages/schema/dist/index.js");
  const engineDist = join(root, "packages/engine/dist/index.js");
  if (!existsSync(dist) || !existsSync(engineDist)) {
    fail("packages/*/dist is missing — run `npm run build` first");
  }
  const schema = globalThis.__SCHEMA__;
  const engine = globalThis.__ENGINE__;
  if (!schema || !engine) return;

  const fixtures = join(root, "fixtures");
  if (!existsSync(fixtures)) return;

  const carried = new Map();
  for (const file of fixtureFiles(fixtures)) {
    let build;
    try {
      build = JSON.parse(readFileSync(file, "utf8")).build;
    } catch {
      continue;
    }
    if (!build) continue;
    let stats;
    try {
      stats = engine.calculate(build, snapshot, {}).stats;
    } catch {
      // A fixture the engine cannot compute is a different failure, and the fixture runner is
      // where it gets reported. Not placing its stats is the right thing to do here.
      continue;
    }
    for (const [id, stat] of stats) {
      // A stat sitting at its default is not on anyone's sheet, so it is not evidence that the
      // taxonomy needs a section for it.
      if (stat.value === 0 && stat.dmgMulti === 1) continue;
      if (!schema.statDisplay(snapshot, id).showInGui) continue;
      if (!carried.has(id)) carried.set(id, file);
    }
  }

  for (const [id, file] of carried) {
    if (schema.sheetGroupOf(snapshot, id) !== schema.UNCATEGORISED) continue;
    record(
      "sheet-taxonomy",
      id,
      `carried by ${basename(file)} and no section of SHEET_GROUPS claims it, so it renders ` +
        `under "Uncategorised" at the bottom of the sheet. Add it to a group's \`stats\` list in ` +
        `packages/schema/src/display.ts, or widen a \`patterns\` entry if it belongs to a family.`,
    );
  }
}

/** Every fixture file under a directory, recursively. `fixtures/local` is git-ignored but real. */
function fixtureFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...fixtureFiles(full));
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".raw.json")) out.push(full);
  }
  return out;
}

function parseArgs(argv) {
  const out = { snapshot: "data/snapshot.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = winPath(argv[i + 1]);
    i += 1;
  }
  if (!out.src) fail("pass --src <Mine and Slash checkout>");

  // A check that cannot read its input must not read as a pass. Check 1 joins paths onto
  // `--src` and skips a file it cannot open, so an unreadable checkout made it report nothing
  // at all — and `unaccounted 0` looked like success. It was being given an MSYS-style
  // `/g/Projects/...` from the npm script, which node on Windows does not resolve; `winPath`
  // now translates that, and this refuses to run rather than pass vacuously if it still fails.
  if (!isDir(out.src)) {
    fail(
      `--src ${out.src} is not a readable directory. Checks 1 and 8 read the Java there, and ` +
        `silently skipping it would report a clean audit that checked nothing.`,
    );
  }
  return out;
}

/**
 * `/g/Projects/x` -> `G:/Projects/x`.
 *
 * Git Bash hands node an MSYS path when a script is written for a POSIX shell, and node on
 * Windows resolves it against the current drive instead of failing — so it becomes a path that
 * does not exist rather than an error anyone sees.
 */
function winPath(value) {
  if (typeof value !== "string") return value;
  const m = /^\/([A-Za-z])\/(.*)$/.exec(value);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : value;
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// The extraction half — checks 8-10, which read the install rather than the snapshot.
// ---------------------------------------------------------------------------------------

/**
 * Check 8 — every registry type the mod family's Java declares, against what we extracted.
 *
 * The declaration is uniform across all five database classes:
 *
 *     ExileRegistryType.register(SlashRef.MODID, "spells", 17, Spell.SERIALIZER, SyncTime.ON_LOGIN)
 *
 * and the registry id is `modid + "_" + id` (`ExileRegistryType.java`). The modid is a constant
 * on the class named in the first argument, so it is resolved by reading that class rather than
 * by a hardcoded map — which is what keeps a sixth sibling mod from being invisible here.
 *
 * A `null` serializer means `getLoader()` returns null and the type is never datapack-loaded, so
 * it *should* have no JSON. Those are checked in the opposite direction: finding one in the
 * snapshot would mean the extractor invented a registry, which is worth knowing too.
 */
function declaredRegistries(srcRoot, snapshot, record) {
  if (!srcRoot) return;
  const files = javaFiles(srcRoot);
  const modids = new Map();
  for (const file of files) {
    const m = /(?:final\s+)?static\s+(?:final\s+)?String\s+MODID\s*=\s*"([^"]+)"/.exec(
      readFileSync(file, "utf8"),
    );
    if (m) modids.set(basename(file, ".java"), m[1]);
  }

  const declared = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("ExileRegistryType.register(")) continue;
    const calls = text.matchAll(
      /ExileRegistryType\.register\(\s*([A-Za-z_][A-Za-z0-9_]*)\.MODID\s*,\s*"([^"]+)"\s*,\s*[^,]+,\s*([^,]+),/g,
    );
    for (const call of calls) {
      const modid = modids.get(call[1]);
      if (modid === undefined) continue;
      declared.set(`${modid}_${call[2]}`, {
        modid,
        loaded: call[3].trim() !== "null",
        where: `${basename(file)} ${call[1]}.MODID "${call[2]}"`,
      });
    }
  }
  if (declared.size === 0) {
    fail("found no ExileRegistryType.register calls under --src — is that a Mine and Slash checkout?");
  }

  for (const [id, info] of declared) {
    const present = snapshot.registries[id] !== undefined;
    if (info.loaded && !present) {
      record(
        "extraction",
        id,
        `${info.modid} declares this registry (${info.where}) and the snapshot has no entries for it`,
      );
    }
    if (!info.loaded && present) {
      record(
        "extraction",
        id,
        `declared with a null serializer (${info.where}), so the game never datapack-loads it — but the snapshot has entries`,
      );
    }
  }
}

/**
 * Check 9 — every namespace directory in the install, against the ones the extractor opened.
 *
 * This is the check whose absence was the bug. It deliberately reads the *install*, through the
 * extractor's own `locateInstall` and `ZipArchive` so that it sees what the extractor sees, and
 * compares against `diagnostics.namespaces`, which is the extractor's record of what it read.
 * A namespace present on disk and missing from that inventory is a namespace nobody looked at.
 */
function namespaceCoverage(installPath, snapshot, record) {
  const inventory = snapshot.diagnostics?.namespaces;
  if (!installPath || !inventory) return;
  const locate = globalThis.__LOCATE__;
  const zip = globalThis.__ZIP__;
  if (!locate || !zip) return;

  let install;
  try {
    install = locate.locateInstall(installPath);
  } catch {
    // The install may simply not be on this machine — CI, or a snapshot someone sent you. That
    // is a reason to skip the check, not to fail the run; checks 8 and 10 still apply.
    return;
  }

  const read = new Set(inventory.map((n) => `${n.layer}/${n.namespace}`));
  const onDisk = new Map();

  const jar = zip.ZipArchive.open(install.mineAndSlashJar);
  try {
    for (const name of jar.find("data/", ".json")) {
      const parts = name.split("/");
      if (parts.length < 4) continue;
      const key = `jar/${parts[1]}`;
      onDisk.set(key, (onDisk.get(key) ?? 0) + 1);
    }
  } finally {
    jar.close();
  }

  for (const pack of install.openLoaderPacks) {
    for (const ns of pack.namespaces) onDisk.set(`${pack.id}/${ns.namespace}`, -1);
  }

  for (const [key, files] of onDisk) {
    if (read.has(key)) continue;
    record(
      "extraction",
      key,
      files > 0
        ? `${files} JSON files in the install that the extractor never opened`
        : `a namespace directory in the install that the extractor never opened`,
    );
  }
}

// There is deliberately no check over `registryLists`, and it is worth saying why, because it
// looks like the obvious third one: the jar ships a `modpack_dev_helper/<registry>.txt` naming
// every default entry, so a list with no registry behind it looks like proof of a missing
// extraction. It is not. Those 119 filenames span three naming eras at once — `spells.txt` and
// `mmorpg_spells.txt` describe the same registry, `mob_affix.txt` aliases two different ones in
// two namespaces, and the Orbs of Crafting registries are listed under three names each. 59 of
// the 119 have no matching registry and only two of those mean anything.
//
// Check 8 answers the same question from `ExileRegistryType.register` in the Java, which is the
// declaration the game itself loads from and carries no aliases. Both of the real findings came
// out of it. A second, noisier answer to a question already answered is how a check ends up
// being ignored.

/** Every `.java` under `root`, skipping build output. */
function javaFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "build" || entry.name === ".git" || entry.name === ".gradle") continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".java")) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

function fail(message) {
  console.error(`audit-port-coverage: ${message}`);
  process.exit(2);
}

// The engine's in-code effect table is the authority on what it implements, and it is a runtime
// value rather than something greppable — the element families are expanded in a loop. So it is
// imported from the build output, which is why this needs `npm run build` first.
const engine = resolve(process.argv.includes("--root") ? "." : ".", "packages/engine/dist/damage/code-only-effects.js");
if (!existsSync(engine)) fail(`${engine} is missing — run \`npm run build\` first`);
globalThis.__IN_CODE__ = (await import(pathToFileURL(engine).href)).inCodeEffects().map((e) => e.statId);

// Check 7 needs the sheet taxonomy and a way to compute a character. Both are build output for
// the same reason the effect table is: the taxonomy expands patterns at runtime, so reading the
// source text would be reimplementing it.
// Check 9 reads the install the way the extractor does, through the extractor's own modules, so
// that "what is on disk" and "what was opened" cannot drift apart by being computed twice.
for (const [key, rel] of [
  ["__SCHEMA__", "packages/schema/dist/index.js"],
  ["__ENGINE__", "packages/engine/dist/index.js"],
  ["__LOCATE__", "packages/extractor/dist/locate.js"],
  ["__ZIP__", "packages/extractor/dist/zip.js"],
]) {
  const path = resolve(".", rel);
  globalThis[key] = existsSync(path) ? await import(pathToFileURL(path).href) : null;
}

main();
