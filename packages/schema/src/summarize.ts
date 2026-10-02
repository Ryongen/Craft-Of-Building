/**
 * What a build *is*, in the terms people search for it by: the ascendancy, the main skill, the
 * supports and Augments, the uniques, the keystones.
 *
 * The build catalogue filters on these, the Discord bot headlines them, and the catalogue's upload
 * endpoint has to compute them the moment a build arrives — in a Cloudflare Worker, which cannot
 * afford to parse a 7 MB snapshot per request. So the summary does not read the snapshot. It reads
 * {@link IndexData}: the handful of lookups a summary needs, cut out of the snapshot once per pack
 * by {@link buildIndexData} and shipped beside it as a few kilobytes of JSON.
 *
 * Everything here is ids, never display names. Names belong to whoever renders them, against the
 * snapshot they already hold; an id is what stays stable when a pack renames something, and what
 * a filter in a URL can be compared against.
 */

import type { Snapshot } from "@cte2/extractor";

import {
  activeSupportLinks,
  isAuraEnabled,
  isSkillEnabled,
  TREE_KEYS,
  type BuildDoc,
  type TreeKey,
} from "./build-doc.js";
import { perk, treeGrid } from "./queries.js";
import { spellSchool, spellSchoolIds } from "./spell-schools.js";
import { stageList } from "./stages.js";

/** Bumped when {@link IndexData}'s shape changes, so a reader can refuse a file it would misread. */
export const INDEX_DATA_VERSION = 1;

/** What a perk is to a summary. Perks that are none of these are not in the index at all. */
export type PerkRole = "start" | "ascendancy" | "keystone";

/** The slice of a snapshot {@link summarizeBuild} needs. See the module note for why it exists. */
export type IndexData = {
  version: typeof INDEX_DATA_VERSION;
  /** `snapshot.meta.mineAndSlashVersion` of the pack it was cut from. */
  mineAndSlashVersion: string;
  /** Per tree, `"row,col"` -> perk id, for every cell whose perk has a {@link PerkRole}. */
  trees: Partial<Record<TreeKey, Record<string, string>>>;
  perkRoles: Record<string, PerkRole>;
  /** Spell-school perk id -> school id, as `schoolOfPerk` answers it. */
  schoolOfPerk: Record<string, string>;
};

export type BuildSummary = {
  level: number;
  /** The allocated ascendancy entry perk — what `character.ascendancy` holds. */
  ascendancy?: string;
  /** The class start the talent tree grows from. */
  start?: string;
  /** Spell schools with points in them, sorted. */
  schools: string[];
  /**
   * The skill the build is about: the one marked main, else the first enabled one.
   *
   * The engine's own answer differs in one case — it skips a leading skill that deals no damage
   * — and whoever has the engine at hand should pass its answer in instead. See `summarizeBuild`.
   */
  mainSkill?: string;
  /** Enabled skills, in bar order. */
  skills: string[];
  /** Support gems linked into an enabled skill, each once. */
  supports: string[];
  /** Enabled Augments (`auras`). */
  augments: string[];
  /** Unique gear and unique jewels, each once. */
  uniques: string[];
  runewords: string[];
  /** Base types of the worn gear, each once. */
  bases: string[];
  omen?: string;
  /** Major perks allocated in any tree. */
  keystones: string[];
  /** How many stages the build was planned in — 1 for a build with no stage list. */
  stageCount: number;
};

/** The facet kinds the catalogue filters on, in the order its sidebar shows them. */
export const FACET_KINDS = [
  "ascendancy",
  "skill",
  "support",
  "augment",
  "unique",
  "keystone",
  "runeword",
  "omen",
  "school",
  "start",
  "base",
] as const;
export type FacetKind = (typeof FACET_KINDS)[number];
export type Facet = { kind: FacetKind; value: string };

/** Cut the index out of a snapshot. Run once per pack, by whatever publishes the pack's data. */
export function buildIndexData(snapshot: Snapshot): IndexData {
  const trees: IndexData["trees"] = {};
  const perkRoles: Record<string, PerkRole> = {};

  for (const key of Object.keys(TREE_KEYS) as TreeKey[]) {
    const grid = treeGrid(snapshot, TREE_KEYS[key]);
    if (grid === undefined) continue;
    const cells: Record<string, string> = {};
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const perkId = grid.cellAt(row, col)?.perkId;
        if (perkId === undefined) continue;
        const role = roleOf(snapshot, perkId);
        if (role === undefined) continue;
        cells[`${row},${col}`] = perkId;
        perkRoles[perkId] = role;
      }
    }
    trees[key] = cells;
  }

  const schoolOfPerk: Record<string, string> = {};
  for (const schoolId of spellSchoolIds(snapshot)) {
    for (const perkId of spellSchool(snapshot, schoolId)?.perks.keys() ?? []) {
      // First school wins, as `schoolOfPerk` (and `Perk.getSpellSchool`) has it.
      schoolOfPerk[perkId] ??= schoolId;
    }
  }

  return {
    version: INDEX_DATA_VERSION,
    mineAndSlashVersion: snapshot.meta.mineAndSlashVersion,
    trees,
    perkRoles,
    schoolOfPerk,
  };
}

