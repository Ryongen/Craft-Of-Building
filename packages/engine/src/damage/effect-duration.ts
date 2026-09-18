/**
 * How long a buff you cast actually lasts — the `on_exile_effect` sweep.
 *
 * `potion_dur` on an `exile_effect` act is the *declared* duration, not the one you get.
 * `ExilePotionEvent` seeds it as a number and hands the event to the same stat pipeline every
 * other event goes through:
 *
 *     this.data.setupNumber(EventData.EFFECT_DURATION_TICKS, tickDuration);   // :41
 *     ...
 *     extraData.ticks_left = (int) data.getNumber(EventData.EFFECT_DURATION_TICKS).number;  // :128
 *
 * — `ExilePotionEvent.java`. Thirteen stats write that number, all through
 * `increase_effect_duration_ticks_num` on the Source side: `eff_dur_u_cast` unconditionally, and
 * twelve typed twins each gated on an `effect_has_tag_<tag>` against the effect being applied.
 *
 * ## Why this reaches support gems
 *
 * `ExileEffectAction` builds the event with the casting spell attached —
 *
 *     if (spell != null) { builder.setSpell(spell); }
 *     ...
 *     if (spell != null) { potionEvent.spellid = spell.GUID(); }
 *
 * — and `EffectEvent.AddEffects` reads a Source-side spell event's stats off
 * `getSpellUnitStats(spell)` rather than off the bare unit. That is the per-spell unit, which is
 * where a support gem's stats live and nowhere else. So the Effect Duration support gem linked
 * to Protection really does extend Protection, and reading this off the character sheet instead
 * would have said it does nothing. Both lines were read out of
 * `Mine_and_Slash-1.20.1-6.4.13.jar`, which is the build this snapshot was extracted from.
 *
 * ## What is deliberately not here
 *
 * The four Target-side `*_immunity` stats cancel the event outright, and the twenty-four
 * `inc_effect_of_<tag>_buff_*` stats write the event's *main* number, which becomes
 * `ExileEffectInstanceData.str_multi`. The second family is already modelled — `strMultiFor` in
 * `effect-state.ts` — and the immunities belong to a mob's sheet rather than to yours. This
 * function answers one question, the duration, and takes only the blocks that write it.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildConfig, Diagnostic } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";

import type { Balance } from "../balance.js";
import type { Compat } from "../compat.js";
import type { StatIndex } from "../stat-def.js";
import { evaluateIfs } from "./conditions.js";
import type { DamageCtx, Sheet } from "./ctx.js";
import type { EffectState } from "./effect-state.js";
import { applyStatEffect } from "./effects.js";
import { DamageEventState } from "./event.js";
import type { LayerIndex } from "./layers.js";
import { UNKNOWN_ORDER_PRIORITY, datapackPriority } from "./priority.js";

/** `ExilePotionEvent.ID`. */
const ON_EXILE_EFFECT = "on_exile_effect";

/** `EventData.EFFECT_DURATION_TICKS`. */
const EFFECT_DURATION_TICKS = "effect_duration_ticks";

/**
 * The one stat effect that writes the duration. Every other `on_exile_effect` block writes
 * something this function is not about, so the sweep filters on the effect rather than running
 * all 42 and hoping the numbers it does not read stay unread.
 */
const INCREASE_DURATION = "increase_effect_duration_ticks_num";

export type EffectDurationInput = {
  snapshot: Snapshot;
  index: StatIndex;
  /** Only the event needs it — nothing this sweep applies touches a damage layer. */
  layers: LayerIndex;
  balance: Balance;
  compat: Compat;
  /**
   * The **spell** unit, with support gems folded in — see the note above on why it must be that
   * sheet and not the character's.
   */
  sheet: Sheet;
  /** The exile effect being applied, for the `effect_has_tag_<tag>` gates. */
  effectId: string;
  /** `potion_dur` as the spell's `exile_effect` act declares it. */
  baseTicks: number;
  spellId: string;
  spellTags: ReadonlySet<string>;
  characterLevel: number;
  config: BuildConfig;
  effects: EffectState;
  diagnostics: Diagnostic[];
};

