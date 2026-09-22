/**
 * What refills a pool, how fast, and whether it keeps up with what you spend.
 *
 * Three separate machines, and a build is only sustainable if all three agree:
 *
 *   1. **the regeneration tick** — one restore event per resource a second;
 *   2. **the leech pool** — everything you take off the damage you deal, banked and metered out
 *      at a percentage of the pool per second;
 *   3. **the spend** — the cast's own cost, which `dps.ts` supplies.
 *
 * ## The regeneration tick
 *
 * `OnServerTick` raises one restore event per resource **once a second** — `age % 20 == 0` — with
 * the number starting at zero and every stat filling it in:
 *
 *     if (!ResourceType.mana.isFull(unitdata)) {
 *         EventBuilder.ofRestore(player, player, ResourceType.mana, RestoreType.regen, 0).build().Activate();
 *     }
 *
 * and the same for energy, magic shield and health. Verified against 6.4.13's bytecode, where the
 * one `ResourceType.blood` in that method belongs to the "your weapons go on cooldown at zero
 * while blocking" check rather than to a regen tick. That absence is the whole story about blood.
 *
 * Three kinds of stat feed that event, and `dps.ts` used to read only the first:
 *
 *   - **`<r>_regen`** (`BaseRegenClass`) adds its flat value to the event's number;
 *   - **`<r>_per_sec`** (`RegeneratePercentStat`) adds `max × value / 100`, so it scales with the
 *     pool it is filling;
 *   - **the datapack percents** — `resource_regen`, `out_of_combat_regen`, `blood_regen`,
 *     `<r>_leech_regen`, `missing_hp_health_regen_per_2` — are `on_restore_resource` blocks
 *     writing to the `additive_damage` layer, exactly as a damage stat does. They multiply the
 *     other two.
 *
 * That last group is why this runs the restore event through the *same* `sweep` a hit goes
 * through, with the event id swapped. Adding the numbers by hand would leave every percent on the
 * floor, and there is no second interpreter to keep in step.
 *
 * ## In combat
 *
 * `RestoreResourceEvent.activate` then applies one thing no layer can see:
 *
 *     if (data.getRestoreType() == RestoreType.regen
 *             && Load.Unit(target).getCooldowns().isOnCooldown(CooldownsData.IN_COMBAT)
 *             && data.getResourceType() != ResourceType.energy) {
 *         num *= ServerContainer.get().IN_COMBAT_REGEN_MULTI.get();
 *     }
 *
 * `in_combat` is a ten-second cooldown re-stamped by every hit you land or take (`DamageEvent`,
 * `20 * 10`), so anything you would call a rotation is inside it. The mod's own default for that
 * config is **0.5** — half regeneration while fighting, energy exempt — but Craft to Exile 2
 * ships `in_combat_regen_multi = 1.0` in `defaultconfigs/mine_and_slash-server.toml`, so on this
 * pack the two columns agree on that factor. It is a server config rather than pack data, so it
 * is an option with the pack's value as its default rather than a number read from the snapshot.
 *
 * `out_of_combat_regen` is the other half of the same question, and it *is* a layer: a datapack
 * stat gated on `is_in_combat_is_false`. The two columns therefore still differ on any build that
 * carries it, even on this pack.
 *
 * ## Leech
 *
 * Every `restore_resource` stat effect in the pack — all ten of them — declares
 * `restore_type: "leech"`, so nothing you take off a hit lands directly. It goes into a per-pool
 * accumulator and comes out metered:
 *
 *     float leechMaxPerSec = 5F * LEECH_CAP.get(type).getValue() / 100F;
 *     float max = data.getMaximumResource(type) * leechMaxPerSec;
 *     map.put(type, MathHelper.clamp(value, 0, max));            // the bank holds five seconds
 *     ...
 *     float max = LEECH_CAP.get(type).getValue() / 100F * maxres;
 *     if (num > max) num = max;                                  // and pays out one second
 *     addLeech(type, -num);
 *     data.getResources().restore(entity, type, num);
 *
 * — `EntityLeechData.onSecondUseLeeches`, called from `OnEntityTick` on `tickCount % 20 == 0`,
 * identical in the 6.4.8 checkout and the 6.4.13 bytecode. `<r>_leech_cap` is a stat with a base
 * of **5** on every pool, so the familiar "5% of the pool per second" is a floor you can raise —
 * this pack lets it reach 50.
 *
 * So the sustained rate is `min(generated, cap)`: below the cap the bank drains as fast as it
 * fills and you keep everything; above it the surplus is thrown away a second later. The bank
 * only matters to a burst, and its ceiling is five seconds of cap.
 *
 * What 6.4.13 changed is *where* the pooling happens. In 6.4.8 `RestoreResourceAction` itself
 * called `addLeech` and returned, so the restore event was never raised and `inc_leech` — which
 * lives on that event — was dead code. In 6.4.13 the action always raises the event and
 * `RestoreResourceEvent.activate` pools the finished number, so a leech runs `inc_leech` and
 * `<r>_leech_regen` on the way in. That is a real difference in the arithmetic, and the jar wins.
 *
 * ## Blood, and the Blood Magic game changer
 *
 * `blood_user` — "You now use Blood instead of Mana" — is an `InCodeStatEffect` on
 * **`SpendResourceEvent`**, not on the restore one:
 *
 *     effect.data.setString(EventData.RESOURCE_TYPE, ResourceType.blood.name());
 *     ...
 *     if (effect.data.getResourceType() == ResourceType.mana || effect.data.getResourceType() == ResourceType.energy) {
 *         return true;
 *     }
 *
 * It redirects what a spell *spends*, and touches nothing else. Mana and energy keep
 * regenerating and you stop spending them; blood is what pays, and blood has no tick.
 *
 * **The energy arm is 6.4.13.** The 6.4.8 checkout tests `== ResourceType.mana` alone, so a port
 * read off it bills a weapon skill's energy cost to the energy pool. That is wrong in a way the
 * pack makes easy to miss and hard to survive: taking Blood Magic zeroes `energy` *and* `mana` —
 * both maxima read 0 on a captured blood mage — so a weapon-skill build's whole spend lands on a
 * pool that cannot hold it, against an `energy_regen` figure that can never be banked. The
 * captured Amfk build is exactly that, and the version skew flattered it into "sustainable".
 *
 * What fills blood is `hp_resto_to_blood`, which rides a health restoration at `FINAL_DAMAGE`,
 * takes a percentage of its finished number and raises a blood event forwarding the same restore
 * type — so `blood_regen` and `inc_leech` then apply to it in turn. Its gate matters:
 *
 *     if (effect.data.isSpellEffect()) { return false; }
 *     if (effect.data.getResourceType() == ResourceType.health) { return true; }
 *
 * `isSpellEffect()` is `ExileDB.Spells().isRegistered(getString(SPELL))`, and
 * `RestoreResourceAction` copies the spell onto the restore event it raises. So the regeneration
 * tick feeds blood (nothing set a spell on it) and so does health leech from a **basic attack**,
 * but health leech from a *spell* does not. A blood caster is sustained by health regeneration; a
 * blood attacker can also leech into it.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  CATEGORY,
  entry,
  serverConfigNumber,
  type BuildDoc,
  type Diagnostic,
} from "@cte2/schema";

import { balance } from "../balance.js";
import { resolveEffects, type EngineOptions, type EngineResult } from "../calculate.js";
import { ORIGINAL_MODE, type Compat } from "../compat.js";
import { statIndex } from "../stat-def.js";
import { Recorder, type LayerStep, type MoreStep } from "./breakdown.js";
import type { DamageCtx, RestoreRecord, Sheet } from "./ctx.js";
import { EVENT, DamageEventState } from "./event.js";
import { layerIndex } from "./layers.js";
import { sweep } from "./simulate.js";

/** The five pools `ResourceType` names. */
export const RESOURCES = ["health", "mana", "energy", "magic_shield", "blood"] as const;
export type ResourceId = (typeof RESOURCES)[number];

