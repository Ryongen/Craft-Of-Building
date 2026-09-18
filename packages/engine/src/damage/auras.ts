/**
 * What an aura you are running deals, for as long as you run it.
 *
 * Eighteen of this pack's `mmorpg_exile_effect` entries declare `damage` acts inside
 * `ExileEffect.spell`, and for four of them — Holy Fire, Sanguine Aura, Abyss Aura, Plague Aura
 * — that is the entire skill. Until this existed those four reported **zero damage**: the spell
 * you press declares no `damage` act of its own, so `skillModel` walked `on_cast`, found a
 * projectile that grants an effect, and correctly concluded the button hits nothing.
 *
 * ## Why it cannot be reached by walking the cast
 *
 * `holy_fire`'s `on_cast` is a two-branch toggle:
 *
 *   - throw `stack_adder`, gated on `caster_has_mns_effect { holy_fire, is_false: true }`;
 *   - throw `stack_remover`, gated on `caster_has_mns_effect { holy_fire }`.
 *
 * On a build that *runs* the aura the first gate fails and the second holds — pressing the
 * button turns the aura off. That is the game, and the model is right to block the branch. So a
 * walk that started at the button would find the damage only on a character who does not have
 * the aura up, which is precisely the character it does nothing for.
 *
 * This file enters from the other end: from the effects `effect-state.ts` says the character is
 * **holding**. That is a fact about the build rather than about the button, it survives the
 * toggle, and it is the same question the player is asking — "Holy Fire is on; what is it doing?"
 *
 * ## Only the effects you hold yourself
 *
 * Eight of the eighteen are debuffs that ride the *enemy* — `envenomed`, `torment`, `drain` and
 * the rest — and their damage act targets `self`, meaning the mob that holds them. Counting
 * those here would resolve them against your sheet and bill them to you, which is worse than
 * not counting them at all. They are reported as a gap instead; see {@link auraGaps}.
 *
 * ## What one "cast" of an aura is worth
 *
 * A permanent aura has no cast rate worth the name — you press it once a map. So its carrier is
 * given a life of exactly one cast cycle, which makes "damage per cast" and "damage per cycle"
 * the same number and therefore makes `damagePerCast / cycleSeconds` the damage per second the
 * aura really deals. That figure is independent of what the cycle happens to be, which is the
 * sign it is the right one: `holy_fire` pulses every 10 ticks and comes out at two pulses a
 * second whether its cycle is read as two seconds or twenty.
 *
 * A timed effect keeps its declared duration instead, and the per-cast model already handles
 * that shape correctly — the cast puts it up, it ticks for its life, the cooldown paces it.
 */

import type { Snapshot } from "@cte2/extractor";
import { CATEGORY, entry } from "@cte2/schema";

import type { EffectState } from "./effect-state.js";
import { skillModel, type Carrier, type DamageSource } from "./skill-model.js";
import type { SpellCalc, SpellConfig } from "./spell-calc.js";

/** The group `ExileEffect.spell` ticks. All eighteen damaging effects use it and nothing else. */
const EFFECT_GROUP = "default_entity_name";

/** `potion_dur` for an effect that does not expire — the pack's toggled auras. */
const PERMANENT = -1;

export type AuraInput = {
  snapshot: Snapshot;
  effects: EffectState;
  /** The skill this figure is about. Only effects this spell grants are counted against it. */
  spellId: string;
  /** The granting spell's own tree, for the `potion_dur` its `exile_effect` act declares. */
  spell: Record<string, unknown>;
  declared: SpellConfig;
  calc: SpellCalc;
  /** `rate.cycleSeconds` in ticks — what one press of a permanent toggle is counted over. */
  cycleTicks: number;
  conditions?: Record<string, boolean> | undefined;
};

export type AuraResult = {
  /** Damage acts the held effects contribute, ready to append to the model's own. */
  sources: DamageSource[];
  /** Effect ids that produced them, for a panel that wants to say where the damage came from. */
  effectIds: string[];
  /** Effects that carry damage this cannot bill — see {@link auraGaps}. */
  gaps: string[];
};

/**
 * Every damage act the effects this build holds contribute to this skill.
 *
 * Returns nothing at all for the overwhelming majority of spells, at the cost of one map lookup
 * per active effect, so it is safe to call on every `simulateDps`.
 */
export function auraSources(input: AuraInput): AuraResult {
  const sources: DamageSource[] = [];
  const effectIds: string[] = [];

  for (const option of input.effects.options) {
    if (option.stacks <= 0) continue;
    // Granted by *this* skill, and held by *you*. A build running Holy Fire and Sanguine Aura
    // gets each one billed to the button that puts it up, not both to whichever is selected.
    const grant = option.grantedBy.find(
      (g) => g.kind === "spell" && g.spellId === input.spellId && g.holder === "caster",
    );
    if (grant === undefined) continue;

    const data = entry(input.snapshot, CATEGORY.exileEffect, option.id)?.data;
    const spell = asObject(data?.["spell"]);
    if (spell === undefined) continue;
    const groups = asObject(spell["entity_components"]);
    if (groups === undefined || !(EFFECT_GROUP in groups)) continue;

    const declaredDuration = durationOf(input.spell, option.id);
    const permanent = declaredDuration === undefined || declaredDuration < 0;
    const lifeTicks = permanent
      ? Math.max(1, Math.round(input.cycleTicks))
      : Math.max(1, Math.round(declaredDuration * input.calc.durationMulti));

    const carrier: Carrier = {
      kind: "effect",
      effectId: option.id,
      count: 1,
      lifeTicks,
      permanent,
    };

    // The effect's own tree is shaped exactly like a spell's `attached`, which is what lets one
    // walk serve both: `ExileEffect.spell` *is* a `Spell`, with the same parts, the same gates
    // and the same acts. Entering at the group it ticks rather than at `on_cast` is the only
    // difference, and `entryGroup` already existed for the summons' basic attacks.
    const model = skillModel(
      { attached: spell, identifier: option.id },
      input.declared,
      input.calc,
      input.effects,
      EFFECT_GROUP,
      input.conditions,
      carrier,
    );
    if (model.sources.length === 0) continue;

    effectIds.push(option.id);
    for (const source of model.sources) {
      sources.push({
        ...source,
        // Namespaced so it cannot collide with the spell's own `default_entity_name#n`, and so
        // a coverage override typed against it stays meaningful — `config.coverageOverrides` is
        // keyed on exactly this string.
        id: `effect:${option.id}:${source.id}`,
        path: [`${option.id} aura`, ...source.path.slice(1)],
      });
    }
  }

  return { sources, effectIds, gaps: auraGaps(input) };
}

