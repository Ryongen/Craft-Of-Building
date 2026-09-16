/**
 * Spell school allocations — `SpellSchoolsData.getStatAndContext`.
 *
 * The whole method, which is short enough to hold in one piece:
 *
 *     for (var s : this.allocated_lvls.entrySet()) {
 *         if (ExileDB.Perks().isRegistered(s.getKey())) {
 *             for (OptScaleExactStat stat : ExileDB.Perks().get(s.getKey()).stats) {
 *                 var data = stat.toExactStat(Load.Unit(en).getLevel());
 *                 data.percentIncrease = (s.getValue() - 1) * 100;
 *                 data.increaseByAddedPercent();
 *                 stats.add(data);
 *             }
 *         }
 *     }
 *     ctx.add(new SimpleStatCtx(StatContext.StatCtxType.PASSIVES, stats));
 *
 *     if (isSoloClass()) {
 *         ctx.add(new MiscStatCtx(Arrays.asList(
 *             ExactStatData.noScaling(SOLO_CLASS_MORE_DAMAGE, ModType.MORE, TOTAL_DAMAGE),
 *             ExactStatData.noScaling(SOLO_CLASS_DAMAGE_REDUCTION, ModType.FLAT, DAMAGE_REDUCTION))));
 *     }
 *
 * Three things in it are easy to get wrong:
 *
 *  - **The level multiplier is exactly the perk level.** `increaseByAddedPercent` is
 *    `v1 *= (1 + percentIncrease / 100)` and `percentIncrease` is `(lvl - 1) * 100`, so a perk
 *    at level 6 contributes six times its listed value. It is not a percentage increase in the
 *    usual sense and it does not compound with anything.
 *  - **The multiplier applies after level scaling**, because `toExactStat(level)` runs first.
 *    For a `scale_to_lvl` stat that is `6 * scaled(v1)`, which is the same as
 *    `scaled(6 * v1)` only because the scaling is linear in the value — true here, but the
 *    order is kept anyway so it stays true if the curve ever changes.
 *  - **An unregistered perk id contributes nothing and is not an error.** The game's
 *    `isRegistered` guard skips it silently; this reports it, because in a document it is far
 *    more likely to be a typo than a pack bug.
 *
 * The solo-class bonus is a separate context on purpose. The source comments it: "kept out of
 * the PASSIVES ctx so nothing that scales passive stats picks it up".
 */

import {
  SOLO_CLASS_DAMAGE_REDUCTION,
  SOLO_CLASS_MORE_DAMAGE,
  allocatedSchools,
  CATEGORY,
  entry,
  isSoloClass,
  MAX_SCHOOLS,
  perkPointType,
  schoolOfPerk,
  spellSchool,
  type BuildDoc,
} from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { parseSourceMods, sourceToExact, type ExactMod } from "../modifier.js";

/** `OffenseStats.TOTAL_DAMAGE` and `DefenseStats.DAMAGE_REDUCTION`. */
const TOTAL_DAMAGE = "total_damage";
const DAMAGE_REDUCTION = "dmg_reduction";

