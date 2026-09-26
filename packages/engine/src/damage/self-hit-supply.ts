/**
 * How often a skill gets to fire its gated half when the resource comes from hitting yourself.
 *
 * `dark_pact` is the shape this exists for. It gates its big hit on three `sacrifice` stacks and
 * spends them, and nothing on the bar grants `sacrifice`: it comes from `sacrifice_when_hit`, a
 * Target-side `on_damage` stat, so every hit *you take* rolls for a stack. The Sanguimancer takes
 * a lot of them from itself:
 *
 *     abyssal_aura (effect)   damage  self  allow_self_damage  x_ticks_condition tick_rate 10
 *     dark_pact    on_cast    damage  self  allow_self_damage  dark_pact_self
 *
 * — two hits a second from the aura for as long as it is up, and one more per Dark Pact cast.
 *
 * The combo planner cannot price this. It pictures a resource as something a press hands over,
 * and a stat that fires when you are hit is not a press, so the full pass read "cannot be timed"
 * and every cast was priced as the plain one. Nor is it a choice the player makes: Dark Pact
 * fires whichever branch the stacks say, so the honest figure is a blend: a share of the casts
 * land the gated hit and the rest land the plain one.
 *
 *     share = min(1, stacks supplied per second / (stacks spent per cast × casts per second))
 *
 * **A cast's own self-hit feeds the next cast, never itself.** `dark_pact` lists its plain hit,
 * then its self-hit, then its gated hit, so a cast at two stacks might land both hits if the
 * stack from its own self-hit is in place before the gate is read. Nobody has confirmed that
 * from a damage log, so the steady state here assumes it does not.
 *
 * Other skills on the bar that hit you, other skills that also spend the resource
 * (`curse_of_damnation` takes three `sacrifice` on expiry), and enemy hits are all left out.
 */

import type { Snapshot } from "@cte2/extractor";
import { CATEGORY, entry } from "@cte2/schema";

import type { Sheet } from "./ctx.js";
import type { EffectState } from "./effect-state.js";
import { TICKS_PER_SECOND } from "./spell-calc.js";

export type SelfHitSupply = {
  effectId: string;
  /** Chance one hit you take grants a stack, summed over the granting stats and capped at 1. */
  chance: number;
  /** The stats that grant it when you are hit. */
  fromStats: string[];
  /** Self-hits per second from effects you hold, and which effects they come from. */
  periodicHitsPerSecond: number;
  fromEffects: string[];
  /** Self-hits one cast of the skill deals you, landing after its gated hits. */
  ownHitsPerCast: number;
  /** Stacks one gated cast takes off you. */
  spentPerCast: number;
};

/**
 * What hitting yourself supplies of `effectId`, or undefined when nothing does.
 *
 * `sheet` is the character's, for the chance: `sacrifice_when_hit` comes partly from
 * `blasphemous_ritual`, an effect, so the sheet has to be the one settled with effects up.
 */
