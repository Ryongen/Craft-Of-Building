/**
 * Support gems and a spell's own innate stats — the two contexts a *chosen skill* adds that
 * the character sheet does not have.
 *
 * This is the half of `StatCalculation.calc` phase 1 deliberately skipped. The game keeps two
 * separate stat units per player: `allStatsWithoutSuppGems`, which is what the character
 * screen shows, and one `Unit` per spell built on top of it:
 *
 *     private Unit calcSpellUnit(Spell spell, int key) {
 *         var unit = new Unit();
 *         StatCalculation.calc(unit, this.cachedStats.allStatsWithoutSuppGems, player, spell, key);
 *         return unit;
 *     }
 *
 * — PlayerData.java:397-401. The extra contexts land *before* the shared ones:
 *
 *     gemstats.addAll(collectGemStats(p, data, playerData, skillGem));
 *     gemstats.addAll(collectSpellStats(p, data, playerData, spell));
 *     ...
 *     allstats.addAll(gemstats);
 *     allstats.addAll(statsWithoutSuppGems);
 *
 * — StatCalculation.java:66-82. Everything is summed into one container so the order changes
 * no number, but it is kept so a provenance dump reads in the game's order.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, SkillSetup } from "@cte2/schema";
import { CATEGORY, entry, learnedSpells, supportLinks } from "@cte2/schema";

import type { Balance } from "../balance.js";
import { context, type Env, type StatContext } from "../context.js";
import { gemRoll } from "./gem-roll.js";
import { parseRolledMods, rollToExact, type ExactMod, type RolledMod } from "../modifier.js";

/**
 * The stat contexts a chosen skill contributes.
 *
 * `path` values are rooted at the skill's index in the document so diagnostics point at the
 * thing the author wrote, matching every other collector.
 */
export function collectSpellContexts(
  env: Env,
  skill: SkillSetup,
  path: string,
  equipped: readonly SkillSetup[] = [],
): StatContext[] {
  const out: StatContext[] = [];
  const spell = entry(env.snapshot, CATEGORY.spell, skill.spellId)?.data;
  if (!spell) {
    env.report("error", "unknown-spell", `${path}.spellId`, `No ${CATEGORY.spell} entry \`${skill.spellId}\`.`);
    return out;
  }

  const sockets = supportSocketsFor(env.snapshot, skill, equipped);
  if (sockets !== undefined) {
    const at = sockets.borrowedFrom === undefined ? path : `${path}.supportsFrom(${sockets.borrowedFrom})`;
    out.push(...collectSupportGems(env, sockets.skill, at));
  }
  out.push(...collectInnateStats(env, skill, spell, path));
  return out;
}

/**
 * Whose sockets a Skill's support gems come out of.
 *
 * `use_support_gems_from` **replaces** the socket rather than adding to it. `PlayerData` builds
 * the spell unit from a hotbar slot key, and for a borrowing spell that key is the other spell's:
 *
 *     int key = keyOf(spell);
 *     if (spell.config.usesSupportGemsFromAnotherSpell()) {
 *         key = keyOf(spell.config.getSpellUsedForSuppGems());
 *     }
 *
 * — PlayerData.getSpellUnitStats:498-509, with `collectGemStats` then reading
 * `getActiveSupportDatas` off that slot. So `soul_wound` is supported by whatever is socketed
 * into `banishing_blade` and by nothing of its own, and the game's own damage log says so: with
 * `fortify` at 35% and `brutality` at 31% in banishing_blade, a Soul Wound hit prints
 * `Melee Skill Damage x1.05` and `Physical Damage x1.34`, neither of which the character sheet
 * carries.
 *
 * When the borrowed spell is not on the bar there is no slot at all — `keyOf` returns
 * `SPELL_KEY_NOT_EXIST` and `canHaveSpellUnit` is false — so the answer is no support gems,
 * not the Skill's own. 25 spells in this pack borrow, nine pet basic attacks among them.
 */
