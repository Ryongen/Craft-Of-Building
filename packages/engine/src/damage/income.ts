/**
 * What your hits and skills put back into your pools, per second — the income beside regeneration.
 *
 * Regeneration is a property of the sheet and `resources.ts` answers it with no skill at all.
 * Everything here needs one, and comes in two kinds the game treats differently:
 *
 *   - **leech** — leech stats, on-hit and on-basic-hit. Banked per pool and paid out at
 *     `<r>_leech_cap`% of the pool a second, so every source shares one cap;
 *   - **restores** — a skill's own `restore_*` acts (Astral Totem, Refresh, Glacial Mend). A
 *     direct heal: it lands at once and nothing caps it.
 *
 * Both depend on what you are pressing, so they are taken from the figures the rest of the
 * planner already shows:
 *
 *   - the **Full DPS rotation** when any skill is ticked into it, each skill at its presses per
 *     pass and with the pass's shared summon limit applied — otherwise the **main skill** at its
 *     own cast rate;
 *   - the **procs** those casts set off, at their own rate;
 *   - plus the **swing** and its procs, on vanilla's clock beside the casts, the way Total DPS
 *     adds them.
 */

import type { BasicAttack } from "./basic-attack.js";
import { pressesPerPass, type DpsResult, type FullDpsResult } from "./dps.js";
import type { Proc } from "./procs.js";
import { RESOURCES, type ResourceId } from "./resources.js";

/** Where one share of a pool's income comes from. */
export type IncomeSource = {
  kind: "leech" | "restore";
  /** The skill that produced it, or the procced spell. Empty for a basic attack. */
  spellId: string;
  via: "skill" | "proc" | "swing";
  /** The leech stat, for a leech share. Its breakdown is what to open next. */
  statId?: string;
  /** Per second, before the leech cap. */
  perSecond: number;
};

export type PoolIncome = {
  resource: ResourceId;
  /** Leech and on-hit entering the bank, from every source, before the cap. */
  leechGenerated: number;
  /** `<r>_leech_cap`% of the pool — the most the bank pays out a second. */
  leechCap: number;
  /** `min(leechGenerated, leechCap)`. */
  leech: number;
  /** The part of {@link leechGenerated} that came from swinging. */
  fromSwings: number;
  /** The skills' own `restore_*` acts — direct heals, not leech, and never capped. */
  restored: number;
  /** `leech + restored` — what to add to regeneration. */
  total: number;
  sources: IncomeSource[];
};

export type SkillIncome = {
  /** Which casts were counted: the ticked rotation, the main skill, or none. */
  basis: "rotation" | "main" | "none";
  /** True when the swing's own leech is in the figure. */
  swings: boolean;
  byResource: PoolIncome[];
};

export type SkillIncomeInput = {
  fullDps?: FullDpsResult | undefined;
  dps?: DpsResult | undefined;
  basic?: BasicAttack | undefined;
  /**
   * The character sheet, for `<r>_leech_cap` and the pool it is a share of. Without it the cap is
   * read off whichever leech row reported one, and a pool only a proc leeches into has none.
   */
  sheet?: ReadonlyMap<string, { value: number }>;
};

/** A leech row as a result carries it: the pool, its seeds by stat, and what one cast makes. */
type LeechRow = DpsResult["cost"]["leech"]["byResource"][number];

