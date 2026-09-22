/**
 * Spell schools — "classes" in Craft to Exile 2's own wording.
 *
 * A school is a 10x7 grid of perks with a level requirement per row, and the player levels
 * individual perks up rather than allocating a node once. `SpellSchoolsData.allocated_lvls` is
 * a `HashMap<String, Integer>` of **perk id to level**, which is what a build document records
 * verbatim, for the same reason `statPoints` records the map rather than the resulting stats: a
 * recorded allocation stays recreatable, and an impossible one stays detectable.
 *
 * ## Why this is not a talent tree
 *
 * It looks like one and behaves like neither:
 *
 *  - **No adjacency.** Nothing connects to anything. What gates a perk is the character's
 *    level against its row: `getLevelNeededToAllocate(point) = lvl_reqs[point.y]`.
 *  - **Levels, not allocations.** `learn()` increments. A perk at level N grants N times its
 *    stats — `percentIncrease = (lvl - 1) * 100` then `increaseByAddedPercent()`, which is
 *    `v1 *= (1 + percentIncrease / 100)`, so exactly N.
 *  - **Two point pools.** Spell perks spend `SPELLS`, everything else spends `PASSIVES`.
 *  - **Two schools maximum**, and one school pays a bonus — see {@link isSoloClass}.
 *
 * ## A spell's level *is* a stat
 *
 * A spell perk's only stat is `learn_<spellId>`, a code-only `LearnSpellStat`, and
 * `SpellCastingData.calcSpellLevels` reads the container back out:
 *
 *     if (x.GetStat() instanceof LearnSpellStat learn)
 *         addSpell(new InsertedSpell(learn.spell.GUID(), (int) x.getValue()));
 *
 * So a perk at level 6 puts `learn_fireball = 6` on the sheet, and *that* is the spell's rank —
 * before `MaxSpellLevel` / `MaxAllSpellLevels` add bonus ranks, clamped to
 * `MAX_BONUS_SPELL_LEVELS`. Spell level is therefore not an independent field a document has to
 * carry: it falls out of the school allocation, which is the single biggest reason to model
 * schools at all. `SkillSetup.level` remains for gem-granted spells and as an override.
 */

import type { BuildDoc } from "./build-doc.js";
import { CATEGORY, entry, ids, perk } from "./queries.js";
import type { Snapshot } from "@cte2/extractor";

/** The stat id prefix `LearnSpellStat.GUID()` builds: `"learn_" + spell.GUID()`. */
export const LEARN_STAT_PREFIX = "learn_";

/** The most schools one character may hold points in (`SpellSchoolsData.canLearn`). */
export const MAX_SCHOOLS = 2;

/**
 * What a character with points in exactly one school gets, from `SpellSchoolsData`. Both are
 * `ExactStatData.noScaling`, and they are deliberately **not** in the `PASSIVES` context — the
 * source comments that it is "kept out of the PASSIVES ctx so nothing that scales passive stats
 * picks it up".
 */
export const SOLO_CLASS_MORE_DAMAGE = 10;
export const SOLO_CLASS_DAMAGE_REDUCTION = 5;

export type SchoolPoint = { x: number; y: number };

export type SpellSchoolView = {
  id: string;
  /** Perk id to its grid position. `x` is the column, `y` the row, `y = 0` at the bottom. */
  perks: Map<string, SchoolPoint>;
  /** `lvl_reqs`, one character level per row. Seven rows in every school in the pack. */
  levelReqs: number[];
  /** `getLevelNeededToAllocate` — the level the first point in a row costs. */
  levelForRow(y: number): number;
};

export function spellSchoolIds(snapshot: Snapshot): string[] {
  return ids(snapshot, CATEGORY.spellSchool).sort();
}