/** The TOML key, so the engine and the app ask for it by the same name. */
export const IN_COMBAT_REGEN_MULTI_KEY = "general.in_combat_regen_multi";

/**
 * `in_combat_regen_multi` when the snapshot cannot say.
 *
 * The mod's own default is 0.5 and Craft to Exile 2 ships 1.0. This used to be the only answer
 * available — the file is a server config rather than pack data, and the extractor read only
 * datapacks — so the number was baked here and the app asked the player to retype it. The
 * extractor now reads the TOML, and `inCombatRegenMultiOf` prefers what it found; this stays as
 * the fallback for a snapshot taken before that, or an install with no `defaultconfigs/`.
 */
export const PACK_IN_COMBAT_REGEN_MULTI = 1;

/**
 * What the pack's server config says, or the fallback above.
 *
 * A build document's own `config.inCombatRegenMulti` still wins over both: the snapshot
 * describes the install you extracted from, and a player may be planning for a server that
 * configured it differently.
 */
export function inCombatRegenMultiOf(snapshot: Snapshot): number {
  return serverConfigNumber(snapshot, IN_COMBAT_REGEN_MULTI_KEY) ?? PACK_IN_COMBAT_REGEN_MULTI;
}

/** `5F * LEECH_CAP / 100F` — the bank holds five seconds of payout and clamps there. */
export const LEECH_BANK_SECONDS = 5;