export function collectSpellSchools(env: Env, build: BuildDoc): StatContext[] {
  const allocated = build.character.schools;
  if (allocated === undefined) return [];

  const out: StatContext[] = [];

  for (const [perkId, level] of Object.entries(allocated)) {
    const path = `character.schools.${perkId}`;

    if (!Number.isFinite(level) || level === 0) continue;
    if (level < 0) {
      env.report(
        "error",
        "negative-school-level",
        path,
        `${level} levels allocated. \`learn()\` only ever increments and \`unlearn()\` stops at ` +
          `zero, so a negative level cannot happen in game and is ignored here.`,
      );
      continue;
    }

    const data = entry(env.snapshot, CATEGORY.perk, perkId)?.data;
    if (!data) {
      env.report(
        "error",
        "unknown-school-perk",
        path,
        `No perk \`${perkId}\`. \`getStatAndContext\` skips an unregistered id, so this grants nothing.`,
      );
      continue;
    }

    // A perk that belongs to no school still grants its stats here — the game's loop reads
    // `allocated_lvls` without asking which grid the perk came from. What `school()` does with
    // such an entry is remove it, so it is worth saying, but it is not silently dropped.
    if (schoolOfPerk(env.snapshot, perkId) === undefined) {
      env.report(
        "warning",
        "perk-not-in-any-school",
        path,
        `\`${perkId}\` is in no spell school's grid. The game's \`school()\` prunes such an entry ` +
          `from \`allocated_lvls\` on the next read, so this allocation would not survive a relog.`,
      );
    }

    const raw = data["stats"];
    const mods: ExactMod[] = (Array.isArray(raw) ? parseSourceMods(raw) : []).map((mod) => {
      const scaled = sourceToExact(mod, env.level, env.index.shapeOf(mod.statId), env.balance);
      // `percentIncrease = (lvl - 1) * 100` then `increaseByAddedPercent()`.
      return { ...scaled, value: scaled.value * level };
    });

    out.push(context("PASSIVES", perkId, path, mods));
  }

  reportSchoolLimits(env, build);

  if (isSoloClass(env.snapshot, build)) {
    out.push(
      context("MISC", "solo_class_bonus", "character.schools", [
        // `ExactStatData.noScaling` — neither of these is level scaled.
        { statId: TOTAL_DAMAGE, type: "MORE", value: SOLO_CLASS_MORE_DAMAGE },
        { statId: DAMAGE_REDUCTION, type: "FLAT", value: SOLO_CLASS_DAMAGE_REDUCTION },
      ]),
    );
  }

  return out;
}

/**
 * The two-school limit, and the level gate per row.
 *
 * Both are enforced in game by `canLearn`, which runs when a point is spent rather than when
 * stats are calculated — so a document that breaks them still calculates. It is reported here
 * rather than corrected, for the same reason the gear collector reports an illegal item: the
 * engine's job is to say what this character would have, and the validator's is to say whether
 * the character could exist.
 */
function reportSchoolLimits(env: Env, build: BuildDoc): void {
  const schools = allocatedSchools(env.snapshot, build);
  if (schools.length > MAX_SCHOOLS) {
    env.report(
      "error",
      "too-many-schools",
      "character.schools",
      `Points in ${schools.length} schools (${schools.join(", ")}). \`canLearn\` refuses a third: ` +
        `"MAX_2_CLASSES".`,
    );
  }

  const allocated = build.character.schools ?? {};
  for (const [perkId, level] of Object.entries(allocated)) {
    if (!Number.isFinite(level) || level < 1) continue;

    const schoolId = schoolOfPerk(env.snapshot, perkId);
    if (schoolId === undefined) continue;
    const view = spellSchool(env.snapshot, schoolId);
    const point = view?.perks.get(perkId);
    if (!view || !point) continue;

    const required = view.levelForRow(point.y);
    if (env.level < required) {
      env.report(
        "error",
        "school-row-level-too-low",
        `character.schools.${perkId}`,
        `\`${perkId}\` sits on row ${point.y} of \`${schoolId}\`, which needs character level ` +
          `${required}; this character is level ${env.level}.`,
      );
    }

    const maxLevels = numberOf(entry(env.snapshot, CATEGORY.perk, perkId)?.data, "max_lvls", 1);
    if (level > maxLevels) {
      env.report(
        "error",
        "school-perk-over-max",
        `character.schools.${perkId}`,
        `Level ${level} on a perk whose \`max_lvls\` is ${maxLevels}. \`canLearn\` refuses past the max.`,
      );
    }

    // Points spent per pool are checked by the validator, which owns budgets; naming the pool
    // here is what lets a breakdown say which counter a perk drew from.
    void perkPointType(env.snapshot, perkId);
  }
}

function numberOf(data: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