export function supportSocketsFor(
  snapshot: Snapshot,
  skill: SkillSetup,
  equipped: readonly SkillSetup[],
): { skill: SkillSetup; borrowedFrom?: string } | undefined {
  const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
  const config = asObject(spell?.["config"]);
  const borrowed = typeof config?.["use_support_gems_from"] === "string" ? config["use_support_gems_from"] : "";
  if (borrowed.length === 0) return { skill };
  const lender = equipped.find((other) => other.spellId === borrowed);
  return lender === undefined ? undefined : { skill: lender, borrowedFrom: borrowed };
}

/**
 * `collectGemStats` (StatCalculation.java:164-177).
 *
 *     for (SkillGemData d : gem.getSupportDatas()) {
 *         if (d.getSupport() != null) {
 *             statContexts.add(new SimpleStatCtx(StatContext.StatCtxType.SUPPORT_GEM, d.getSupport().GetAllStats(data, d)));
 *         }
 *     }
 *
 * with `SupportGem.GetAllStats` rolling each `{min, max}` at the gem's own
 * `SkillGemData.getStatPercent()` and scaling flats to the **character's** level
 * (SupportGem.java:104-110). One context per gem, as the game does — merging them would lose
 * which gem paid for what.
 *
 * Read `d` in that loop closely: it is the *support gem's* own `SkillGemData`, so every support
 * gem is an independently rolled item. Five linked into one Skill are five separate percents,
 * and the Skill's own percent is not one of them — `Spell.getStats` never consults it at all,
 * deriving its percent from the Skill's rank instead. Rolling all five at the Skill's number was
 * wrong in both directions at once: a Skill that happened to roll 33% underpaid five perfect
 * support gems, and one at 100% credited rolls the gems never had.
 */
function collectSupportGems(env: Env, skill: SkillSetup, path: string): StatContext[] {
  const out: StatContext[] = [];
  const links = supportLinks(skill);
  if (links.length === 0) return out;

  links.forEach((link, i) => {
    const at = `${path}.supports[${i}]`;
    const data = entry(env.snapshot, CATEGORY.supportGem, link.id)?.data;
    if (!data) {
      env.report("error", "unknown-support-gem", at, `No ${CATEGORY.supportGem} entry \`${link.id}\`.`);
      return;
    }
    const roll = gemRoll(env, link.rarity, link.rollPercent);
    if (!roll.stated) {
      env.report(
        "warning",
        "gem-roll-unknown",
        at,
        `\`${link.id}\` rolls its stats at its own \`SkillGemData.getStatPercent()\`, which this ` +
          `document does not record, so it is computed at ${roll.floor}% — the floor of ` +
          `${link.rarity === undefined ? "the full range" : `a "${link.rarity}" gem's band`}, ` +
          `not the real value.`,
      );
    }
    out.push(context("SUPPORT_GEM", link.id, at, exactMods(env, modsOf(data, "stats"), roll.percent)));
  });

  return out;
}

/**
 * `collectSpellStats` (StatCalculation.java:179-199) — the spell's `statsForSkillGem`, plus
 * the same list from whatever spell it borrows support gems from.
 *
 *     if (spell.config.usesSupportGemsFromAnotherSpell()) {
 *         var other = spell.config.getSpellUsedForSuppGems();
 *         var stats2 = other.getStats(p);
 *         if (!stats2.isEmpty()) {
 *             statContexts.add(new SimpleStatCtx(StatContext.StatCtxType.INNATE_SPELL, stats2));
 *         }
 *     }
 *
 * Note what that does *not* do: it takes the other spell's innate stats, but the other
 * spell's own level, since `getStats` is called on `other`. 21 spells in this pack do it.
 */
function collectInnateStats(
  env: Env,
  skill: SkillSetup,
  spell: Record<string, unknown>,
  path: string,
): StatContext[] {
  const out: StatContext[] = [];

  const stats = innateOf(env, skill.spellId, spell, skill.level);
  if (stats.length > 0) out.push(context("INNATE_SPELL", skill.spellId, path, stats));

  const config = asObject(spell["config"]);
  const borrowed = typeof config?.["use_support_gems_from"] === "string" ? config["use_support_gems_from"] : "";
  if (borrowed.length > 0) {
    const other = entry(env.snapshot, CATEGORY.spell, borrowed)?.data;
    if (!other) {
      env.report(
        "error",
        "unknown-spell",
        path,
        `\`${skill.spellId}\` declares \`use_support_gems_from: "${borrowed}"\`, which is not a ${CATEGORY.spell} entry.`,
      );
    } else {
      // The borrowed spell is at *its* own level, which the document does not record, so it
      // takes its `default_lvl` — the same floor `Spell.getLevelOf` applies to an unlearned spell.
      const borrowedStats = innateOf(env, borrowed, other, undefined);
      if (borrowedStats.length > 0) out.push(context("INNATE_SPELL", borrowed, path, borrowedStats));
    }
  }

  return out;
}