export type Regen = {
  resource: ResourceId;
  /** The pool being filled. */
  max: number;
  /** `<r>_regen` — the flat contribution, before any percent. */
  flat: number;
  /** `max × <r>_per_sec / 100`. */
  fromPercentOfMax: number;
  /** What the event starts at: the two above, summed. */
  base: number;
  /** Per second out of combat, after the restore event's own layers. */
  perSecond: number;
  /**
   * Per second while `in_combat` is up — ten seconds from the last hit either way.
   *
   * Differs from {@link perSecond} by `in_combat_regen_multi` (1.0 on this pack, 0.5 on a
   * default install, and never applied to energy) and by anything gated on `is_in_combat`.
   */
  inCombatPerSecond: number;
  /** Seconds from empty to full out of combat, or undefined when it never fills. */
  secondsToFull: number | undefined;
  /** Layer by layer, for a breakdown. */
  steps: LayerStep[];
  /** Set when the resource does not regenerate the ordinary way. */
  note?: string;
};

export type Resources = {
  byResource: Regen[];
  /**
   * `blood_user > 0` — `Unit.isBloodMage()`. Mana *and energy* costs are paid from blood, and
   * nothing else about either pool changes.
   */
  bloodMage: boolean;
  /** `hp_resto_to_blood` — the share of health restoration that also fills blood. */
  healthToBloodPercent: number;
  /** What the in-combat column was multiplied by. */
  inCombatRegenMulti: number;
  diagnostics: Diagnostic[];
};

export type ResourceOptions = {
  balanceId?: string;
  baseStatsId?: string;
  compat?: Compat;
  newbieResists?: boolean;
  /** A sheet already computed for this build, to avoid a second stat pass. */
  sheet?: EngineResult;
  /**
   * `ServerContainer.IN_COMBAT_REGEN_MULTI`, overriding `config.inCombatRegenMulti`.
   *
   * Falls back to the document, then to this pack's 1.0.
   */
  inCombatRegenMulti?: number;
};

/**
 * Which pool actually pays a declared cost, given the Blood Magic game changer.
 *
 * `BloodUserEffect.canActivate` accepts **both** mana and energy in 6.4.13, so a blood mage pays
 * for a weapon skill out of blood exactly as they pay for a spell. Every other pool is returned
 * unchanged: the effect rewrites `RESOURCE_TYPE` on the spend event and nothing raises a health
 * or magic-shield spend through it.
 */
export function resourceSpent(sheet: Sheet, declared: ResourceId): ResourceId {
  if (declared !== "mana" && declared !== "energy") return declared;
  return (sheet.get("blood_user")?.value ?? 0) > 0 ? "blood" : declared;
}

