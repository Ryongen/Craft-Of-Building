/**
 * Every stat the game knows, from both of its sources, in one typed table.
 *
 * `mmorpg_stat` carries 800 entries; the mod registers another 353 in Java with no JSON, and
 * those are the ones that decide a build (armor, dodge, resists, penetration, ailments,
 * leech). `tools/port-code-only-stats.mjs` supplies the second half. Anything referenced by a
 * build but present in neither is an error, never a zero.
 *
 * The six serializers matter because five of them are not "a stat" at all — they are rules
 * that run during the calculation. `one_to_other` and `more_x_per_y` add to *other* stats
 * after everything else has resolved; `core_stat` and `bonus_stat_per_effect` grant a bundle
 * of stats proportional to their own value. Their JSON also nests everything under `data` and
 * omits `multiUseType` entirely, so they take the `Stat` defaults.
 */

import type { RegistryEntry, Snapshot } from "@cte2/extractor";
import { ELEMENTS } from "@cte2/schema";

import { CODE_ONLY_SHAPE_OVERRIDES, REGISTRY_FAMILIES } from "./code-only-behaviour.js";
import {
  CODE_ONLY_CLASS_SHAPES,
  CODE_ONLY_STATS,
  CODE_ONLY_TRANSFERS,
} from "./code-only-stats.generated.js";
import { parseSourceMods, type SourceMod } from "./modifier.js";
import {
  isMultiUseType,
  isStatScaling,
  STAT_DEFAULTS,
  type StatShape,
} from "./stat-shape.js";

export const STAT_CATEGORY = "mmorpg_stat";

/** The `ser` values the extractor recognises; anything else fails its run before this point. */
export type StatSer =
  | "data"
  | "one_to_other"
  | "more_x_per_y"
  | "core_stat"
  | "bonus_stat_per_effect"
  | "vanilla_attribute_stat_ser"
  | "marker";

/**
 * One `effect` block off a datapack stat (`DataPackStatEffect`, DataPackStatEffect.java:22-36).
 *
 * The JSON keys are the field names verbatim, and all five are always present across the 603
 * blocks in this pack. A stat may carry several — `DatapackStatBuilder.EffectPlace.FIRST` and
 * `SECOND` emit two entries with different `ifs`, which is how "increased X, and more X while
 * Y" is expressed as one stat.
 */
export type EffectBlock = {
  /** A `StatPriority` GUID: `damage_layers`, `final_damage`, `data_modification`, … */
  order: string;
  side: "Source" | "Target";
  /** `mmorpg_stat_condition` ids, ANDed. */
  ifs: readonly string[];
  /** `mmorpg_stat_effect` ids. */
  effects: readonly string[];
  /** Event GUIDs this block responds to: `on_damage`, `on_spell_stat_calc`, … */
  events: readonly string[];
};

export type StatDef = {
  id: string;
  shape: StatShape;
  /** Where the definition came from. `code` means the generated table. */
  origin: "json" | "code";
  /** Stats this one empties itself into before the first pass. */
  transfersTo: readonly string[];
  /**
   * The stat's `ele` field, as the enum **name** (`Cold`, not `water`). Conditions such as
   * `ele_match_stat` compare it against the event's element.
   */
  element: string;
  /** The `effect` blocks this stat carries. Empty for code-only stats and non-`data` sers. */
  effects: readonly EffectBlock[];
} & StatBehaviour;

export type StatBehaviour =
  | { kind: "plain" }
  /**
   * `AddPerPercentOfOther`: "gain X% of your <adder> as extra <target>", applied after the
   * calculation ends, in `priority` order.
   */
  | { kind: "one_to_other"; adderStat: string; addTo: string; priority: number }
  /** `MoreXPerYOf`: "+X <target> per <perAmount> <adder>", applied last of all. */
  | { kind: "more_x_per_y"; adderStat: string; addTo: string; perAmount: number }
  /** `CoreStat`: strength/dexterity/intelligence, granting `grants` per point. */
  | { kind: "core_stat"; grants: SourceMod[] }
  /** `BonusStatPerEffectStacks`: the same, scaled by how many stacks of `effectId` are up. */
  | { kind: "bonus_stat_per_effect"; effectId: string; grants: SourceMod[] }
  | { kind: "vanilla_attribute"; attributeId: string }
  | { kind: "marker" };