/**
 * `Spell.getStats` (Spell.java:127-131):
 *
 *     int perc = (int) ((getLevelOf(p) / (float) getMaxLevelWithBonuses()) * 100F);
 *     var stats = statsForSkillGem.stream().map(x -> x.ToExactStat(perc, Load.Unit(p).getLevel())).collect(...);
 *
 * Two things carry. The percent is **truncated to an int**, so a level 5 of 24 is 20% and not
 * 20.83%. And the level the flats scale to is the *player's*, not the spell's.
 */
function innateOf(
  env: Env,
  spellId: string,
  spell: Record<string, unknown>,
  declaredLevel: number | undefined,
): ExactMod[] {
  const mods = modsOf(spell, "statsForSkillGem");
  if (mods.length === 0) return [];
  const percent = Math.trunc((spellLevel(env, spellId, spell, declaredLevel) / maxSpellLevel(env, spell)) * 100);
  return exactMods(env, mods, percent);
}

/**
 * A skill's level, filled in from the school allocation when the document does not state one.
 *
 * In game a spell's rank is not a property of the skill setup at all: a spell perk grants
 * `learn_<spellId>` once per level, and `SpellCastingData.calcSpellLevels` reads that stat back
 * out of the finished container as the rank. The document's `skills[].level` therefore exists
 * for gem-granted spells and as an override — where it is absent and the character's classes
 * teach the spell, the class allocation is the answer.
 *
 * Bonus ranks are in `ranks`, when a caller has a sheet to derive them from. `MaxSpellLevel` and
 * `MaxAllSpellLevels` are stats, so they are only known once the container is built — which is
 * exactly the order the game runs in, `calcSpellLevels(unit, p)` being handed the finished
 * character unit. A caller that has that sheet passes {@link spellRanks} of it and gets the
 * game's own answer; one that does not falls back to the `learn_<id>` the document can be read
 * for on its own, which is the same number minus the bonus.
 */
export function withLearnedRank(
  snapshot: Snapshot,
  build: BuildDoc,
  skill: SkillSetup,
  ranks?: SpellRanks,
): SkillSetup {
  if (skill.level !== undefined) return skill;

  // `Spell.getLevelOf` delegates across `lvl_based_on_spell` *before* it reads any rank, so a
  // spell that borrows its level has no rank of its own to look up — `soul_wound` is never
  // learned, granted or socketed, and there is no `learn_soul_wound` perk anywhere in the pack.
  // Looking it up under its own id therefore found nothing and left the spell at `default_lvl`,
  // which for the eighteen spells that do this is 0: the bottom of every `LeveledValue` band.
  // On `soul_wound` that is a `dmg_effectiveness` of 0.70 against the 0.94 it actually runs at,
  // and the flat added damage that multiplies is the largest term in the hit.
  const source = levelSourceSpell(snapshot, skill.spellId);
  const rank = rankOf(snapshot, build, source, ranks);
  return rank === undefined || rank <= 0 ? skill : { ...skill, level: rank };
}

/**
 * Which spell's rank this one reads, following `lvl_based_on_spell` with the Java's own one-hop
 * loop guard (`if (!other.lvl_based_on_spell.equals(this.lvl_based_on_spell))`).
 */
function levelSourceSpell(snapshot: Snapshot, spellId: string): string {
  const spell = entry(snapshot, CATEGORY.spell, spellId)?.data;
  const basedOn = typeof spell?.["lvl_based_on_spell"] === "string" ? spell["lvl_based_on_spell"] : "";
  if (basedOn.length === 0 || basedOn === spellId) return spellId;
  const other = entry(snapshot, CATEGORY.spell, basedOn)?.data;
  if (!other || other["lvl_based_on_spell"] === basedOn) return spellId;
  return basedOn;
}