/**
 * Per-second regeneration for every pool, in and out of combat.
 *
 * One tick's worth for a character standing still. `is_in_combat` is pinned per column rather
 * than read from `config.conditions`, because the two columns *are* the two answers and a
 * document that states one would otherwise silently produce it twice.
 */
export function resources(
  build: BuildDoc,
  snapshot: Snapshot,
  options: ResourceOptions = {},
): Resources {
  const diagnostics: Diagnostic[] = [];
  const shared = sharedState(build, snapshot, options, diagnostics);
  // The document is where a player says which server they are on; the option is for a caller
  // that already knows better. Neither being present, the answer comes off the extracted
  // server config rather than a constant.
  const inCombatRegenMulti =
    options.inCombatRegenMulti ?? build.config?.inCombatRegenMulti ?? inCombatRegenMultiOf(snapshot);
  const sheet = shared.sheet;

  const byResource: Regen[] = [];
  for (const resource of RESOURCES) {
    if (resource === "blood") continue;
    byResource.push(regenOf(shared, resource, inCombatRegenMulti, 0));
  }

  // Blood has no tick. It fills from health restoration, and only when the character carries the
  // stat that redirects some of it — so the seed is the health tick's *finished* number, read
  // before the in-combat multiplier because `hp_resto_to_blood` runs at `FINAL_DAMAGE`, inside
  // `calculateEffects`, while the multiplier is applied afterwards in `activate`.
  const health = byResource.find((r) => r.resource === "health");
  const healthToBloodPercent = sheet.get("hp_resto_to_blood")?.value ?? 0;
  const blood = regenOf(
    shared,
    "blood",
    inCombatRegenMulti,
    ((health?.perSecond ?? 0) * healthToBloodPercent) / 100,
    ((health?.inCombatPerSecond ?? 0) * healthToBloodPercent) / 100,
  );
  blood.note =
    healthToBloodPercent > 0
      ? `Blood has no regeneration tick of its own. This is ${healthToBloodPercent.toFixed(1)}% of ` +
        `your health regeneration, redirected by Hp regen to blood, with the blood modifiers's own ` +
        `percents applied on top. Health leech feeds it too, but only from a basic attack,` +
        `\`HealthRestorationToBloodEffect\` refuses any restore that carries a spell.`
      : `Blood has no regeneration tick of its own, and nothing in this build carries ` +
        `Hp regen to blood to redirect health regeneration into it. Blood refills from leech ` +
        `and on-kill stats only.`;
  byResource.push(blood);

  const bloodMage = (sheet.get("blood_user")?.value ?? 0) > 0;
  if (bloodMage) {
    diagnostics.push({
      severity: "info",
      code: "blood-magic-active",
      path: "tree",
      message:
        `\`blood_user\` is on, so every mana **and energy** cost is paid from blood instead, ` +
        `\`BloodUserEffect\` rewrites the resource on the spend event and changes nothing else. ` +
        `Mana and energy keep regenerating and stop being spent; blood is what has to keep up, ` +
        `and its only source is ` +
        `${healthToBloodPercent > 0 ? "your health regeneration" : "leech and on-kill stats"}. ` +
        `A weapon skill costs energy, so on this build it is blood that pays for it.`,
    });
  }

  if ((sheet.get("out_of_combat_regen")?.value ?? 0) > 0) {
    diagnostics.push({
      severity: "info",
      code: "regen-out-of-combat-only",
      path: "tree",
      message:
        `\`out_of_combat_regen\` is gated on \`is_in_combat_is_false\`, and \`in_combat\` is a ` +
        `ten-second cooldown re-stamped by every hit you land or take — so it contributes nothing ` +
        `during a fight. The in-combat column is the one a rotation has to live on.`,
    });
  }

  return { byResource, bloodMage, healthToBloodPercent, inCombatRegenMulti, diagnostics };
}

// ---------------------------------------------------------------------------
// Leech
// ---------------------------------------------------------------------------

/** One stat's contribution to a pool's leech, per second. */
export type LeechSource = {
  statId: string;
  effectId: string;
  /** Before the restore event's own layers. */
  perSecond: number;
};