export type StatIndex = {
  get(id: string): StatDef | undefined;
  /** The shape to calculate with. Unknown stats get `Stat`'s defaults; callers report them. */
  shapeOf(id: string): StatShape;
  has(id: string): boolean;
  all(): StatDef[];
  /** Ids present in neither `mmorpg_stat` nor the generated table, collected as they are asked for. */
  readonly unknown: Set<string>;
};

/**
 * The built definition table, cached per snapshot.
 *
 * Building it walks 800 JSON stats, 353 generated ones and a `learn_<spell>` per spell — a few
 * milliseconds, which is nothing for the fixture runner that calls `calculate` once and
 * everything for an editor that calls it on every keystroke. A `Snapshot` is loaded once and
 * never mutated, so keying on object identity is safe.
 *
 * Only the table is shared. {@link statIndex} still returns a fresh wrapper each call, because
 * `unknown` is a mutable accumulator that `reportUnknownStats` drains into a build's
 * diagnostics — sharing it would leak one build's unknown stats into the next build's report.
 */
const DEFS_CACHE = new WeakMap<Snapshot, Map<string, StatDef>>();

export function statIndex(snapshot: Snapshot): StatIndex {
  const defs = DEFS_CACHE.get(snapshot) ?? buildDefs(snapshot);
  DEFS_CACHE.set(snapshot, defs);

  const unknown = new Set<string>();

  return {
    get: (id) => defs.get(id),
    has: (id) => defs.has(id),
    all: () => [...defs.values()],
    unknown,
    shapeOf(id) {
      const def = defs.get(id);
      if (def) return def.shape;
      unknown.add(id);
      return STAT_DEFAULTS;
    },
  };
}