/**
 * Damaging effects the build holds that this cannot bill to anything, by name.
 *
 * A debuff sitting on the enemy damages whoever holds it, and whoever holds it is the mob. That
 * is real damage and it is in no figure here: pricing it needs a rate for how often the debuff
 * is refreshed and a sheet for the mob it is ticking on, and the second of those is stated
 * rather than derived. Saying so is the honest half of the answer.
 */
function auraGaps(input: AuraInput): string[] {
  const out: string[] = [];
  for (const option of input.effects.options) {
    if (option.stacks <= 0) continue;
    const onEnemy = option.grantedBy.some(
      (g) => g.kind === "spell" && g.spellId === input.spellId && g.holder === "target",
    );
    if (!onEnemy) continue;
    const data = entry(input.snapshot, CATEGORY.exileEffect, option.id)?.data;
    const spell = asObject(data?.["spell"]);
    if (spell !== undefined && declaresDamage(spell)) out.push(option.id);
  }
  return out;
}

/**
 * `potion_dur` on the `exile_effect` act that names this effect, in ticks.
 *
 * Read off the granting spell's tree rather than off the effect, because the duration belongs to
 * the *grant* and two spells can apply the same effect for different lengths. Gates are ignored
 * on purpose: the toggle branch that would grant it is blocked precisely when the aura is up,
 * which is the only time this is asked.
 */
function durationOf(spell: Record<string, unknown>, effectId: string): number | undefined {
  let found: number | undefined;
  const visit = (node: unknown): void => {
    if (found !== undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = asObject(node);
    if (obj === undefined) return;
    if (obj["type"] === "exile_effect") {
      const map = asObject(obj["map"]);
      if (map !== undefined && map["exile_potion_id"] === effectId) {
        const action = map["potion_action"];
        // A `REMOVE_STACKS` act carries a duration too, and it means nothing here.
        if (action === undefined || action === "GIVE_STACKS") {
          const dur = map["potion_dur"];
          found = typeof dur === "number" && Number.isFinite(dur) ? dur : PERMANENT;
          return;
        }
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(spell);
  return found;
}

/**
 * The share of your bar at which one of these effects takes itself off, when one does.
 *
 * Four auras carry a `remove_<id>_when_very_low` stat, whose gate is `is_target_very_low`:
 * `perc: 25`, `check_combined_hp_and_ms: true`. So Holy Fire does not kill you — it goes out at
 * a quarter of your health plus magic shield, and a build that cannot out-regenerate it loses
 * the aura rather than the character. That is a completely different failure to plan around
 * than dying, and it is the one the sustain figure should name.
 *
 * Read out of the registries rather than written as 0.25 here: the threshold is the pack's, the
 * condition it comes from is shared with eight other stats, and a pack that retuned it would
 * otherwise leave this quietly wrong.
 */
export function auraCutoffShare(snapshot: Snapshot, effectIds: readonly string[]): number | undefined {
  let share: number | undefined;
  for (const id of effectIds) {
    const data = entry(snapshot, CATEGORY.exileEffect, id)?.data;
    const stats = data?.["stats"];
    if (!Array.isArray(stats)) continue;
    for (const mod of stats) {
      const statId = asObject(mod)?.["stat"];
      if (typeof statId !== "string" || !REMOVE_WHEN_LOW.test(statId)) continue;
      const percent = thresholdOf(snapshot, statId);
      // The *highest* threshold is the binding one: it is the first line the bar falls through.
      if (percent !== undefined && (share === undefined || percent > share)) share = percent;
    }
  }
  return share;
}

/** `remove_holy_fire_when_very_low` and its three siblings. */
const REMOVE_WHEN_LOW = /^remove_.+_when_very_low$/;

/** The `perc` on whichever low-health condition gates this stat, as a share rather than a percent. */
function thresholdOf(snapshot: Snapshot, statId: string): number | undefined {
  const stat = entry(snapshot, CATEGORY.stat, statId)?.data;
  const blocks = stat?.["effect"];
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    const ifs = asObject(block)?.["ifs"];
    if (!Array.isArray(ifs)) continue;
    for (const conditionId of ifs) {
      if (typeof conditionId !== "string") continue;
      const condition = entry(snapshot, CATEGORY.statCondition, conditionId)?.data;
      const ser = condition?.["ser"];
      if (ser !== "is_target_low" && ser !== "is_hp_under") continue;
      const perc = condition?.["perc"];
      if (typeof perc === "number" && Number.isFinite(perc)) return perc / 100;
    }
  }
  return undefined;
}

function declaresDamage(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(declaresDamage);
  const obj = asObject(node);
  if (obj === undefined) return false;
  if (obj["type"] === "damage") return true;
  return Object.values(obj).some(declaresDamage);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