/**
 * A spell's rank: what the bar says first, then what the sheet resolved, then the allocation.
 *
 * The bar wins because a capture writes the game's *final* answer there — `InsertedSpell.rank`,
 * with `MaxSpellLevel` and `plus_lvl_buff_spells` already added. `ranks` is the engine's own
 * version of that same number and is the next best thing; it is absent only for a caller with no
 * sheet in hand, and then `learn_<id>` off the document is the floor, short by the bonus.
 *
 * `learnedSpells` is deliberately the last resort rather than the first: it reads
 * `character.schools`, so it sees a spell a *class* taught and misses one a unique or a runeword
 * granted. Those grant `learn_<id>` like any other stat, so the sheet has them and the document
 * query cannot.
 */
function rankOf(
  snapshot: Snapshot,
  build: BuildDoc,
  spellId: string,
  ranks: SpellRanks | undefined,
): number | undefined {
  const declared = (build.skills ?? []).find((s) => s.spellId === spellId)?.level;
  if (declared !== undefined) return declared;
  return ranks?.get(spellId) ?? learnedSpells(snapshot, build).get(spellId);
}

/**
 * `Spell.getLevelOf` (Spell.java:486-505), floored at `default_lvl`, and honouring
 * `lvl_based_on_spell` — 15 spells in this pack take their level from another spell entirely,
 * with the Java's own one-hop loop guard preserved.
 */
export function spellLevel(
  env: Env,
  spellId: string,
  spell: Record<string, unknown>,
  declaredLevel: number | undefined,
): number {
  const basedOn = typeof spell["lvl_based_on_spell"] === "string" ? spell["lvl_based_on_spell"] : "";
  if (basedOn.length > 0 && basedOn !== spellId) {
    const other = entry(env.snapshot, CATEGORY.spell, basedOn)?.data;
    // `if (!other.lvl_based_on_spell.equals(this.lvl_based_on_spell))` — one hop only.
    if (other && other["lvl_based_on_spell"] !== basedOn) {
      return spellLevel(env, basedOn, other, declaredLevel);
    }
  }
  const fallback = numberAt(spell, "default_lvl") ?? 0;
  return Math.max(declaredLevel ?? fallback, fallback);
}

/** `Spell.getMaxLevelWithBonuses()` = `max_lvl + MAX_BONUS_SPELL_LEVELS` (Spell.java:586-588). */
export function maxSpellLevel(env: Env, spell: Record<string, unknown>): number {
  const max = numberAt(spell, "max_lvl") ?? 16;
  return Math.max(max + env.balance.maxBonusSpellLevels, 1);
}

function exactMods(env: Env, mods: readonly RolledMod[], percent: number): ExactMod[] {
  return mods.map((mod) =>
    rollToExact(mod, percent, env.level, env.index.shapeOf(mod.statId), env.balance),
  );
}