/**
 * `potion_dur` after the sweep, in ticks.
 *
 * A `-1` duration is the pack's infinite marker (`ExileEffectAction.INFINITE_DURATION`) and is
 * returned untouched: a toggle has no duration to lengthen, and scaling the sentinel would turn
 * "until you press it again" into a negative number of ticks.
 */
export function effectDurationTicks(input: EffectDurationInput): number {
  if (!Number.isFinite(input.baseTicks) || input.baseTicks <= 0) return input.baseTicks;

  const effectData = entry(input.snapshot, CATEGORY.exileEffect, input.effectId)?.data;
  if (effectData === undefined) return input.baseTicks;

  const event = new DamageEventState(input.layers);
  event.data.setupNumber(EFFECT_DURATION_TICKS, input.baseTicks);

  const ctx: DamageCtx = {
    snapshot: input.snapshot,
    index: input.index,
    balance: input.balance,
    compat: input.compat,
    event,
    source: input.sheet,
    // `ExilePotionEvent` passes the caster on both sides for a self-buff, but nothing this sweep
    // reads is Target-side — the four Target blocks on this event are the immunities, and those
    // belong to whoever is being debuffed.
    target: new Map(),
    sourceLevel: input.characterLevel,
    targetLevel: input.characterLevel,
    spell: undefined,
    spellId: input.spellId,
    spellTags: input.spellTags,
    config: input.config,
    effects: input.effects,
    exileEffect: { id: input.effectId, tags: new Set(tagsOf(effectData)) },
    diagnostics: input.diagnostics,
    report: (severity, code, path, message) =>
      input.diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    pinnedBooleans: new Set(),
    disableSourceStats: false,
    sourceIsTarget: false,
  };

  // Ordered the same way `calculateSpell` orders its sweep, for the same reason: `increase_number`
  // is additive off the *original* number, so the order cannot change the total — but the MORE
  // multiplier it then applies to the running number can, and a stable order is what keeps two
  // runs of the same build agreeing with each other.
  const queue: { priority: number; statId: string; run: () => void }[] = [];

  for (const [statId, stat] of input.sheet) {
    if (stat.value === 0) continue;
    const def = input.index.get(statId);
    for (const block of def?.effects ?? []) {
      if (block.side !== "Source") continue;
      if (!block.events.includes(ON_EXILE_EFFECT)) continue;
      if (!block.effects.includes(INCREASE_DURATION)) continue;
      queue.push({
        priority: datapackPriority(block.order) ?? UNKNOWN_ORDER_PRIORITY,
        statId,
        run: () => {
          const weight = evaluateIfs(
            ctx,
            block.ifs,
            { statId, value: stat.value, element: def?.element },
            "Source",
          );
          if (weight <= 0) return;
          const shape = input.index.shapeOf(statId);
          applyStatEffect(
            ctx,
            INCREASE_DURATION,
            { statId, value: stat.value, dmgMulti: stat.dmgMulti, multiUseType: shape.multiUseType },
            "Source",
            weight,
          );
        },
      });
    }
  }

  queue.sort((a, b) =>
    a.priority === b.priority ? a.statId.localeCompare(b.statId) : a.priority - b.priority,
  );
  for (const item of queue) item.run();

  // `(int) data.getNumber(...).number` — the field it lands in is an `int`, so the fraction is
  // dropped rather than rounded. Floored at one tick: a "reduced duration" build stacked far
  // enough would otherwise be handed a buff that is already over when it lands.
  return Math.max(1, Math.trunc(event.data.getNumber(EFFECT_DURATION_TICKS)));
}

/** An `mmorpg_exile_effect`'s own `tags.tags` — what every `effect_has_tag_<tag>` matches on. */
function tagsOf(data: Record<string, unknown>): string[] {
  const holder = data["tags"];
  if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return [];
  const list = (holder as Record<string, unknown>)["tags"];
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
}
