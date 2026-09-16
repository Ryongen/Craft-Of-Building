/**
 * The stats every character has before anything is equipped.
 *
 * `CommonStatUtils.addBaseStats` picks the entry named by `CompatConfig.baseStatsDatapack()`,
 * which for Craft to Exile 2 is `original_mode_player` — the pack ships an override for
 * exactly that and leaves the `compat_mode_*` entries at jar defaults, which is what
 * `@cte2/schema` records as `DEFAULT_PLAYER_BASE_STATS_ID`.
 *
 * These are `{ type, stat, v1, scale_to_lvl }` modifiers, and most of the interesting ones
 * scale: `health` is 80 per level, `weapon_damage` 2 per level plus a flat 1.
 */

import { CATEGORY, DEFAULT_PLAYER_BASE_STATS_ID, entry } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { parseSourceMods, sourceToExact } from "../modifier.js";

export function collectBaseStats(
  env: Env,
  baseStatsId: string = DEFAULT_PLAYER_BASE_STATS_ID,
): StatContext[] {
  const data = entry(env.snapshot, CATEGORY.baseStats, baseStatsId)?.data;
  if (!data) {
    env.report(
      "error",
      "unknown-base-stats",
      "character",
      `No \`${CATEGORY.baseStats}\` entry \`${baseStatsId}\`; the character would have no base health, mana or weapon damage.`,
    );
    return [];
  }

  const raw = data["base_stats"];
  const mods = Array.isArray(raw) ? parseSourceMods(raw) : [];
  if (mods.length === 0) {
    env.report(
      "warning",
      "empty-base-stats",
      "character",
      `\`${baseStatsId}\` grants no stats.`,
    );
  }

  return [
    context(
      "BASE_STAT",
      baseStatsId,
      "character",
      mods.map((mod) => sourceToExact(mod, env.level, env.index.shapeOf(mod.statId), env.balance)),
    ),
  ];
}
