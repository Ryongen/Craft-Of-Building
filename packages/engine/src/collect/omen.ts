/**
 * The omen — "Codex" in Craft to Exile 2's own wording — and its conditional set bonus.
 *
 * An omen is the one thing a character wears that grants nothing on its own. What it pays out
 * depends on how much of the *rest* of the loadout satisfies requirements it carries, which is
 * why it is a collector rather than another branch of `collect/gear.ts`: it has to read the
 * gear list to know what it is worth.
 *
 * The game builds it in two halves. `CachedEntityStats.GEAR` recomputes the fill count and the
 * stat context whenever equipment changes —
 *
 *     Load.player(p).cachedStats.omenStats = null;
 *     Load.player(p).recalcOmensFilled();
 *     var omen = Load.player(p).getOmen();
 *     if (omen != null) {
 *         Load.player(p).cachedStats.omenStats = new MiscStatCtx(new OmenSet(omen).getStats(p));
 *     }
 *
 * — and `StatCalculation.getStatContexts` then adds that context alongside gear and base stats:
 *
 *     var omen = Load.player(p).cachedStats.omenStats;
 *     if (omen != null) { statContexts.add(omen); }
 *
 * `MiscStatCtx` is `StatCtxType.MISC`, so an omen's stats enter the container in exactly the
 * same pass as everything else and get no special treatment afterwards. All of the interesting
 * behaviour is in deciding *which* of its stats are live, which is
 * {@link countOmenPieces} and {@link omenBuckets} in `@cte2/schema`.
 *
 * ## Nothing on an omen is rolled
 *
 * `OmenData.getStatPercent` derives a percent from the omen's difficulty rather than rolling
 * one, and that single number is what **everything** on the omen resolves at — its own mods
 * and its corruption affixes alike, because `OmenBlueprint` sets each `AffixData.p` to the
 * same call rather than to a draw from the tier's band. So this collector never reads a roll
 * off the document: {@link omenBuckets} hands it the derived percent for every bucket.
 *
 * ## And it can exceed 100, and is not clamped
 *
 * A mythic omen with heavy requirements reaches 125. `ExactStatData.fromStatModifier` is a
 * bare `min + (max - min) * percent / 100F` with no clamp, so those stats land a quarter above
 * their declared maximum. `rollToExact` does not clamp either, which is deliberate — this is a
 * behaviour to reproduce, not a bug to correct.
 */

import type { BuildDoc } from "@cte2/schema";
import { affix, countOmenPieces, omen, omenBuckets, wornItems } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { parseRolledMods, rollToExact, type ExactMod } from "../modifier.js";

export function collectOmen(env: Env, build: BuildDoc): StatContext[] {
  const setup = build.omen;
  if (setup === undefined) return [];

  const view = omen(env.snapshot, setup.id);
  if (view === undefined) {
    env.report("error", "unknown-omen", "omen.id", `No \`mmorpg_omen\` entry \`${setup.id}\`.`);
    return [];
  }

  // `recalcGears` never looks at the mainhand, and filters on `isUsableBy` — both are handled
  // inside `countOmenPieces`, which is the port of `OmenData.calcPiecesEquipped`.
  const filled = countOmenPieces(env.snapshot, wornItems(env.snapshot, build.gear ?? []), setup, build.character.level);
  const buckets = omenBuckets(env.snapshot, setup);

  const stats: ExactMod[] = [];
  let paidOut = 0;

  for (const bucket of buckets) {
    // `getStats`: every bucket whose threshold the fill count reaches, not just the best one.
    if (filled < bucket.pieces) continue;
    paidOut++;

    if (bucket.mods !== undefined) {
      for (const mod of parseRolledMods(bucket.mods)) {
        // The omen's own level, not the character's — `x.ToExactStat(perc, data.lvl)`.
        stats.push(
          rollToExact(mod, bucket.statPercent, setup.itemLevel, env.index.shapeOf(mod.statId), env.balance),
        );
      }
    }

    if (bucket.affix !== undefined) {
      const affixView = affix(env.snapshot, bucket.affix.affixId);
      if (affixView === undefined) {
        env.report(
          "error",
          "unknown-affix",
          "omen.affixes",
          `No affix \`${bucket.affix.affixId}\` on the omen.`,
        );
        continue;
      }
      // `affix.GetAllStats(data.lvl)` maps over `x.ToExactStat(p, lvl)`, and `p` on an omen's
      // affix is the derived percent the blueprint stored there — not a roll of its own.
      for (const mod of parseRolledMods(affixView.stats)) {
        stats.push(
          rollToExact(
            mod,
            bucket.statPercent,
            setup.itemLevel,
            env.index.shapeOf(mod.statId),
            env.balance,
          ),
        );
      }
    }
  }

  // An omen that pays out nothing is the normal state of a half-assembled set, and silence
  // there would look like the omen was not being read at all.
  if (paidOut === 0) {
    const needed = buckets.reduce((min, b) => Math.min(min, b.pieces), Number.POSITIVE_INFINITY);
    env.report(
      "warning",
      "omen-not-satisfied",
      "omen",
      `\`${setup.id}\` grants nothing: ${filled} qualifying piece(s) equipped, and its cheapest ` +
        `bonus needs ${Number.isFinite(needed) ? needed : "?"}. Note the mainhand never counts ` +
        `(CachedEntityStats.recalcGears collects armour, the offhand and the curios only).`,
    );
  }

  if (stats.length === 0) return [];
  // `MiscStatCtx` is `StatCtxType.MISC`; the omen gets no context type of its own in game.
  return [context("MISC", setup.id, "omen", stats)];
}