export type LeechEntry = {
  resource: ResourceId;
  /** The pool, which is what the cap is a percentage of. */
  max: number;
  /** What the hits produced, before `inc_leech` and `<r>_leech_regen`. */
  seedPerSecond: number;
  /** After those, which is what actually enters the bank. */
  generatedPerSecond: number;
  /** `<r>_leech_cap` — a percent of the pool, base 5. */
  capPercent: number;
  /** `capPercent / 100 × max` — the most that can leave the bank in one second. */
  capPerSecond: number;
  /** `min(generated, cap)` — the sustained rate. */
  perSecond: number;
  /** True when the cap is what is limiting you, so more leech on gear would be wasted. */
  capped: boolean;
  /** `LEECH_BANK_SECONDS × capPerSecond` — what the accumulator clamps to. */
  bankCeiling: number;
  sources: LeechSource[];
  steps: LayerStep[];
};

/** Leech the engine can see but cannot rate, and why. */
export type UnratedLeech = {
  statId: string;
  value: number;
  reason: string;
};

export type Leech = {
  byResource: LeechEntry[];
  unrated: UnratedLeech[];
  diagnostics: Diagnostic[];
};

export type LeechInput = {
  build: BuildDoc;
  snapshot: Snapshot;
  /**
   * Every `restore_resource` block the damage sweep reached, already scaled to a **per second**
   * rate by the caller — `dps.ts` multiplies each cast's records by casts per second.
   */
  perSecond: readonly RestoreRecord[];
  options?: ResourceOptions;
};

/**
 * What leech is actually worth per second, once the pool's cap has had its say.
 *
 * The records come off the damage sweep rather than from re-reading the stats, so every gate the
 * hit answered — which element it was, whether it was dodged, whether it was a basic attack,
 * whatever `random_roll` resolved to — is already folded in.
 */
export function leech(input: LeechInput): Leech {
  const diagnostics: Diagnostic[] = [];
  const shared = sharedState(input.build, input.snapshot, input.options ?? {}, diagnostics);
  const sheet = shared.sheet;

  const seeds = new Map<ResourceId, LeechSource[]>();
  for (const record of input.perSecond) {
    if (record.restoreType !== "leech") continue;
    const resource = record.resource as ResourceId;
    if (!RESOURCES.includes(resource)) continue;
    const list = seeds.get(resource) ?? [];
    const found = list.find((s) => s.statId === record.statId && s.effectId === record.effectId);
    if (found) found.perSecond += record.amount;
    else list.push({ statId: record.statId, effectId: record.effectId, perSecond: record.amount });
    seeds.set(resource, list);
  }

  const byResource: LeechEntry[] = [];
  for (const resource of RESOURCES) {
    const sources = seeds.get(resource);
    if (sources === undefined) continue;
    const seedPerSecond = sources.reduce((sum, s) => sum + s.perSecond, 0);

    // The bank is filled by restore events, so leech runs the same layers the tick does —
    // `inc_leech` and `<r>_leech_regen` both sit on `on_restore_resource`, gated on the type.
    const tick = restoreEvent(shared, resource, "leech", seedPerSecond);
    const generatedPerSecond = tick.number;

    const max = sheet.get(resource)?.value ?? 0;
    const capPercent = sheet.get(`${resource}_leech_cap`)?.value ?? 0;
    const capPerSecond = (capPercent / 100) * max;
    const perSecond = Math.min(generatedPerSecond, capPerSecond);

    byResource.push({
      resource,
      max,
      seedPerSecond,
      generatedPerSecond,
      capPercent,
      capPerSecond,
      perSecond,
      capped: generatedPerSecond > capPerSecond,
      bankCeiling: LEECH_BANK_SECONDS * capPerSecond,
      sources,
      steps: tick.steps,
    });

    if (capPercent === 0 && generatedPerSecond > 0) {
      diagnostics.push({
        severity: "warning",
        code: "leech-cap-zero",
        path: "tree",
        message:
          `This build leeches ${generatedPerSecond.toFixed(1)} ${resource} a second and ` +
          `\`${resource}_leech_cap\` is 0, so none of it is ever paid out — ` +
          `\`onSecondUseLeeches\` clamps the bank to \`cap% × max\` before draining it. The base ` +
          `for every pool is 5, so something in this build has taken it away.`,
      });
    } else if (generatedPerSecond > capPerSecond && capPerSecond > 0) {
      diagnostics.push({
        severity: "info",
        code: "leech-capped",
        path: "tree",
        message:
          `${resource} leech generates ${generatedPerSecond.toFixed(1)}/s but ` +
          `\`${resource}_leech_cap\` of ${capPercent.toFixed(1)}% caps payout at ` +
          `${capPerSecond.toFixed(1)}/s, so ${(generatedPerSecond - capPerSecond).toFixed(1)}/s is ` +
          `thrown away. More leech on gear is worth nothing here; a bigger pool or a higher cap is.`,
      });
    }
  }

  return { byResource, unrated: unratedLeech(shared), diagnostics };
}

