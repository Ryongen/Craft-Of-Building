/**
 * What a character needs before a piece of gear does anything.
 *
 * `GearItemData.canPlayerWear` is two checks and a short one:
 *
 *     if (this.getLevel() > data.getLevel()) { return false; }
 *     if (!getRequirement().meetsReq(this.getLevel(), data)) { return false; }
 *     return true;
 *
 * — so an item gates on the **character's** level against the **item's**, and then on a
 * `StatRequirement` read off the base gear type. `meetsReq` compares the requirement against
 * `data.getUnit().getCalculatedStat(x).getValue()`: the finished sheet, not a base attribute,
 * which is why "+20 Strength" from a ring can be what lets you wear the axe.
 *
 * ## The two maps scale differently, and only one of them is used in this pack
 *
 *     int getScalingReq(Stat stat, int lvl)    = (int)(STAT_REQ.scale(scaling_req[guid], lvl) * statReqMulti)
 *     int getNonScalingReq(Stat stat, int lvl) = (int)(base_req[guid] * statReqMulti)
 *
 * `STAT_REQ.scale(v, lvl)` is `v * (base_scaling + per_level_scaling * (lvl - 1))`, and this
 * pack's `STAT_REQ_SCALING` is `2 / 2 / capped`, which makes the multiplier exactly `2 * lvl`.
 * So an axe's declared `strength: 0.4` is 0.8 strength at item level 1 — truncated to 0, i.e.
 * no requirement at all — and 80 at item level 100. Every one of the 43 bases in this pack
 * declares only `scaling_req`; `base_req` is read anyway, because a datapack may fill it.
 *
 * The level the requirement is evaluated at is the **item's**, not the character's. A level-40
 * axe asks for 32 strength whoever picks it up.
 *
 * ## Truncation is load-bearing
 *
 * Both getters cast to `int`, so 79.6 is 79 and the sheet only has to reach 79. Rounding
 * instead would refuse items the game hands over.
 *
 * ## `statReqMulti` is a server config, not pack data
 *
 * `CompatConfig.get().statReqMulti()` is `STAT_REQUIREMENTS_MULTIPLIER` in
 * `mine_and_slash-server.toml`, so no snapshot can answer it. Craft to Exile 2 runs Original
 * mode, whose preset sets it to 1 (`CompatConfigPreset.ORIGINAL_MODE`), and that is the value
 * used here — it is a parameter rather than a constant so a server that retuned it can say so.
 */

import type { Snapshot } from "@cte2/extractor";
import { baseGearType, type Item } from "@cte2/schema";

import { balance } from "./balance.js";

/**
 * `STAT_REQUIREMENTS_MULTIPLIER` under Original mode.
 *
 * Lite mode sets 0.1; Original and Compatible both set 1. Craft to Exile 2 is Original.
 */
export const DEFAULT_STAT_REQ_MULTI = 1;

/** One line of a `StatRequirement`, resolved to the number the sheet has to reach. */
export type GearRequirement = {
  statId: string;
  /** The already-truncated integer `meetsReq` compares against. */
  required: number;
  /** `scaling_req` went through the level curve; `base_req` did not. */
  scaled: boolean;
};

export type RequirementOptions = {
  balanceId?: string;
  /** `CompatConfig.get().statReqMulti()`. Defaults to {@link DEFAULT_STAT_REQ_MULTI}. */
  statReqMulti?: number;
};

/**
 * What one gear base demands at an item level, in the order the game reads it: scaling first,
 * then flat. A requirement that truncates to zero is dropped — `GetTooltipString` skips
 * `num > 0` too, so a line the game never prints is not one to print here.
 */
export function gearRequirements(
  snapshot: Snapshot,
  baseId: string,
  itemLevel: number,
  options: RequirementOptions = {},
): GearRequirement[] {
  const base = baseGearType(snapshot, baseId);
  if (base === undefined) return [];

  const multi = options.statReqMulti ?? DEFAULT_STAT_REQ_MULTI;
  const curve = balance(snapshot, options.balanceId).multiFor("STAT_REQ", itemLevel);
  const out: GearRequirement[] = [];

  for (const [statId, declared] of Object.entries(base.req.scalingReq)) {
    const required = Math.trunc(declared * curve * multi);
    if (required > 0) out.push({ statId, required, scaled: true });
  }
  for (const [statId, declared] of Object.entries(base.req.baseReq)) {
    const required = Math.trunc(declared * multi);
    if (required > 0) out.push({ statId, required, scaled: false });
  }
  return out;
}

/** A requirement with the character's own number beside it. */
export type RequirementCheck = GearRequirement & {
  have: number;
  met: boolean;
};

/**
 * Every reason this item would not go on, checked against a finished sheet.
 *
 * Deliberately *reports* rather than removes: the game refuses the equip, so an unwearable item
 * never reaches the stat calculation at all — but a planner whose answer to "what if I wore
 * this" is to silently drop the item is answering a different question. The stats stay in;
 * the shortfall is named.
 */
export function checkRequirements(
  snapshot: Snapshot,
  item: Item,
  sheet: ReadonlyMap<string, { value: number }>,
  options: RequirementOptions = {},
): RequirementCheck[] {
  return gearRequirements(snapshot, item.base, item.itemLevel, options).map((req) => {
    const have = sheet.get(req.statId)?.value ?? 0;
    return { ...req, have, met: have >= req.required };
  });
}
