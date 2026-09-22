/**
 * `mmorpg_sets` — Diablo-style gear sets: wear N of the listed uniques, get the tiered bonuses.
 *
 * This is the one gear contribution that cannot live with the item that produced it, and the
 * game says so at the call site:
 *
 *     // diablo style set bonuses. this can't live in GearData like the other gear stats do,
 *     // because a set bonus depends on the whole equipped combination, not on one item.
 *     static List<StatContext> addItemSetStats(List<GearData> gears) {
 *         for (EquippedSets equipped : EquippedSets.of(gears)) {
 *             List<ExactStatData> stats = new ArrayList<>();
 *             for (SetBonus bonus : equipped.set.getSortedBonuses()) {
 *                 if (equipped.isActive(bonus)) { stats.addAll(bonus.getStats(equipped.avgLevel)); }
 *             }
 *             if (!stats.isEmpty()) {
 *                 ctxs.add(new SimpleStatCtx(StatContext.StatCtxType.ITEM_SET, stats));
 *             }
 *         }
 *     }
 *
 * — StatCalculation.java:300-317. Four rules, and each is one line of the above:
 *
 *  - **Membership is by unique id**, listed on the set rather than on the unique. `ItemSet.uniques`
 *    is the list and `ofUnique` inverts it; a piece that is not a unique counts towards nothing.
 *  - **Pieces are deduped.** `Counter.add` does `putIfAbsent(uniqueId, lvl)` into a map keyed by
 *    unique id, so two Nagelrings are one piece. Without that, one ring in both slots would
 *    complete a two-piece set on its own.
 *  - **Tiers are cumulative.** `isActive` is `pieces >= bonus.pieces` and every bonus is tested,
 *    so a four-piece set grants its 2-piece tier as well as its 4-piece one.
 *  - **The stats are fixed, not rolled, and scale to the set's own level.**
 *    `bonus.getStats(lvl)` is `ToExactStat(100, lvl)` — `bipush 100` in the jar — and `lvl` is the
 *    **integer average item level of the equipped pieces**, not the character's level.
 *
 * Confirmed present in `Mine_and_Slash-1.20.1-6.4.13.jar` rather than only in the fork checkout:
 * `ItemSet`, `EquippedSets`, `SetBonus` and `StatCalculation.addItemSetStats` are all in it.
 *
 * What is deliberately *not* reproduced is `EquippedSets.of(Player)`'s usability filter — broken
 * items, and pieces above the character's level. The server path this ports takes its list from
 * the gear cache, which has already dropped both, and a build document has no durability; the
 * level requirement is `requirements.ts`'s job and it reports it there rather than silently
 * dropping the piece here.
 */

import type { BuildDoc, Item } from "@cte2/schema";
import { CATEGORY, wornItems } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { parseRolledMods, rollToExact, type ExactMod } from "../modifier.js";

/** One tier of a set: "wear this many pieces, get these stats". */
type SetBonus = { pieces: number; stats: Record<string, unknown>[] };

/** A set as the registry declares it. */
type ItemSet = { id: string; uniques: string[]; bonuses: SetBonus[] };

/** What the character is wearing of one set, and at what level its bonuses resolve. */
export type EquippedSet = {
  setId: string;
  /** Distinct member uniques equipped — the numerator of the `(2/4)` the game prints. */
  pieces: number;
  /** `ItemSet.getSetSize()`, which is `uniques.size()` rather than a stored number. */
  setSize: number;
  /** `total / pieces.size()`, integer division, over the equipped pieces' item levels. */
  averageLevel: number;
  /** Which tiers are live, lowest first. */
  activeTiers: number[];
};