export function skillIncome(input: SkillIncomeInput): SkillIncome {
  const sources = new Map<ResourceId, IncomeSource[]>();
  const caps = new Map<ResourceId, number>();
  const push = (resource: string, source: IncomeSource): void => {
    if (!(RESOURCES as readonly string[]).includes(resource) || !(source.perSecond > 0)) return;
    const id = resource as ResourceId;
    const list = sources.get(id) ?? [];
    const same = list.find(
      (s) => s.kind === source.kind && s.spellId === source.spellId && s.via === source.via && s.statId === source.statId,
    );
    if (same) same.perSecond += source.perSecond;
    else list.push({ ...source });
    sources.set(id, list);
  };

  /** One leech row's generated rate, split across the stats that seeded it. */
  const leechOf = (row: LeechRow, spellId: string, via: IncomeSource["via"], generated: number): void => {
    caps.set(row.resource, row.capPerSecond);
    const seed = row.sources.reduce((sum, s) => sum + s.perSecond, 0);
    for (const stat of row.sources) {
      const share = seed > 0 ? stat.perSecond / seed : 1 / row.sources.length;
      push(row.resource, { kind: "leech", spellId, via, statId: stat.statId, perSecond: generated * share });
    }
  };

  const procsOf = (procs: readonly Proc[], via: "proc"): void => {
    for (const proc of procs) {
      if (!(proc.perSecond > 0)) continue;
      for (const r of proc.restoresPerProc ?? []) {
        push(r.resource, { kind: "restore", spellId: proc.spellId, via, perSecond: r.amount * proc.perSecond });
      }
      for (const l of proc.leechPerProc ?? []) {
        push(l.resource, { kind: "leech", spellId: proc.spellId, via, perSecond: l.amount * proc.perSecond });
      }
    }
  };

  const rotation = input.fullDps;
  const ticked = rotation !== undefined && rotation.skills.length > 0;
  let basis: SkillIncome["basis"] = "none";

  if (ticked) {
    basis = "rotation";
    const seconds = rotation.rotationSeconds;
    for (const entry of rotation.skills) {
      if (seconds <= 0) break;
      const { cost, rate } = entry.result;
      const castsPerSecond = (rate.castsPerCycle * pressesPerPass(entry)) / seconds;
      const limit = entry.limitShare;
      const spellId = entry.skill.spellId;
      for (const row of cost.leech.byResource) {
        leechOf(row, spellId, "skill", row.generatedPerCast * castsPerSecond * (limit?.damageShare ?? 1));
      }
      for (const row of cost.restores.byResource) {
        for (const source of row.sources) {
          const alive = limit !== undefined && source.limitGroup === limit.group ? limit.aliveShare : 1;
          push(row.resource, {
            kind: "restore",
            spellId,
            via: "skill",
            perSecond: source.perFiring * source.firingsPerCast * castsPerSecond * alive,
          });
        }
      }
    }
    procsOf(rotation.procs, "proc");
  } else if (input.dps !== undefined) {
    basis = "main";
    const spellId = input.dps.spellId;
    for (const row of input.dps.cost.leech.byResource) leechOf(row, spellId, "skill", row.generatedPerSecond);
    for (const row of input.dps.cost.restores.byResource) {
      push(row.resource, { kind: "restore", spellId, via: "skill", perSecond: row.perSecond });
    }
    procsOf(input.dps.procs, "proc");
  }

  const swings = input.basic !== undefined && !input.basic.untimed;
  if (swings) {
    for (const row of input.basic!.leech.byResource) leechOf(row, "", "swing", row.generatedPerSecond);
    procsOf(input.basic!.procs, "proc");
  }

  const byResource: PoolIncome[] = [];
  for (const resource of RESOURCES) {
    const list = sources.get(resource);
    if (list === undefined || list.length === 0) continue;
    const sum = (pick: (s: IncomeSource) => boolean): number =>
      list.filter(pick).reduce((total, s) => total + s.perSecond, 0);
    const leechGenerated = sum((s) => s.kind === "leech");
    const restored = sum((s) => s.kind === "restore");
    const leechCap =
      input.sheet === undefined
        ? (caps.get(resource) ?? 0)
        : ((input.sheet.get(`${resource}_leech_cap`)?.value ?? 0) / 100) * (input.sheet.get(resource)?.value ?? 0);
    const leech = Math.min(leechGenerated, leechCap);
    byResource.push({
      resource,
      leechGenerated,
      leechCap,
      leech,
      fromSwings: sum((s) => s.kind === "leech" && s.via === "swing"),
      restored,
      total: leech + restored,
      sources: list.sort((a, b) => b.perSecond - a.perSecond),
    });
  }
  return { basis, swings: swings && byResource.some((r) => r.fromSwings > 0), byResource };
}