function modsOf(node: Record<string, unknown>, key: string): RolledMod[] {
  const raw = node[key];
  return Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// `SpellCastingData.calcSpellLevels` — ranks, bonus ranks included
// ---------------------------------------------------------------------------

/** `learn_<spellId>` — one `LearnSpellStat` per spell, and a spell's rank *is* that stat. */
const LEARN_PREFIX = "learn_";
/** `plus_lvl_<tag>_spells` — `MaxSpellLevel.GUID()`. */
const PLUS_PREFIX = "plus_lvl_";
const PLUS_SUFFIX = "_spells";
/** `MaxAllSpellLevels.GUID()`, which is the same shape with `all` where the tag goes. */
const PLUS_ALL = "plus_lvl_all_spells";

/** What `calcSpellLevels` leaves behind: spell id -> final rank, bonus ranks folded in. */
export type SpellRanks = ReadonlyMap<string, number>;

/** The minimum a sheet has to look like for {@link spellRanks} to read it. */
type RankSheet = ReadonlyMap<string, { value: number }>;

/**
 * `SpellCastingData.calcSpellLevels(unit, en)` — every spell the character knows, at the rank
 * the game would have given it.
 *
 * This is the half of a spell's rank that is *not* a property of the document. A spell perk
 * grants `learn_<spell>` once per level and that stat is the rank, so the ranks fall out of the
 * finished container:
 *
 *     unit.getStats().stats.values().forEach(x -> {
 *         if (x.GetStat() instanceof LearnSpellStat learn) {
 *             addSpell(new InsertedSpell(learn.spell.GUID(), (int) x.getValue()));
 *         }
 *     });
 *
 * Then two stats add ranks on top — `MaxSpellLevel`, one per spell tag, and `MaxAllSpellLevels`
 * — and the sum is clamped to `MAX_BONUS_SPELL_LEVELS` *before* it is added to the rank, so a
 * character carrying +2 cold and +2 all on an 8-point ceiling gets +4 on a cold spell and +2 on
 * everything else rather than +4 everywhere.
 *
 * Which unit it reads matters: `EntityData.calcStats` builds `unit` from
 * `getStatsWithoutSuppGems` and hands *that* to `calcSpellLevels`. So the character sheet is the
 * input, never a spell's own unit — which is also why this can run at all. A support gem that
 * granted `plus_lvl_fire_spells` would change the rank of the spell it is linked to, which would
 * change the gem's own roll percent, and the game sidesteps that circularity by not looking.
 *
 * The narrowing is Java's, not a rounding choice: `bonus_ranks` is an `int` and `+=` on an int
 * carries an implicit cast, so each addition truncates rather than the total.
 */
export function spellRanks(snapshot: Snapshot, sheet: RankSheet, bal: Balance): SpellRanks {
  const spells = snapshot.registries[CATEGORY.spell] ?? {};

  // `resetSpells(); ... addSpell(...)` — one InsertedSpell per non-zero LearnSpellStat.
  const ranks = new Map<string, number>();
  for (const [statId, stat] of sheet) {
    if (!statId.startsWith(LEARN_PREFIX)) continue;
    const spellId = statId.slice(LEARN_PREFIX.length);
    if (spells[spellId] === undefined) continue;
    const rank = Math.trunc(stat.value);
    // A stat the container resolved to zero is a spell nothing taught: the game only ever
    // creates an InsertedSpell from a stat that exists, and a `learn_` at 0 is one the
    // collectors materialised for a perk the build did not take.
    if (rank <= 0) continue;
    ranks.set(spellId, rank);
  }
  if (ranks.size === 0) return ranks;

  // `for (InsertedSpell spell : this.spells) { if (spell.getSpell().config.tags.contains(max.tag)) ... }`
  const bonus = new Map<string, number>();
  for (const spellId of ranks.keys()) bonus.set(spellId, 0);

  const add = (spellId: string, value: number): void => {
    bonus.set(spellId, Math.trunc((bonus.get(spellId) ?? 0) + value));
  };

  for (const [statId, stat] of sheet) {
    if (stat.value === 0) continue;
    if (statId === PLUS_ALL) {
      for (const spellId of ranks.keys()) add(spellId, stat.value);
      continue;
    }
    if (!statId.startsWith(PLUS_PREFIX) || !statId.endsWith(PLUS_SUFFIX)) continue;
    const tag = statId.slice(PLUS_PREFIX.length, statId.length - PLUS_SUFFIX.length);
    if (tag.length === 0) continue;
    for (const spellId of ranks.keys()) {
      if (spellTags(spells[spellId]?.data).includes(tag)) add(spellId, stat.value);
    }
  }

  // `bonus_ranks = clamp(bonus_ranks, 0, MAX_BONUS_SPELL_LEVELS); spell.rank += spell.bonus_ranks;`
  const ceiling = Math.max(0, bal.maxBonusSpellLevels);
  const out = new Map<string, number>();
  for (const [spellId, rank] of ranks) {
    out.set(spellId, rank + Math.min(Math.max(bonus.get(spellId) ?? 0, 0), ceiling));
  }
  return out;
}

/** `SpellConfiguration.tags`, which the snapshot nests one level deeper than the field name. */
function spellTags(spell: Record<string, unknown> | undefined): string[] {
  const config = asObject(spell?.["config"]);
  const holder = asObject(config?.["tags"]);
  const list = holder?.["tags"];
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
}