function readSets(env: Env): ItemSet[] {
  const reg = env.snapshot.registries[CATEGORY.itemSet] ?? {};
  const out: ItemSet[] = [];
  for (const [id, node] of Object.entries(reg)) {
    const d = (node as { data?: Record<string, unknown> }).data;
    if (!d) continue;
    const uniques = Array.isArray(d["uniques"]) ? d["uniques"].filter((u): u is string => typeof u === "string") : [];
    const bonuses: SetBonus[] = [];
    for (const raw of Array.isArray(d["bonuses"]) ? d["bonuses"] : []) {
      if (raw === null || typeof raw !== "object") continue;
      const node2 = raw as Record<string, unknown>;
      const pieces = typeof node2["pieces"] === "number" ? Math.trunc(node2["pieces"]) : 2;
      const stats = Array.isArray(node2["stats"])
        ? node2["stats"].filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
        : [];
      bonuses.push({ pieces, stats });
    }
    out.push({ id, uniques, bonuses });
  }
  return out;
}

/**
 * What the build is wearing of every set it touches, whether or not a tier is reached.
 *
 * Returned for the whole list rather than only the paying ones so the UI can show `(1/2)` on a
 * half-finished set — which is the number a player is actually planning against.
 */
export function equippedSets(env: Env, gear: readonly Item[]): EquippedSet[] {
  const sets = readSets(env);
  if (sets.length === 0) return [];

  // `ItemSet.ofUnique`'s lazy index, `map.put(unique, set)` — a plain overwrite, so a unique
  // listed in two sets belongs to whichever was registered last rather than to both. No unique in
  // this pack is (31 distinct members across the 10 sets), but the rule is the game's and a pack
  // that changed that should behave the way the game would rather than paying out twice.
  const setOfUnique = new Map<string, ItemSet>();
  for (const set of sets) for (const unique of set.uniques) setOfUnique.set(unique, set);

  // set id -> (unique id -> item level). `putIfAbsent`, so the first copy of a piece wins and a
  // second copy of the same unique adds nothing.
  const found = new Map<string, Map<string, number>>();
  for (const item of gear) {
    const uniqueId = item.unique;
    if (uniqueId === undefined || uniqueId === "") continue;
    const set = setOfUnique.get(uniqueId);
    if (!set) continue;
    const pieces = found.get(set.id) ?? new Map<string, number>();
    if (!pieces.has(uniqueId)) pieces.set(uniqueId, item.itemLevel);
    found.set(set.id, pieces);
  }

  const out: EquippedSet[] = [];
  for (const set of sets) {
    const pieces = found.get(set.id);
    if (!pieces || pieces.size === 0) continue;
    let total = 0;
    for (const lvl of pieces.values()) total += lvl;
    // `total / pieces.size()` on ints — Java's integer division, so it truncates.
    const averageLevel = Math.trunc(total / pieces.size);
    out.push({
      setId: set.id,
      pieces: pieces.size,
      setSize: set.uniques.length,
      averageLevel,
      activeTiers: set.bonuses
        .map((b) => b.pieces)
        .filter((n) => pieces.size >= n)
        .sort((a, b) => a - b),
    });
  }
  return out;
}

export function collectItemSets(env: Env, build: BuildDoc): StatContext[] {
  const sets = readSets(env);
  if (sets.length === 0) return [];
  const worn = new Map(equippedSets(env, wornItems(env.snapshot, build.gear ?? [])).map((e) => [e.setId, e]));
  if (worn.size === 0) return [];

  const out: StatContext[] = [];
  for (const set of sets) {
    const equipped = worn.get(set.id);
    if (!equipped) continue;

    const mods: ExactMod[] = [];
    // `getSortedBonuses()` sorts by `pieces` before the loop. Order does not change the sum, but
    // it is what the game does and it is what makes the tier list read in the right order.
    const sorted = [...set.bonuses].sort((a, b) => a.pieces - b.pieces);
    for (const bonus of sorted) {
      if (equipped.pieces < bonus.pieces) continue;
      for (const mod of parseRolledMods(bonus.stats)) {
        mods.push(
          rollToExact(mod, 100, equipped.averageLevel, env.index.shapeOf(mod.statId), env.balance),
        );
      }
    }

    // `if (!stats.isEmpty())` — a set whose reached tiers carry nothing produces no context at
    // all rather than an empty one.
    if (mods.length === 0) continue;
    out.push(context("ITEM_SET", set.id, "gear", mods));
  }
  return out;
}