/**
 * Summarise the build's **live** fields — the stage it is showing. To summarise another stage,
 * pass `stageDoc(doc, stage)`.
 *
 * `mainSkill` overrides the main-skill guess with an answer from the engine
 * (`deriveBuild(...).dps?.spellId`) when the caller has one.
 */
export function summarizeBuild(
  doc: BuildDoc,
  index: IndexData,
  options: { mainSkill?: string } = {},
): BuildSummary {
  let ascendancy: string | undefined;
  let start: string | undefined;
  const keystones = new Set<string>();
  for (const key of Object.keys(TREE_KEYS) as TreeKey[]) {
    const cells = index.trees[key] ?? {};
    for (const [row, col] of doc.tree?.[key] ?? []) {
      const perkId = cells[`${row},${col}`];
      if (perkId === undefined) continue;
      const role = index.perkRoles[perkId];
      if (role === "ascendancy") ascendancy ??= perkId;
      else if (role === "start" && key === "talents") start ??= perkId;
      else if (role === "keystone") keystones.add(perkId);
    }
  }

  const schools = new Set<string>();
  for (const [perkId, level] of Object.entries(doc.character.schools ?? {})) {
    if (!Number.isFinite(level) || level < 1) continue;
    const school = index.schoolOfPerk[perkId];
    if (school !== undefined) schools.add(school);
  }

  const enabled = (doc.skills ?? []).filter(isSkillEnabled);
  const supports = new Set<string>();
  for (const skill of enabled) for (const link of activeSupportLinks(skill)) supports.add(link.id);

  const gear = doc.gear ?? [];
  const uniques = new Set<string>();
  const runewords = new Set<string>();
  const bases = new Set<string>();
  for (const item of gear) {
    bases.add(item.base);
    if (item.unique !== undefined) uniques.add(item.unique);
    if (item.runeword !== undefined) runewords.add(item.runeword);
  }
  for (const jewel of doc.jewels ?? []) if (jewel.unique !== undefined) uniques.add(jewel.unique.id);

  const mainSkill = options.mainSkill ?? (enabled.find((s) => s.main === true) ?? enabled[0])?.spellId;
  // The tree says which ascendancy is allocated; a capture that predates the field, or a hand
  // edit, can disagree with `character.ascendancy`, and the allocation is what the game uses.
  const chosen = ascendancy ?? doc.character.ascendancy;

  return {
    level: doc.character.level,
    ...(chosen === undefined ? {} : { ascendancy: chosen }),
    ...(start === undefined ? {} : { start }),
    schools: [...schools].sort(),
    ...(mainSkill === undefined ? {} : { mainSkill }),
    skills: unique(enabled.map((s) => s.spellId)),
    supports: [...supports].sort(),
    augments: unique((doc.auras ?? []).filter(isAuraEnabled).map((a) => a.id)),
    uniques: [...uniques].sort(),
    runewords: [...runewords].sort(),
    bases: [...bases].sort(),
    ...(doc.omen === undefined ? {} : { omen: doc.omen.id }),
    keystones: [...keystones].sort(),
    stageCount: stageList(doc).length,
  };
}

/** The summary as rows of `(kind, value)` — one per thing a filter can match. */
export function summaryFacets(summary: BuildSummary): Facet[] {
  const out: Facet[] = [];
  const add = (kind: FacetKind, values: readonly string[]): void => {
    for (const value of values) out.push({ kind, value });
  };
  if (summary.ascendancy !== undefined) add("ascendancy", [summary.ascendancy]);
  add("skill", summary.skills);
  add("support", summary.supports);
  add("augment", summary.augments);
  add("unique", summary.uniques);
  add("keystone", summary.keystones);
  add("runeword", summary.runewords);
  if (summary.omen !== undefined) add("omen", [summary.omen]);
  add("school", summary.schools);
  if (summary.start !== undefined) add("start", [summary.start]);
  add("base", summary.bases);
  return out;
}

// ---------------------------------------------------------------------------

function roleOf(snapshot: Snapshot, perkId: string): PerkRole | undefined {
  const view = perk(snapshot, perkId);
  if (view === undefined) return undefined;
  if (view.oneKind === "ascendancy") return "ascendancy";
  if (view.type === "START") return "start";
  if (view.type === "MAJOR") return "keystone";
  return undefined;
}

/** First occurrence of each, in order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