export function selfHitSupply(
  snapshot: Snapshot,
  spell: Record<string, unknown>,
  sheet: Sheet,
  effects: EffectState,
  effectId: string,
): SelfHitSupply | undefined {
  const option = effects.options.find((o) => o.id === effectId);
  if (option === undefined) return undefined;

  const fromStats: string[] = [];
  let chance = 0;
  for (const grant of option.grantedBy) {
    if (grant.kind !== "stat" || grant.side !== "Target" || grant.event !== "on_damage") continue;
    if (fromStats.includes(grant.statId)) continue;
    const value = sheet.get(grant.statId)?.value ?? 0;
    if (value <= 0) continue;
    fromStats.push(grant.statId);
    chance += rolls(snapshot, grant.statId) ? Math.min(100, value) / 100 : 1;
  }
  chance = Math.min(1, chance);
  if (chance <= 0) return undefined;

  let periodicHitsPerSecond = 0;
  const fromEffects: string[] = [];
  for (const held of effects.options) {
    if (held.side !== "caster" || held.stacks <= 0) continue;
    const data = entry(snapshot, CATEGORY.exileEffect, held.id)?.data;
    const groups = asObject(asObject(asObject(data)?.["spell"])?.["entity_components"]) ?? {};
    let perSecond = 0;
    for (const parts of Object.values(groups)) {
      for (const part of asArray(parts).map(asObject)) {
        if (part === undefined || !hitsSelf(part)) continue;
        const ticks = tickRate(part);
        if (ticks !== undefined && ticks > 0) perSecond += TICKS_PER_SECOND / ticks;
      }
    }
    if (perSecond > 0) {
      periodicHitsPerSecond += perSecond;
      fromEffects.push(held.id);
    }
  }

  const attached = asObject(spell["attached"]) ?? {};
  let ownHitsPerCast = 0;
  for (const part of asArray(attached["on_cast"]).map(asObject)) {
    if (part === undefined || !hitsSelf(part)) continue;
    // Only an unconditional self-hit is one every cast makes.
    const gated = asArray(part["ifs"]).some((raw) => stringAt(asObject(raw), "type") !== "on_spell_cast");
    if (!gated) ownHitsPerCast += 1;
  }

  if (periodicHitsPerSecond <= 0 && ownHitsPerCast <= 0) return undefined;

  return {
    effectId,
    chance,
    fromStats,
    periodicHitsPerSecond,
    fromEffects,
    ownHitsPerCast,
    spentPerCast: stacksSpent(spell, effectId),
  };
}

/** The share of casts that fire the gated half, at `castsPerSecond`, in steady state. */
export function gatedShare(supply: SelfHitSupply, castsPerSecond: number): number {
  if (castsPerSecond <= 0) return 0;
  const perSecond = supply.chance * (supply.periodicHitsPerSecond + supply.ownHitsPerCast * castsPerSecond);
  return Math.min(1, perSecond / (supply.spentPerCast * castsPerSecond));
}

/** Whether the stat's grant rolls against its value, rather than firing on every hit. */
function rolls(snapshot: Snapshot, statId: string): boolean {
  const data = asObject(entry(snapshot, CATEGORY.stat, statId)?.data);
  return asArray(data?.["effect"]).some((block) =>
    asArray(asObject(block)?.["ifs"]).includes("random_roll"),
  );
}

/** A part whose `damage` act lands on the caster. */
function hitsSelf(part: Record<string, unknown>): boolean {
  const toSelf = asArray(part["targets"]).some((raw) => stringAt(asObject(raw), "type") === "self");
  const damages = asArray(part["acts"]).some((raw) => {
    const act = asObject(raw);
    return stringAt(act, "type") === "damage" && asObject(act?.["map"])?.["allow_self_damage"] === true;
  });
  return toSelf && damages;
}

function tickRate(part: Record<string, unknown>): number | undefined {
  for (const raw of asArray(part["ifs"])) {
    const gate = asObject(raw);
    if (stringAt(gate, "type") !== "x_ticks_condition") continue;
    const ticks = asObject(gate?.["map"])?.["tick_rate"];
    if (typeof ticks === "number") return ticks;
  }
  return undefined;
}

/**
 * Stacks one gated cast takes off you: the `REMOVE_STACKS` count, else the gate's own minimum.
 *
 * `dark_pact` removes its three from a one-tick projectile, `remove_sacrifice`, so the count is
 * read from anywhere in the spell rather than from `on_cast` alone.
 */
function stacksSpent(spell: Record<string, unknown>, effectId: string): number {
  let removed = 0;
  let gate = 0;
  walk(spell["attached"], (node) => {
    const map = asObject(node["map"]) ?? {};
    if (stringAt(map, "exile_potion_id") !== effectId) return;
    const type = stringAt(node, "type");
    if (type === "exile_effect" && stringAt(map, "potion_action") === "REMOVE_STACKS") {
      removed = Math.max(removed, typeof map["count"] === "number" ? map["count"] : 1);
    }
    if ((type === "caster_has_mns_effect" || type === "has_mns_effect") && map["is_false"] !== true) {
      gate = Math.max(gate, typeof map["effect_stacks"] === "number" ? map["effect_stacks"] : 1);
    }
  });
  return Math.max(1, removed > 0 ? removed : gate);
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = asObject(value);
  if (node === undefined) return;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringAt(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" ? value : undefined;
}