function buildDefs(snapshot: Snapshot): Map<string, StatDef> {
  const defs = new Map<string, StatDef>();

  for (const [id, entry] of Object.entries(snapshot.registries[STAT_CATEGORY] ?? {})) {
    defs.set(id, fromJson(id, entry));
  }

  // The generated table never overwrites a JSON entry: if the pack ships JSON for a stat, the
  // pack wins, which is the same order `BaseDataPackLoader` applies in game.
  for (const [id, shape] of Object.entries(CODE_ONLY_STATS)) {
    if (defs.has(id)) continue;
    defs.set(id, {
      id,
      // The generated table is ported from a 6.4.8 source checkout while the pack runs
      // 6.4.13; three stat classes changed their caps in between. See
      // CODE_ONLY_SHAPE_OVERRIDES — regenerating from matching source empties it.
      shape: CODE_ONLY_SHAPE_OVERRIDES[id] ? { ...shape, ...CODE_ONLY_SHAPE_OVERRIDES[id] } : shape,
      origin: "code",
      transfersTo: CODE_ONLY_TRANSFERS[id] ?? [],
      element: codeOnlyElement(id),
      effects: [],
      kind: "plain",
    });
  }

  // Families the mod generates from a datapack registry — one `learn_<spell>` per spell,
  // including the 143 spells this pack adds, which appear in no list anywhere.
  for (const family of REGISTRY_FAMILIES) {
    const shape = CODE_ONLY_CLASS_SHAPES[family.className];
    if (!shape) continue;
    for (const sourceId of Object.keys(snapshot.registries[family.category] ?? {})) {
      const id = `${family.prefix}${sourceId}`;
      if (defs.has(id)) continue;
      defs.set(id, {
        id,
        shape,
        origin: "code",
        transfersTo: [],
        element: "Physical",
        effects: [],
        kind: "plain",
      });
    }
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function fromJson(id: string, entry: RegistryEntry): StatDef {
  const root = entry.data;
  const ser = typeof root["ser"] === "string" ? (root["ser"] as StatSer) : "data";

  // Only `data` stats are flat objects. The rest wrap their payload, and use `perc`/`scale`
  // where a `data` stat says `is_perc`/`scaling`.
  const nested = ser === "data" ? undefined : asObject(root["data"]);
  const node = nested ?? root;

  const shape: StatShape = {
    base: numberAt(node, "base") ?? STAT_DEFAULTS.base,
    min: numberAt(node, "min") ?? STAT_DEFAULTS.min,
    max: numberAt(node, "max") ?? STAT_DEFAULTS.max,
    softcap: numberAt(node, "softcap") ?? STAT_DEFAULTS.softcap,
    hasSoftcap: node["has_softcap"] === true,
    isPerc: (nested ? node["perc"] : node["is_perc"]) === true,
    scaling: readScaling(nested ? node["scale"] : node["scaling"]),
    multiUseType: readMultiUse(root["multiUseType"]),
  };

  return {
    id,
    shape,
    origin: "json",
    transfersTo: CODE_ONLY_TRANSFERS[id] ?? [],
    element: typeof root["ele"] === "string" ? root["ele"] : "Physical",
    effects: effectBlocksOf(root["effect"]),
    ...behaviourOf(ser, node),
  };
}

/** Reads the `effect` array. Anything malformed is skipped rather than guessed at. */
function effectBlocksOf(raw: unknown): EffectBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: EffectBlock[] = [];
  for (const item of raw) {
    const node = asObject(item);
    if (!node) continue;
    out.push({
      order: typeof node["order"] === "string" ? node["order"] : "",
      side: node["side"] === "Target" ? "Target" : "Source",
      ifs: stringsOf(node["ifs"]),
      effects: stringsOf(node["effects"]),
      events: stringsOf(node["events"]),
    });
  }
  return out;
}

function stringsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The element of a code-only stat, derived from its id.
 *
 * `ElementalStat` builds every variant's GUID out of `element.guidName`, so the element is
 * recoverable from the id — `fire_resist`, `max_water_resist`, `phys_to_lightning`. The longest
 * match wins so `physical` is not mistaken for a missing element on `physical_resist`.
 *
 * This is **informational**. The in-code damage effects each know their own element explicitly
 * (see `damage/code-only-effects.ts`), and `ele_match_stat` only ever runs against datapack
 * stats, which carry a real `ele` field. Nothing calculates from this.
 */
function codeOnlyElement(id: string): string {
  let best: { name: string; length: number } | undefined;
  for (const element of Object.values(ELEMENTS)) {
    const guid = element.guid;
    const matches = id === guid || id.startsWith(`${guid}_`) || id.includes(`_${guid}_`) || id.endsWith(`_${guid}`);
    if (matches && (best === undefined || guid.length > best.length)) {
      best = { name: element.name, length: guid.length };
    }
  }
  return best?.name ?? "Physical";
}

function behaviourOf(ser: StatSer, node: Record<string, unknown>): StatBehaviour {
  switch (ser) {
    case "one_to_other":
      return {
        kind: "one_to_other",
        adderStat: stringAt(node, "adder_stat") ?? "",
        addTo: stringAt(node, "add_to") ?? "",
        // `AddPerPercentOfOther.priority`, "Lower values apply first"
        // (AddPerPercentOfOther.java:20). The pack uses 25, 50, 75 and 100.
        priority: numberAt(node, "priority") ?? 0,
      };
    case "more_x_per_y":
      return {
        kind: "more_x_per_y",
        adderStat: stringAt(node, "adder_stat") ?? "",
        addTo: stringAt(node, "add_to") ?? "",
        perAmount: numberAt(node, "per_amount") ?? 10,
      };
    case "core_stat":
      return { kind: "core_stat", grants: grantsOf(node) };
    case "bonus_stat_per_effect":
      return {
        kind: "bonus_stat_per_effect",
        effectId: stringAt(node, "effect_id") ?? "",
        grants: grantsOf(node),
      };
    case "vanilla_attribute_stat_ser":
      return { kind: "vanilla_attribute", attributeId: stringAt(node, "attribute_id") ?? "" };
    case "marker":
      return { kind: "marker" };
    case "data":
      return { kind: "plain" };
  }
}

function grantsOf(node: Record<string, unknown>): SourceMod[] {
  const data = asObject(node["core_stat_data"]);
  if (!data) return [];
  const stats = data["stats"];
  return Array.isArray(stats) ? parseSourceMods(stats) : [];
}

function readScaling(value: unknown): StatShape["scaling"] {
  return typeof value === "string" && isStatScaling(value) ? value : STAT_DEFAULTS.scaling;
}

function readMultiUse(value: unknown): StatShape["multiUseType"] {
  return typeof value === "string" && isMultiUseType(value)
    ? value
    : STAT_DEFAULTS.multiUseType;
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

function stringAt(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