/**
 * Leech the engine can see on the sheet but cannot turn into a rate.
 *
 * Two kinds. `on_mob_kill` is the big one — `<r>_on_kill` is real sustain for a build clearing
 * packs, and kills per second is not something a build document states. `attack_type_is_dot`
 * is the other: `dot_lifesteal` and `dot_magicshield_steal` ride ailment ticks, which the engine
 * rates separately from the hit rather than by sweeping a damage event they could be collected
 * from.
 *
 * Naming them is the honest answer. Counting them at zero would make a leech-on-kill build look
 * unsustainable when it is not, and guessing a kill rate would make every build look however the
 * guess was set.
 */
function unratedLeech(shared: Shared): UnratedLeech[] {
  const out: UnratedLeech[] = [];
  for (const [statId, stat] of shared.sheet) {
    if (stat.value === 0) continue;
    const def = shared.index.get(statId);
    for (const block of def?.effects ?? []) {
      const restores = block.effects.some((id) => {
        const data = entry(shared.snapshot, CATEGORY.statEffect, id)?.data;
        return data !== undefined && data["ser"] === "restore_resource";
      });
      if (!restores) continue;

      const reason = block.events.includes("on_mob_kill")
        ? "fires on a kill, and kills per second is not something a build document states"
        : block.ifs.includes("attack_type_is_dot")
          ? "fires on an ailment tick, which is rated beside the hit rather than as one"
          : undefined;
      if (reason === undefined) continue;
      out.push({ statId, value: stat.value, reason });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export type ResourceBudget = {
  resource: ResourceId;
  max: number;
  /** The in-combat column: a rotation is in combat by definition. */
  regenPerSecond: number;
  leechPerSecond: number;
  /** One cast's declared cost out of this pool. */
  costPerCast: number;
  costPerSecond: number;
  /** Income minus spend. Negative means the pool drains. */
  netPerSecond: number;
  /**
   * The pool's ceiling is at least one cast.
   *
   * A pool never fills past `max`, so a cost above it can never be afforded however fast the
   * pool regenerates — `ResourceType.has` compares the *current* amount against the cost. A
   * ceiling of zero is the case that matters: taking Blood Magic zeroes both `mana` and
   * `energy`, and a rate comparison alone would call the resulting build comfortable.
   */
  holdsACast: boolean;
  sustainable: boolean;
  /** From full, at this rate. Undefined when the pool never empties. */
  secondsToEmpty?: number;
  /** How many casts a full pool buys before it runs dry, at this rate. */
  castsBeforeEmpty?: number;
};

export type BudgetInput = {
  regen: Resources;
  leech: Leech;
  /** What one cast costs, per pool. `dps.ts` resolves Blood Magic before it gets here. */
  perCast: ReadonlyMap<ResourceId, number>;
  castsPerSecond: number;
};

/**
 * Whether the pools keep up, pool by pool.
 *
 * Only pools that are actually spent or actually filled by leech get a row — a build that costs
 * no energy does not need a verdict on its energy. The regeneration column is the in-combat one:
 * `in_combat` is a ten-second cooldown re-stamped by every hit, so a rotation never sees the
 * other figure.
 */
export function budget(input: BudgetInput): ResourceBudget[] {
  const rows: ResourceBudget[] = [];
  for (const resource of RESOURCES) {
    const costPerCast = input.perCast.get(resource) ?? 0;
    const costPerSecond = costPerCast * input.castsPerSecond;
    const regen = input.regen.byResource.find((r) => r.resource === resource);
    const leeched = input.leech.byResource.find((r) => r.resource === resource)?.perSecond ?? 0;
    if (costPerSecond === 0 && leeched === 0) continue;

    const regenPerSecond = regen?.inCombatPerSecond ?? 0;
    const netPerSecond = regenPerSecond + leeched - costPerSecond;
    const max = regen?.max ?? 0;
    // Two separate questions, and a build has to pass both: does the income cover the spend, and
    // can the pool ever hold one cast's worth at all. The second is not implied by the first —
    // a zeroed pool with a large `<r>_regen` stat passes the rate check and cannot be cast from.
    const holdsACast = costPerCast <= 0 || max >= costPerCast;
    const row: ResourceBudget = {
      resource,
      max,
      regenPerSecond,
      leechPerSecond: leeched,
      costPerCast,
      costPerSecond,
      netPerSecond,
      holdsACast,
      sustainable: netPerSecond >= 0 && holdsACast,
    };
    if (netPerSecond < 0) {
      row.secondsToEmpty = max / -netPerSecond;
      if (costPerCast > 0) row.castsBeforeEmpty = (max / -netPerSecond) * input.castsPerSecond;
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The restore event
// ---------------------------------------------------------------------------

type Shared = {
  snapshot: Snapshot;
  index: ReturnType<typeof statIndex>;
  layers: ReturnType<typeof layerIndex>;
  balance: ReturnType<typeof balance>;
  compat: Compat;
  build: BuildDoc;
  sheet: Sheet;
  effects: EngineResult["effects"];
  diagnostics: Diagnostic[];
};

function sharedState(
  build: BuildDoc,
  snapshot: Snapshot,
  options: ResourceOptions,
  diagnostics: Diagnostic[],
): Shared {
  const engineOptions: EngineOptions = {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
    ...(options.newbieResists === undefined ? {} : { newbieResists: options.newbieResists }),
  };
  const run = options.sheet ?? resolveEffects(build, snapshot, engineOptions);
  return {
    snapshot,
    index: statIndex(snapshot),
    layers: layerIndex(snapshot),
    balance: balance(snapshot, options.balanceId),
    compat: options.compat ?? ORIGINAL_MODE,
    build,
    sheet: run.stats,
    effects: run.effects,
    diagnostics,
  };
}

/** Both columns of one resource's regeneration tick. */
function regenOf(
  shared: Shared,
  resource: ResourceId,
  inCombatRegenMulti: number,
  seed: number,
  inCombatSeed = seed,
): Regen {
  const { sheet } = shared;
  const max = sheet.get(resource)?.value ?? 0;
  // Reported, not seeded: `<r>_regen` and `<r>_per_sec` are in-code effects registered on the
  // restore event, so the sweep adds both itself. The seed is what the *caller* brought — zero
  // for a plain tick, the redirected health for blood.
  const flat = sheet.get(`${resource}_regen`)?.value ?? 0;
  const fromPercentOfMax = (max * (sheet.get(`${resource}_per_sec`)?.value ?? 0)) / 100;

  const out = restoreEvent(shared, resource, "regen", seed, false);
  // Two sweeps only when they can disagree. With `in_combat_regen_multi` at this pack's 1.0 and
  // nothing on the sheet gated on `is_in_combat`, the in-combat column is the same arithmetic
  // and the second sweep is pure cost — and every repaint pays it five times over.
  const differs = combatSensitive(shared) || inCombatSeed !== seed;
  const inside = differs ? restoreEvent(shared, resource, "regen", inCombatSeed, true) : out;
  // Energy is exempt by name in `RestoreResourceEvent.activate`.
  const inCombatPerSecond =
    resource === "energy" ? inside.number : inside.number * inCombatRegenMulti;

  return {
    resource,
    max,
    flat,
    fromPercentOfMax,
    base: seed + flat + fromPercentOfMax,
    perSecond: out.number,
    inCombatPerSecond,
    secondsToFull: out.number > 0 && max > 0 ? max / out.number : undefined,
    steps: out.steps,
  };
}

/**
 * Whether anything on this sheet makes the two regeneration columns differ.
 *
 * Only `is_in_combat` can: `in_combat_regen_multi` is applied outside the sweep, so the layers
 * themselves are identical unless some stat is gated on the combat state. `out_of_combat_regen`
 * is the one that is, and a pack could add others.
 */
function combatSensitive(shared: Shared): boolean {
  const cached = COMBAT_SENSITIVE.get(shared.sheet);
  if (cached !== undefined) return cached;

  let sensitive = false;
  outer: for (const [statId, stat] of shared.sheet) {
    if (stat.value === 0 && stat.dmgMulti === 1) continue;
    for (const block of shared.index.get(statId)?.effects ?? []) {
      if (!block.events.includes("on_restore_resource")) continue;
      for (const conditionId of block.ifs) {
        if (mentionsCombat(shared.snapshot, conditionId, 0)) {
          sensitive = true;
          break outer;
        }
      }
    }
  }
  COMBAT_SENSITIVE.set(shared.sheet, sensitive);
  return sensitive;
}

const COMBAT_SENSITIVE = new WeakMap<Sheet, boolean>();

/** `is_in_combat`, directly or nested inside an `either_is_true` / `all_are_true` group. */
function mentionsCombat(snapshot: Snapshot, conditionId: string, depth: number): boolean {
  if (depth > 4) return false;
  const data = entry(snapshot, CATEGORY.statCondition, conditionId)?.data;
  if (data === undefined) return false;
  if (data["ser"] === "is_in_combat") return true;
  const nested = data["ifs"];
  if (!Array.isArray(nested)) return false;
  return nested.some((id) => typeof id === "string" && mentionsCombat(snapshot, id, depth + 1));
}

/**
 * One restore event, swept.
 *
 * The two code-only regen families seed the number from inside the sweep, so the event starts at
 * whatever the caller brought: zero for a plain tick, the redirected health for blood, the hits'
 * own total for leech.
 */
function restoreEvent(
  shared: Shared,
  resource: ResourceId,
  restoreType: string,
  seed: number,
  inCombat?: boolean,
): { number: number; steps: LayerStep[] } {
  const recorder = new Recorder();
  const event = new DamageEventState(shared.layers, undefined, recorder);
  event.data.setupNumber(EVENT.NUMBER, seed);
  event.data.setString(EVENT.RESOURCE_TYPE, resource);
  event.data.setString(EVENT.RESTORE_TYPE, restoreType);

  const ctx: DamageCtx = {
    snapshot: shared.snapshot,
    index: shared.index,
    balance: shared.balance,
    compat: shared.compat,
    event,
    // A regen tick is self-cast: `EventBuilder.ofRestore(player, player, …)`. Both sides are the
    // same sheet, which is what lets a `Target`-side block like
    // `magic_shield_restore_effect_on_self` reach your own magic shield.
    source: shared.sheet,
    target: shared.sheet,
    sourceLevel: shared.build.character.level,
    targetLevel: shared.build.character.level,
    spell: undefined,
    spellId: "",
    spellTags: new Set(),
    config: shared.build.config ?? {},
    ...(inCombat === undefined ? {} : { inCombat }),
    effects: shared.effects,
    diagnostics: shared.diagnostics,
    report: (severity, code, path, message) =>
      shared.diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    pinnedBooleans: new Set(),
    disableSourceStats: false,
    sourceIsTarget: false,
  };

  const steps: LayerStep[] = [];
  const moreMultis: MoreStep[] = [];
  sweep(
    ctx,
    [
      { side: "Source", sheet: shared.sheet },
      { side: "Target", sheet: shared.sheet },
    ],
    steps,
    moreMultis,
    "on_restore_resource",
  );

  return { number: Math.max(0, event.damage), steps };
}