export function spellSchool(snapshot: Snapshot, id: string): SpellSchoolView | undefined {
  const d = entry(snapshot, CATEGORY.spellSchool, id)?.data;
  if (!d) return undefined;

  const perks = new Map<string, SchoolPoint>();
  const raw = d["perks"];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [perkId, point] of Object.entries(raw as Record<string, unknown>)) {
      if (point === null || typeof point !== "object" || Array.isArray(point)) continue;
      const p = point as Record<string, unknown>;
      const x = typeof p["x"] === "number" ? p["x"] : 0;
      const y = typeof p["y"] === "number" ? p["y"] : 0;
      perks.set(perkId, { x, y });
    }
  }

  const reqsRaw = d["lvl_reqs"];
  // The class's own default, from SpellSchool.java, for a pack entry that omits the field.
  const levelReqs = Array.isArray(reqsRaw)
    ? reqsRaw.filter((n): n is number => typeof n === "number")
    : [1, 5, 10, 15, 20, 25, 30];

  return {
    id,
    perks,
    levelReqs,
    // `lvl_reqs.get(point.y)` throws in game for a row past the end; a row that does not exist
    // is treated here as unreachable rather than free.
    levelForRow: (y: number) => levelReqs[y] ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * `Perk.getSpellSchool()` — the first school whose grid holds this perk.
 *
 * The game does this with a linear scan over every school on each call. Here it is a scan too,
 * but cached per snapshot, because the app asks it once per rendered node.
 */
const SCHOOL_OF_PERK = new WeakMap<Snapshot, Map<string, string>>();

export function schoolOfPerk(snapshot: Snapshot, perkId: string): string | undefined {
  let index = SCHOOL_OF_PERK.get(snapshot);
  if (!index) {
    index = new Map();
    for (const schoolId of spellSchoolIds(snapshot)) {
      const view = spellSchool(snapshot, schoolId);
      if (!view) continue;
      for (const id of view.perks.keys()) {
        if (!index.has(id)) index.set(id, schoolId);
      }
    }
    SCHOOL_OF_PERK.set(snapshot, index);
  }
  return index.get(perkId);
}

/**
 * `Perk.isSpell()`: its first stat's `Stat` is a `LearnSpellStat`.
 *
 * In the data that is an id of `learn_<spellId>`, which is the only shape a `LearnSpellStat`
 * can have — the stat is constructed from a spell and its GUID is built from that spell's id.
 */
export function isSpellPerk(snapshot: Snapshot, perkId: string): boolean {
  return spellOfPerk(snapshot, perkId) !== undefined;
}

/** The spell a spell perk teaches, or `undefined` for a passive. */
export function spellOfPerk(snapshot: Snapshot, perkId: string): string | undefined {
  const d = entry(snapshot, CATEGORY.perk, perkId)?.data;
  if (!d) return undefined;
  const stats = d["stats"];
  if (!Array.isArray(stats) || stats.length === 0) return undefined;
  const first = stats[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return undefined;
  const statId = (first as Record<string, unknown>)["stat"];
  if (typeof statId !== "string" || !statId.startsWith(LEARN_STAT_PREFIX)) return undefined;
  return statId.slice(LEARN_STAT_PREFIX.length);
}

/** Which point pool a perk spends from: spells and passives are budgeted separately. */
export function perkPointType(snapshot: Snapshot, perkId: string): "SPELLS" | "PASSIVES" {
  return isSpellPerk(snapshot, perkId) ? "SPELLS" : "PASSIVES";
}

/**
 * The character level needed to take a perk from `currentLevel` to `currentLevel + 1`.
 *
 * The first point needs `lvl_reqs[y]` and nothing more. Every point after it needs one more
 * character level per point already spent, and the comparison is **strictly greater**:
 *
 *     int bonusLvlsNeeded = (int) ((currentlvl - 1) * points_per_lvl(SPELLS));
 *     return Load.Unit(en).getLevel() > baselvl + bonusLvlsNeeded;
 *
 * Note the rule reads `points_per_lvl` for `SPELLS` whatever kind of perk this is, and note it
 * is the *level already held* that drives the cost, so level 2 needs `base + 1` beaten, not met.
 */
export function levelNeededForNextPerkLevel(
  view: SpellSchoolView,
  point: SchoolPoint,
  currentLevel: number,
  spellsPointsPerLevel: number,
): number {
  const base = view.levelForRow(point.y);
  if (!Number.isFinite(base)) return base;
  if (currentLevel < 1) return base;
  return base + Math.floor((currentLevel - 1) * spellsPointsPerLevel) + 1;
}

/** The schools a document has points in, in no particular order. */
export function allocatedSchools(snapshot: Snapshot, build: BuildDoc): string[] {
  const allocated = build.character.schools;
  if (!allocated) return [];
  const out = new Set<string>();
  for (const [perkId, level] of Object.entries(allocated)) {
    if (!Number.isFinite(level) || level < 1) continue;
    const school = schoolOfPerk(snapshot, perkId);
    if (school !== undefined) out.add(school);
  }
  return [...out].sort();
}

/** `SpellSchoolsData.isSoloClass` — points in exactly one school. */
export function isSoloClass(snapshot: Snapshot, build: BuildDoc): boolean {
  return allocatedSchools(snapshot, build).length === 1;
}

/** Points spent per pool, which is what the two counters at the bottom of the screen show. */
export function schoolPointsSpent(
  snapshot: Snapshot,
  build: BuildDoc,
): { SPELLS: number; PASSIVES: number } {
  const spent = { SPELLS: 0, PASSIVES: 0 };
  const allocated = build.character.schools;
  if (!allocated) return spent;
  for (const [perkId, level] of Object.entries(allocated)) {
    if (!Number.isFinite(level) || level < 1) continue;
    spent[perkPointType(snapshot, perkId)] += level;
  }
  return spent;
}

/**
 * Every spell the school allocation teaches, with the rank it teaches it at.
 *
 * This is the `learn_<spell>` half of `calcSpellLevels` — the part a document determines. The
 * bonus ranks from `MaxSpellLevel` and `MaxAllSpellLevels` are stats, so they belong to the
 * engine's calculation rather than to a query over the document.
 */
export function learnedSpells(snapshot: Snapshot, build: BuildDoc): Map<string, number> {
  const out = new Map<string, number>();
  const allocated = build.character.schools;
  if (!allocated) return out;
  for (const [perkId, level] of Object.entries(allocated)) {
    if (!Number.isFinite(level) || level < 1) continue;
    const spellId = spellOfPerk(snapshot, perkId);
    if (spellId === undefined) continue;
    // A spell perk grants `learn_<spell>` FLAT 1, multiplied by its level. Two perks teaching
    // the same spell would stack the same way the stat container stacks them, by adding.
    out.set(spellId, (out.get(spellId) ?? 0) + level);
  }
  return out;
}

/** The perks of a school, ordered for display: bottom row first, left to right. */
export function schoolPerksInOrder(view: SpellSchoolView): { perkId: string; point: SchoolPoint }[] {
  return [...view.perks.entries()]
    .map(([perkId, point]) => ({ perkId, point }))
    .sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
}

/** Perk ids in a school's grid that no `mmorpg_perk` entry backs — a pack bug, not a user error. */
export function unknownSchoolPerks(snapshot: Snapshot, view: SpellSchoolView): string[] {
  return [...view.perks.keys()].filter((id) => perk(snapshot, id) === undefined).sort();
}

/**
 * Points spent in one school, both pools together.
 *
 * The game has no such counter — its two `PointsDisplayButton`s are per pool and across every
 * school — but "how much of this class have I bought" is what decides which of your two classes
 * is the one you are actually playing, and that is the question the planner's class screen has
 * to answer before it can pin one of them in place.
 */
export function pointsSpentInSchool(snapshot: Snapshot, build: BuildDoc, schoolId: string): number {
  const allocated = build.character.schools;
  if (!allocated) return 0;
  let spent = 0;
  for (const [perkId, level] of Object.entries(allocated)) {
    if (!Number.isFinite(level) || level < 1) continue;
    if (schoolOfPerk(snapshot, perkId) === schoolId) spent += level;
  }
  return spent;
}

/**
 * The schools a document has points in, the one with the most points first.
 *
 * Ties break on the school id so the order never depends on how the document happened to be
 * serialised: a build reloaded from disk must put the same class on the same side as the build
 * that was saved, or the screen moves under you for no reason you can see.
 */
export function schoolsByPointsSpent(snapshot: Snapshot, build: BuildDoc): string[] {
  return allocatedSchools(snapshot, build)
    .map((id) => ({ id, spent: pointsSpentInSchool(snapshot, build, id) }))
    .sort((a, b) => b.spent - a.spent || a.id.localeCompare(b.id))
    .map((s) => s.id);
}
