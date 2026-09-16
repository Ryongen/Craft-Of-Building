/**
 * Allocated tree nodes.
 *
 * A build document records allocations as `[row, col]` coordinates rather than perk ids,
 * because the same perk id repeats at many positions in a grid and the coordinate is what
 * identifies the allocation. `treeGrid` from `@cte2/schema` already resolves a coordinate to
 * a cell, so this only has to read the perk's stats.
 *
 * Perk stats are `{ type, stat, v1, scale_to_lvl }` — exact values, not rolls. All five perk
 * types (`STAT`, `SPECIAL`, `MAJOR`, `ASC`, `START`) carry them the same way; `MAJOR` is not a
 * special case in the data, it is just where the negative MOREs live ("acrobat": +30 dodge
 * chance, -20% MORE armor, -20% MORE dodge).
 */

import type { BuildDoc, TreeCoord, TreeKey } from "@cte2/schema";
import { CATEGORY, TREE_KEYS, entry, treeGrid } from "@cte2/schema";

import { context, type CtxType, type Env, type StatContext } from "../context.js";
import { parseSourceMods, sourceToExact, type ExactMod } from "../modifier.js";

const CTX_FOR_TREE: Record<TreeKey, CtxType> = {
  talents: "TALENT",
  ascendancy: "ASCENDANCY",
  atlas: "ATLAS",
};

export function collectPerks(env: Env, build: BuildDoc): StatContext[] {
  const out: StatContext[] = [];
  const tree = build.tree;
  if (!tree) return out;

  for (const key of Object.keys(TREE_KEYS) as TreeKey[]) {
    const coords = tree[key];
    if (!coords || coords.length === 0) continue;

    const grid = treeGrid(env.snapshot, TREE_KEYS[key]);
    if (!grid) {
      env.report("error", "unknown-tree", `tree.${key}`, `No tree \`${TREE_KEYS[key]}\`.`);
      continue;
    }

    coords.forEach((coord, i) => {
      const path = `tree.${key}[${i}]`;
      const perkId = perkAt(env, grid, coord, path);
      if (perkId === undefined) return;

      const data = entry(env.snapshot, CATEGORY.perk, perkId)?.data;
      if (!data) {
        // `TalentTree.CalcData.getPerk` falls back to `UnknownStat` rather than failing, so
        // the node exists, costs a point and grants nothing. A pack bug to report, not an
        // error in the document — the validator grades it the same way.
        env.report(
          "warning",
          "unknown-perk",
          path,
          `Cell resolves to \`${perkId}\`, which is in no ${CATEGORY.perk} entry. It grants nothing.`,
        );
        return;
      }

      const raw = data["stats"];
      const stats: ExactMod[] = (Array.isArray(raw) ? parseSourceMods(raw) : []).map((mod) =>
        sourceToExact(mod, env.level, env.index.shapeOf(mod.statId), env.balance),
      );
      out.push(context(CTX_FOR_TREE[key], perkId, path, stats));
    });
  }

  return out;
}

function perkAt(
  env: Env,
  grid: NonNullable<ReturnType<typeof treeGrid>>,
  coord: TreeCoord,
  path: string,
): string | undefined {
  const [row, col] = coord;
  const cell = grid.cellAt(row, col);
  if (!cell) {
    env.report("error", "coord-out-of-bounds", path, `[${row}, ${col}] is outside ${grid.id}.`);
    return undefined;
  }
  if (cell.kind !== "perk" || cell.perkId === undefined) {
    // Connectors and the centre are drawing glyphs, not nodes. The validator already says so;
    // saying it again here would double every message, so this is silent by design.
    return undefined;
  }
  return cell.perkId;
}
