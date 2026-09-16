/**
 * `mmorpg_mob_affix` — the 25 prefixes and suffixes that make one mob tougher than the preset.
 *
 * What makes these worth modelling is that the *target* is the one unverified half of every
 * damage number this project produces. The mitigation on a real Epic in a tier 16 map is not the
 * bare mob's, and until now the only way to say so was to type an armour figure into
 * `config.enemy` and hope. An affix is the game's own answer to "what else is on this mob", and
 * it is data rather than a number someone guessed.
 *
 * The port is four lines, because the game's is:
 *
 *     public List<StatContext> getStatAndContext(LivingEntity en) {
 *         List<ExactStatData> stats = new ArrayList<>();
 *         this.stats.forEach(x -> stats.add(x.ToExactStat(100, Load.Unit(en).getLevel())));
 *         return Arrays.asList(new SimpleStatCtx(StatContext.StatCtxType.MOB_AFFIX, stats));
 *     }
 *
 * — MobAffix.java:86-95. Fixed at 100%, scaled to the **mob's** level, filed under its own
 * `StatCtxType`. No weighting, no roll, no rarity gate at this point: which affixes a mob rolls
 * is loot generation's business, and a planner is told rather than rolling for it.
 *
 * This is the shape the Training Dummy mod settled on and the reason to copy it: its presets
 * "pin no numbers at all … and let Mine and Slash build the stat block itself", with affixes as
 * toggles on top reading `ExileDB.MobAffixes().get(id).getStatAndContext(dummy)`. A number typed
 * into a planner and a number typed into a dummy can disagree; two lists of affix ids cannot.
 */

import type { Snapshot } from "@cte2/extractor";
import type { Diagnostic, Severity } from "@cte2/schema";
import { CATEGORY, entry, ids as registryIds } from "@cte2/schema";

import type { Balance } from "../balance.js";
import { parseRolledMods, rollToExact, type ModType } from "../modifier.js";
import type { StatIndex } from "../stat-def.js";

/** One affix, as the registry declares it. */
export type MobAffixView = {
  id: string;
  /** `prefix` or `suffix` — the game allows one of each on a mob. */
  type: string;
  /** A `ChatFormatting` name, for the colour the game prints it in. */
  format: string;
  stats: Record<string, unknown>[];
};

export function mobAffix(snapshot: Snapshot, id: string): MobAffixView | undefined {
  const d = entry(snapshot, CATEGORY.mobAffix, id)?.data;
  if (!d) return undefined;
  return {
    id,
    type: typeof d["type"] === "string" ? d["type"] : "prefix",
    format: typeof d["format"] === "string" ? d["format"] : "GRAY",
    stats: Array.isArray(d["stats"])
      ? d["stats"].filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      : [],
  };
}

/** Every affix the pack declares, for a picker. */
export function mobAffixIds(snapshot: Snapshot): string[] {
  return registryIds(snapshot, CATEGORY.mobAffix).sort();
}

/** What one affix contributes, resolved at the mob's level. */
export type MobAffixMod = { statId: string; type: ModType; value: number; source: string };

/**
 * The affixes named on the enemy, resolved against its level.
 *
 * An unknown id is reported rather than skipped: the whole point of naming affixes instead of
 * typing armour is that the document says something checkable, and an id the snapshot does not
 * have is a document describing a mob this pack cannot make.
 */
export function mobAffixMods(
  snapshot: Snapshot,
  index: StatIndex,
  bal: Balance,
  mobLevel: number,
  affixIds: readonly string[],
  report: (severity: Severity, code: string, path: string, message: string) => void,
): MobAffixMod[] {
  const out: MobAffixMod[] = [];
  const seen = new Set<string>();

  for (const id of affixIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const affix = mobAffix(snapshot, id);
    if (!affix) {
      report(
        "warning",
        "unknown-mob-affix",
        "config.enemy.affixes",
        `No \`${CATEGORY.mobAffix}\` entry "${id}", so it contributed nothing to the target.`,
      );
      continue;
    }
    for (const mod of parseRolledMods(affix.stats)) {
      // `ToExactStat(100, level)` — fixed, not rolled, and at the mob's level rather than yours.
      const exact = rollToExact(mod, 100, mobLevel, index.shapeOf(mod.statId), bal);
      out.push({ statId: exact.statId, type: exact.type, value: exact.value, source: id });
    }
  }
  return out;
}

/** Collected here so a caller can report the list without recomputing it. */
export function mobAffixDiagnostics(
  snapshot: Snapshot,
  affixIds: readonly string[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const prefixes = affixIds.filter((id) => mobAffix(snapshot, id)?.type === "prefix");
  const suffixes = affixIds.filter((id) => mobAffix(snapshot, id)?.type === "suffix");

  // `MobAffixesData` rolls at most one of each. More than that is not impossible to *state* — a
  // planner may want to ask what three prefixes would cost — but it is not a mob the game makes,
  // and saying so is cheaper than someone wondering why their numbers do not reproduce.
  for (const [kind, list] of [
    ["prefix", prefixes],
    ["suffix", suffixes],
  ] as const) {
    if (list.length > 1) {
      out.push({
        severity: "warning",
        code: "mob-affix-count",
        path: "config.enemy.affixes",
        message:
          `${list.length} ${kind}es are on the target (${list.join(", ")}). A mob rolls at most ` +
          `one of each, so this describes a tougher enemy than the game generates.`,
      });
    }
  }
  return out;
}
