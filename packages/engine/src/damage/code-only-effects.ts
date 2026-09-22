/**
 * The damage effects registered in Java with no JSON behind them.
 *
 * Seven of the fourteen layers have **no `modify_stat_layer` entry at all** — conversion,
 * ele-as-extra, taken-as, all three mitigations and flat reduction. Everything that writes to
 * them lives here. Without this file a build's armour, resists and penetration would silently
 * do nothing, which is the failure mode that would be hardest to notice: the numbers would
 * look plausible and be uniformly too high.
 *
 * These are hand-ported rather than generated. `tools/port-code-only-stats.mjs` can read field
 * assignments; it cannot read an overridden method body, and these are all method bodies —
 * `ElementalResistEffect` zeroes physical penetration halfway through, `ArmorEffect` signs its
 * own output by whether armour-after-penetration went negative. Each is quoted at its call
 * site, following the precedent `code-only-behaviour.ts` set.
 *
 * Source throughout: mahjerion/Mine-And-Slash-Rework @ `1.20-Forge`.
 */

import {
  ELEMENTS,
  SINGLE_ELEMENTAL,
  CONVERTED_ELEMENTS,
  SINGLE_ELEMENTS,
  elementByGuid,
  type ElementName,
} from "@cte2/schema";

import {
  BLOCK_BASE_CAP,
  RESIST_BASE_CAP,
  RESIST_HARD_CAP,
  USABLE_STATS,
} from "../code-only-behaviour.js";
import { AILMENTS } from "./ailments.js";
import { clamp } from "../container.js";
import { sheetValue, type DamageCtx } from "./ctx.js";
import { EVENT, type EffectSide } from "./event.js";
import { LAYER } from "./layers.js";
import { PRIORITY } from "./priority.js";

/** `mmorpg_stat`'s event id for the once-a-second regeneration tick. */
const ON_RESTORE_RESOURCE = "on_restore_resource";

/** `MAX_CONVERSION_DEPTH` (DamageEvent.java:96). */
export const MAX_CONVERSION_DEPTH = 2;

export type InCodeEffect = {
  /** The stat id this effect belongs to. */
  statId: string;
  priority: number;
  side: EffectSide;
  /**
   * Which event the effect listens to — `InCodeStatEffect`'s type parameter.
   *
   * Almost everything here is a `DamageEvent`, and defaulting to that keeps the table readable.
   * The regen family is a `RestoreResourceEvent`, and mixing the two would let armour mitigate a
   * mana tick.
   */
  event?: string;
  /** `runsOnZeroStat()` — only `ArmorEffect` returns true. */
  runsOnZero: boolean;
  /** `canActivate` then `activate`. `value` is `StatData.getValue()`. */
  run(ctx: DamageCtx, value: number, dmgMulti: number): void;
};

/**
 * Builds the in-code effect table for this snapshot.
 *
 * Element-generated stats (`fire_resist`, `phys_to_water`, …) are expanded here rather than
 * listed, because `generateAllPossibleStatVariations` expands them in the game the same way
 * and a hand-written list would drift the moment an element is added.
 */
export function inCodeEffects(): InCodeEffect[] {
  const out: InCodeEffect[] = [];

  // --- penetration, BEFORE_DAMAGE_LAYERS (19), Source ---------------------------------
  //
  //     effect.data.getNumber(EventData.PENETRATION).number += data.getValue();
  //     ...
  //     return effect.GetElement().equals(stat.getElement()) && !stat.getElement().equals(Elements.Elemental);
  //
  // — ElementalPenetration.java:70-94. One shared scalar for every element, which is why the
  // physical special case in `ElementalResistEffect` below has to exist at all.
  for (const element of Object.values(ELEMENTS)) {
    if (element.name === "Elemental" || element.name === "ALL") continue;
    out.push({
      statId: `${element.guid}_penetration`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (ctx.event.data.getElement() !== element.name) return;
        ctx.event.penetration += value;
      },
    });
  }

  // `ArmorPenetration` (ArmorPenetration.java:51-73) — same priority and side, gated on
  // physical, feeding the same scalar.
  out.push({
    statId: "armor_penetration",
    priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
    side: "Source",
    runsOnZero: false,
    run(ctx, value) {
      if (ctx.event.data.getElement() !== "Physical") return;
      ctx.event.penetration += value;
    },
  });

  // --- additive increases, BEFORE_DAMAGE_LAYERS (19), Source ---------------------------
  //
  //     effect.getLayer(StatLayers.Offensive.ADDITIVE_DMG, EventData.NUMBER, Side()).add(data.getValue());
  //     if (stat.getMultiUseType() == Stat.MultiUseType.MULTIPLICATIVE_DAMAGE) {
  //         effect.addMoreMulti(stat, EventData.NUMBER, data.getMoreStatTypeMulti());
  //     }
  //
  // — BaseDamageIncreaseEffect.java:25-36. This is the same thing 15 datapack stats do through
  // `_additive_damage_number_add_stat_data`; these two carry it in Java instead, so nothing in
  // the pack's JSON points at them and they were contributing nothing.
  //
  // `spell_damage` is the expensive one. Its player-facing name is **Skill Damage**
  // (SkillDamage.java:48) and `canActivate` is `effect.isSpell()` — every skill on the bar, not
  // just an INT one — so on a build that stacks it, it is the single largest term in the
  // additive layer. CTE2 feeds it from `skill_damage_per_inc_leech`, which turns `inc_leech`
  // into Skill Damage one for one.
  out.push({
    statId: "spell_damage",
    priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
    side: "Source",
    runsOnZero: false,
    run(ctx, value, dmgMulti) {
      if (!ctx.event.data.getString(EVENT.SPELL)) return;
      additiveIncrease(ctx, "spell_damage", value, dmgMulti);
    },
  });

  // `HitDamage.java:31-42` — "Direct Hit Damage", gated on the event carrying no ailment, so a
  // bleed or burn tick is excluded and the hit that applied it is not.
  out.push({
    statId: "hit_damage",
    priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
    side: "Source",
    runsOnZero: false,
    run(ctx, value, dmgMulti) {
      if (ctx.event.data.getString(EVENT.AILMENT) !== "") return;
      additiveIncrease(ctx, "hit_damage", value, dmgMulti);
    },
  });

  // `AllAilmentDamage.java` and `AilmentDamage.java` — the mirror of `hit_damage`, and the two
  // stats that make an ailment's own event worth running at all:
  //
  //     // AllAilmentDamage
  //     return !effect.data.getString(EventData.AILMENT).isEmpty();
  //     // AilmentDamage, one per ailment
  //     return effect.data.getString(EventData.AILMENT).equals(ailment.GUID());
  //
  // Both are `BaseDamageIncreaseEffect`, so both land in the additive layer, and neither can
  // reach anything but the second event `AilmentChance.activate` raises — which is the only
  // event in the game that carries an `AILMENT`. 20 pack references to `ailment_damage` alone.
  out.push({
    statId: "ailment_damage",
    priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
    side: "Source",
    runsOnZero: false,
    run(ctx, value, dmgMulti) {
      if (ctx.event.data.getString(EVENT.AILMENT) === "") return;
      additiveIncrease(ctx, "ailment_damage", value, dmgMulti);
    },
  });
  for (const ailment of AILMENTS) {
    const statId = `${ailment.id}_damage`;
    out.push({
      statId,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value, dmgMulti) {
        if (ctx.event.data.getString(EVENT.AILMENT) !== ailment.id) return;
        additiveIncrease(ctx, statId, value, dmgMulti);
      },
    });
  }

  // --- flat added damage, BEFORE_DAMAGE_LAYERS (19), Source ----------------------------
  //
  //     float num = NumberModifier.ModifierType.SPELL_DAMAGE_EFFECTIVENESS_MULTI.modify(effect, data.getValue());
  //     effect.addBonusEleDmg(stat.getElement(), num, Side());
  //
  // — BonusFlatElementalDamage.java:78-93 and its two siblings. Three things about this are
  // load-bearing and none of them is obvious from the stat's name:
  //
  //   - **the value is multiplied by the spell's damage effectiveness** before it lands, which
  //     for a `dmg_effectiveness` of `{min 2.1, max 2.6}` read at rank 20 of 28 is ×2.46. Flat
  //     added damage is therefore worth two and a half times its sheet value on a skill built
  //     to carry it, and a fraction of it on one that is not — that multi is the only knob
  //     `dmg_effectiveness` turns anywhere in the game;
  //   - **it goes onto `flat_damage`, before the additive layer**, so every `+% damage` on the
  //     character multiplies it too. On the reference build `flat_physical_added_damage` is 973,
  //     which is larger than the skill's own 750 base;
  //   - **`IS_BONUS_ELEMENT_DAMAGE` blocks it.** A converted or extra-element child event must
  //     not add the flat damage a second time.
  //
  // `BonusAttackDamage` (`<ele>_weapon_damage`) is the odd one out: no effectiveness multi, and
  // `isBasicAttack() && getAttackType() == hit` — a weapon swing only, never a skill.
  for (const element of SINGLE_ELEMENTS) {
    out.push({
      statId: `flat_${element.guid}_added_damage`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!isDirectHit(ctx) || isBonusElementDamage(ctx)) return;
        addFlatWithEffectiveness(ctx, element.name, value);
      },
    });

    // `BonusFlatAttackElementalDamage.java:79-97` — the same, plus `getStyle() != PlayStyle.INT`.
    out.push({
      statId: `flat_${element.guid}_added_attack_damage`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!isDirectHit(ctx) || isBonusElementDamage(ctx)) return;
        if (ctx.event.data.getString(EVENT.STYLE, "str") === "int") return;
        addFlatWithEffectiveness(ctx, element.name, value);
      },
    });

    // `BonusFlatMagicElementalDamage.java:79-98` — the mirror: a skill, and a `magic`-tagged one.
    out.push({
      statId: `flat_${element.guid}_added_magic_damage`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!isDirectHit(ctx) || isBonusElementDamage(ctx)) return;
        if (!ctx.event.data.getString(EVENT.SPELL)) return;
        if (!ctx.spellTags.has("magic")) return;
        addFlatWithEffectiveness(ctx, element.name, value);
      },
    });

    // `BonusAttackDamage.java:71-94` — basic attacks only, and the raw value.
    out.push({
      statId: `${element.guid}_weapon_damage`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!ctx.event.data.getBoolean(EVENT.IS_BASIC_ATTACK)) return;
        if (!isDirectHit(ctx)) return;
        ctx.event.addBonusEleDmg(element.name, value, "Source");
      },
    });
  }

  // --- conversion, DAMAGE_LAYERS (20), Source -----------------------------------------
  //
  //     effect.getLayer(StatLayers.Offensive.DAMAGE_CONVERSION, EventData.NUMBER, Side())
  //           .convertDamage(getElement(), (int) data.getValue());
  //
  // — PhysicalToElement.java:80-82. Note the `(int)` truncation of the percentage, and that
  // `canActivate` allows `bonus_dmg` as well as a hit: flat physical damage added to a
  // non-physical skill arrives as its own bonus-element event and would otherwise convert
  // nothing.
  //
  // The loop is over **every single element**, not just the three elemental ones.
  // `generateAllPossibleStatVariations` generates one of these per element, and the pack rolls
  // `phys_to_chaos` on three perks, six uniques, a runeword, two exile effects and a map affix —
  // 55 references in all, and 82.9 on the reference character. Generating only Fire/Cold/Nature
  // silently threw all of it away, and the `Elemental` aggregate does not cover it either:
  // `ElementalStat.transferStats` splits an `Elemental` variant into `getAllSingleElemental()`,
  // which is exactly the three that were already here.
  //
  // `phys_to_physical` (two perks) is included on purpose even though converting physical to
  // physical is self-evidently strange. `addBonusEleDmg` routes a matching element back onto the
  // `flat_damage` layer, which sits at priority 0 and has already flushed by the time conversion
  // runs at 1 — so the damage leaves `NUMBER` and never arrives. That is what the game does with
  // those two perks, and reproducing it is the point.
  //
  // The loop is `CONVERTED_ELEMENTS` rather than `SINGLE_ELEMENTS`, which adds `ALL` — see that
  // constant for why `Elemental` stays out and `ALL` does not. `phys_to_all` and
  // `phys_to_all_big` are two perks at 10% and 25%, and were the only conversion content this
  // engine was losing.
  for (const element of CONVERTED_ELEMENTS) {
    out.push({
      statId: `phys_to_${element.guid}`,
      priority: PRIORITY.DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!physicalSourceHit(ctx)) return;
        ctx.event
          .getLayer(LAYER.DAMAGE_CONVERSION, EVENT.NUMBER, "Source")
          ?.addConversion(element.name, Math.trunc(value));
      },
    });

    // `BonusPhysicalAsElemental` (BonusPhysicalAsElemental.java:60-91) — BEFORE_DAMAGE_LAYERS,
    // and a *conversion layer* keyed on the target element rather than the plain one.
    out.push({
      statId: `plus_phys_to_${element.guid}`,
      priority: PRIORITY.BEFORE_DAMAGE_LAYERS,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!physicalSourceHit(ctx)) return;
        const layer = ctx.event.getConversionLayer(
          LAYER.ELE_AS_EXTRA_FLAT,
          element.name,
          EVENT.NUMBER,
          "Source",
        );
        // `convertAdditional(getElement(), (int) data.getValue())`. Two details, both of which
        // the bare `layer.number += value` this replaces got wrong:
        //
        //   - the `(int)` is a truncation, so 15.7% of physical as extra fire is 15%;
        //   - writing the field directly walked past `LayerData.add`, and with it past the
        //     recorder — so a breakdown showed an `ele_as_extra_flat` total with no rows under
        //     it. This is the stat four corruption affixes grant, so that was the common case.
        //
        // The game *assigns* where this adds. They agree because `getConversionLayer` keys an
        // accumulator per target element and exactly one stat writes each: `plus_phys_to_elemental`
        // is split across the three single elementals before any hit is rolled.
        layer?.add(Math.trunc(value));
      },
    });

    // `PhysicalDamageTakenAs` (PhysicalDamageTakenAs.java:66-92) — Target side, DAMAGE_LAYERS.
    out.push({
      statId: `phys_taken_as_${element.guid}`,
      priority: PRIORITY.DAMAGE_LAYERS,
      side: "Target",
      runsOnZero: false,
      run(ctx, value) {
        // The same `canActivate` as the two above, to the byte: all three disassemble
        // identically in `Mine_and_Slash-1.20.1-6.4.13.jar`, attack-type clause included. Only
        // the element and the depth were checked here, so the mitigation also fired on damage
        // over time — which is not a hit, takes no `bonus_dmg` path, and the game leaves alone.
        if (!physicalSourceHit(ctx)) return;
        ctx.event
          .getLayer(LAYER.DAMAGE_TAKEN_AS, EVENT.NUMBER, "Target")
          ?.addConversion(element.name, Math.trunc(value));
      },
    });
  }

  // `ElementalToChaos` (ElementalToChaos.java:33-60) — the mirror of `phys_to_*`, and the only
  // conversion with no element loop behind it because its target is always Shadow:
  //
  //     effect.getLayer(StatLayers.Offensive.DAMAGE_CONVERSION, EventData.NUMBER, Side())
  //           .convertDamage(Elements.Shadow, (int) data.getValue());
  //
  // Its gate is the other way round from the physical family: the *hit* has to be a single
  // elemental one — fire, cold or lightning — which is what the `isElemental && isSingleElement`
  // pair says. A physical or chaos hit is left alone.
  out.push({
    statId: "ele_to_chaos",
    priority: PRIORITY.DAMAGE_LAYERS,
    side: "Source",
    runsOnZero: false,
    run(ctx, value) {
      const hit = ELEMENTS[ctx.event.data.getElement()];
      if (!hit.isElemental || hit.multi.length > 0) return;
      if (ctx.event.conversionDepth >= MAX_CONVERSION_DEPTH) return;
      const attackType = ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit");
      if (attackType !== "hit" && attackType !== "bonus_dmg") return;
      ctx.event
        .getLayer(LAYER.DAMAGE_CONVERSION, EVENT.NUMBER, "Source")
        ?.addConversion("Shadow", Math.trunc(value));
    },
  });

  // --- resists, DAMAGE_LAYERS (20), Target --------------------------------------------
  for (const element of Object.values(ELEMENTS)) {
    if (element.name === "Elemental" || element.name === "ALL") continue;
    out.push({
      statId: `${element.guid}_resist`,
      priority: PRIORITY.DAMAGE_LAYERS,
      side: "Target",
      // `ElementalResistEffect.runsOnZeroStat()` returns **true**, the same as `ArmorEffect`,
      // and for the same reason: penetration is spent inside this effect, so skipping it
      // against a target with no resistance would silently throw the penetration away. It also
      // made the mitigation curve non-monotonic — 18 penetration was worth +8% damage against
      // 10 resistance and nothing at all against 0.
      runsOnZero: true,
      run: (ctx, value) => resistEffect(ctx, element.name, value),
    });
  }

  // --- armour, DAMAGE_LAYERS (20), Target, runs at zero -------------------------------
  out.push({
    statId: "armor",
    priority: PRIORITY.DAMAGE_LAYERS,
    side: "Target",
    runsOnZero: true,
    run: armorEffect,
  });

  // --- dodge, HIT_PREVENTION (10), Target ----------------------------------------------
  //
  //     float totalDodge = Mth.clamp(data.getValue() - effect.data.getNumber(ACCURACY).number, 0, MAX);
  //     float chance = dodge.getUsableValue(effect.targetData.getUnit(), (int) totalDodge, effect.sourceData.getLevel()) * 100;
  //     return effect.getAttackType().isAttack() && RandomUtils.roll(chance);
  //     ...
  //     effect.data.setHitAvoided(EventData.IS_DODGED);
  //
  // — DodgeRating.java:75-117. Narrow: physical only, `AttackType.hit` only, and never against a
  // spell tagged `magic`. The attacker's accuracy is subtracted first, and the curve is read at
  // the *attacker's* level, exactly as armour is.
  //
  // A roll that lands zeroes the hit outright. A figure averaged over many hits is not one hit,
  // so this multiplies by `1 - chance` on the block layer instead — the same expectation, and the
  // only form a DPS number or an eHP number can use. `damage_block` is `MULTIPLY` clamped to
  // `[0, 1]` and nothing in the pack writes to it, so it is free for exactly this.
  //
  // Why all three avoidance stats sit at `HIT_PREVENTION` rather than at `DAMAGE_LAYERS`:
  // `GetPriority()` says so in `DodgeRating$Effect`, `SpellDodgeEffect` and `BlockChance$Effect`
  // alike — three bytecodes each, `getstatic` then `areturn`, with no branch in any of them. All
  // three were registered at 20 here, which is where `ArmorEffect` and `ElementalResistEffect`
  // really do run.
  //
  // It is tempting to read a *partial* block as a damage-layer operation, since Glancing Strikes
  // makes `applyBlock` reduce a layer instead of avoiding the hit. But `block_damage_reduction`
  // changes what `applyBlock` does, not when the effect runs: the priority is fixed on the class,
  // so a Glancing block is still hit prevention that happens to leave damage behind.
  //
  // Mostly this is inert — all three only `reduce` the same `MULTIPLY` layer, and multiplication
  // does not care what order they ran in. It is not inert for `double_attack_chance` and
  // `double_attack_chance_when_low`, the pack's only two `damage_layers` effects gated on
  // `is_is_dodged_true_is_false`. At 20 those read `is_dodged` out of the same bucket that writes
  // it, so the answer came down to a tie-break; at 10 the write always precedes the read, which
  // is the order the game guarantees.
  out.push({
    statId: "dodge",
    priority: PRIORITY.HIT_PREVENTION,
    side: "Target",
    runsOnZero: false,
    run: dodgeEffect,
  });

  // --- spell dodge, HIT_PREVENTION (10), Target ----------------------------------------
  //
  //     float totalDodge = Mth.clamp(data.getValue() - effect.data.getNumber(ACCURACY).number, 0, MAX);
  //     float chance = spellDodge.getUsableValue(effect.targetData.getUnit(), (int) totalDodge,
  //             effect.sourceData.getLevel()) * 100;
  //     ...
  //     return effect.canAvoidHit() && !effect.data.isHitAvoided()
  //             && !effect.data.getBoolean(AVOIDANCE_ROLLED)
  //             && (effect.getAttackType().isHit() || effect.getAttackType() == bonus_dmg)
  //             && effect.isSpell() && effect.getSpell().config.tags.contains(SpellTags.magic);
  //
  // — SpellDodgeEffect, verified in 6.4.13. The exact complement of dodge above, and the pair
  // partitions every hit: dodge takes physical non-`magic` hits, this takes `magic` spells of
  // **any** element, and `AVOIDANCE_ROLLED` stops both from rolling on the same hit.
  //
  // It was previously unported, and the audit tracked it as a gap — but nothing could reach it
  // either way, because `EnemySetup` had no field to put it on a target. Now that a preset fills
  // one from `mmorpg_base_stats/mob`, every mob in the pack carries 15 per level of it, and a
  // magic build measured against a target with none was measuring against a mob that does not
  // exist. The curve is its own: `valueNeededAtLevelOne` is 200 where dodge's is 100, so a point
  // of spell dodge is worth half a point of dodge.
  out.push({
    statId: "spell_dodge",
    priority: PRIORITY.HIT_PREVENTION,
    side: "Target",
    runsOnZero: false,
    run: spellDodgeEffect,
  });

  // --- block, HIT_PREVENTION (10), Target ----------------------------------------------
  //
  //     float reduction = BlockChance.getBlockDamageReduction(effect.targetData);
  //     if (isInheritedBlock(effect)) { applyBlock(effect, reduction); return effect; }
  //     float chance = ((BlockChance) stat).getUsableValue(
  //             effect.targetData.getUnit(), (int) data.getValue(), effect.targetData.getLevel()) * 100F;
  //     if (RandomUtils.roll(chance)) {
  //         applyBlock(effect, reduction);
  //         effect.targetData.getCooldowns().setOnCooldown(BLOCK_CD, getBlockCooldownTicks(effect.targetData));
  //     }
  //
  //     private static void applyBlock(DamageEvent effect, float reduction) {
  //         if (reduction >= 100) {
  //             effect.data.setHitAvoided(EventData.IS_BLOCKED);
  //         } else {
  //             effect.getLayer(StatLayers.Defensive.DAMAGE_BLOCK, EventData.NUMBER, Side()).reduce(reduction);
  //             effect.data.setBoolean(EventData.IS_BLOCKED, true);
  //         }
  //     }
  //
  // — `BlockChance$Effect`, read out of `Mine_and_Slash-1.20.1-6.4.13.jar`. The port this
  // replaced was stale in four separate ways — the layer, the amount, the clamp on the chance and
  // the missing gates — and the comment above it described a game that no longer exists. There is
  // no `50` anywhere in the class.
  //
  // The fifth was the priority, and it was wrong for all three avoidance stats at once — see
  // the note on {@link dodgeEffect}.
  //
  // What a block stops is `block_damage_reduction`, whose **base is 100** — so by default a
  // blocked hit is stopped outright and `applyBlock` takes the `setHitAvoided` branch without
  // touching a layer at all. The stat exists for Glancing Strikes
  // (`mmorpg_perk/glancing_strikes.json`: `MORE block_chance +100`, `FLAT max_block_chance +15`,
  // `FLAT block_damage_reduction -65`), which buys frequency with effectiveness. The old port
  // charged every build the Glancing trade and then some, and overpaid a Glancing build.
  //
  // The layer is `damage_block`, not `damage_suppression`. That is not bookkeeping: suppression
  // floors at `min_multi 0.5`, so a block written there could never stop more than half a hit,
  // and it shared that one floor with the real suppression stats — two mitigations contending
  // for one clamp. `damage_block` floors at 0, which is what lets a full block reach zero.
  //
  // Averaged onto that layer the same way dodge is, and for the same reason: `reduce(r * p)`
  // leaves `1 - rp/100`, which is exactly `(1 - p) + p(1 - r/100)`. At the default `r = 100`
  // that is dodge's own `reduce(100 * p)`, so the `>= 100` full-avoidance branch and the
  // averaged form agree at both ends without being written twice.
  out.push({
    statId: "block_chance",
    priority: PRIORITY.HIT_PREVENTION,
    side: "Target",
    runsOnZero: false,
    run: blockEffect,
  });

  // --- damage shield, DAMAGE_LAYERS (20), Target --------------------------------------
  //
  //     effect.getLayer(StatLayers.Defensive.FLAT_DAMAGE_REDUCTION, EventData.NUMBER, Side()).reduce(data.getValue());
  //
  // — DamageShield.java:51-72, with `canActivate` returning `true` unconditionally.
  out.push({
    statId: "damage_shield",
    priority: PRIORITY.DAMAGE_LAYERS,
    side: "Target",
    runsOnZero: false,
    run(ctx, value) {
      ctx.event.getLayer(LAYER.FLAT_DAMAGE_REDUCTION, EVENT.NUMBER, "Target")?.reduce(value);
    },
  });

  // --- damage taken to mana, FINAL_DAMAGE (100), Target --------------------------------
  //
  //     float restore = effect.data.getNumber() * data.getValue() / 100F; // todo dmg number
  //     if (restore > 0) {
  //         RestoreResourceEvent mana = EventBuilder
  //                 .ofRestore(effect.source, effect.target, ResourceType.mana, RestoreType.heal, restore)
  //                 .build();
  //         mana.Activate();
  //     }
  //
  // — `DamageTakenToMana$Effect`, with `canActivate` returning a bare `true`. Read out of
  // `Mine_and_Slash-1.20.1-6.4.13.jar`, where the bytecode is the fork's line for line, down to
  // the `getstatic RestoreType.heal`.
  //
  // **`heal`, not `leech`, and the difference is the whole point.** `RestoreResourceEvent.activate`
  // branches
  //
  //     if (data.getRestoreType() == RestoreType.leech) {
  //         this.targetData.leech.addLeech(data.getResourceType(), num);
  //         return;
  //     }
  //     this.targetData.getResources().restore(target, data.getResourceType(), num);
  //
  // so a leech joins the pool that `<r>_leech_cap` meters out and a heal lands whole and at once.
  // `leech()` in `resources.ts` already skips any record whose `restoreType` is not `leech`, so
  // pushing this as a `heal` is what keeps the mana cap off it.
  //
  // This is a **Target**-side effect, so it only ever fires on a hit *you* take. Every figure the
  // engine currently produces is a hit you deal, which is why porting it moves nothing today; it
  // pays out once there is an incoming hit to run it on.
  //
  // Nothing in this pack grants the stat — a search of every registry finds the definition and no
  // reference — so it is inert on every real build. That is a finding rather than a reason to
  // leave it unported: an unimplemented stat is indistinguishable from one that reads zero, and
  // the next pack update may well grant it.
  out.push({
    statId: "dmg_taken_to_mana",
    priority: PRIORITY.FINAL_DAMAGE,
    side: "Target",
    runsOnZero: false,
    run(ctx, value) {
      const sink = ctx.restores;
      if (sink === undefined) return;
      const restore = (ctx.event.data.getNumber(EVENT.NUMBER) * value) / 100;
      if (restore <= 0) return;
      sink.push({
        statId: "dmg_taken_to_mana",
        effectId: "dmg_taken_to_mana",
        resource: "mana",
        restoreType: "heal",
        amount: restore,
      });
    },
  });

  // --- regeneration, on_restore_resource, Source --------------------------------------
  //
  // Two families, one per resource, and both fire on the same once-a-second tick:
  //
  //     // BaseRegenClass, `<r>_regen`
  //     effect.data.getNumber(EventData.NUMBER).number += data.getValue();
  //
  //     // RegeneratePercentStat, `<r>_per_sec`
  //     effect.data.getNumber(EventData.NUMBER).number += maxGetter.apply(effect.targetData) * data.getValue() / 100F;
  //
  // both gated on `resourceType == getResourceType() && restoreType == RestoreType.regen`
  // (verified in 6.4.13). They seed the event's number; the datapack percents — `resource_regen`,
  // `out_of_combat_regen`, `blood_regen` — then multiply it on the `additive_damage` layer, which
  // is why this has to run through the same sweep rather than beside it.
  //
  // `OnServerTick` raises that tick for mana, energy, magic shield and health, and for nothing
  // else: **blood has no tick of its own**, which is why a blood build lives off
  // `hp_resto_to_blood` (see `resources.ts`).
  for (const resource of ["health", "mana", "energy", "magic_shield"]) {
    out.push({
      statId: `${resource}_regen`,
      event: ON_RESTORE_RESOURCE,
      priority: PRIORITY.FIRST,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!isRegenOf(ctx, resource)) return;
        ctx.event.data.setNumber(EVENT.NUMBER, ctx.event.data.getNumber(EVENT.NUMBER) + value);
      },
    });
    out.push({
      statId: `${resource}_per_sec`,
      event: ON_RESTORE_RESOURCE,
      priority: PRIORITY.FIRST,
      side: "Source",
      runsOnZero: false,
      run(ctx, value) {
        if (!isRegenOf(ctx, resource)) return;
        // `maxGetter` reads the **target's** maximum. A regen tick is self-cast, so the two
        // sheets are the same one, and `ctx.target` is where this reads it.
        const max = ctx.target.get(resource)?.value ?? 0;
        ctx.event.data.setNumber(EVENT.NUMBER, ctx.event.data.getNumber(EVENT.NUMBER) + (max * value) / 100);
      },
    });
  }

  return out;
}

/** `BaseRegenClass.canActivate` — this resource, and only the once-a-second regen tick. */
function isRegenOf(ctx: DamageCtx, resource: string): boolean {
  return (
    ctx.event.data.getString(EVENT.RESOURCE_TYPE, "") === resource &&
    ctx.event.data.getString(EVENT.RESTORE_TYPE, "") === "regen"
  );
}

/**
 * `ElementalResistEffect.activate` (ElementalResistEffect.java:28-56).
 *
 *     float pene = effect.getPenetration();
 *     // otherwise phys pene makes this do.. 10x the dmg as its a flat pene value and its used here as a % value
 *     if (stat.getElement() == Elements.Physical) { pene = 0; }
 *     float resist = data.getValue();
 *     resist -= pene;
 *     var usable = (IUsableStat) stat;
 *     resist = usable.getUsableValue(effect.targetData.getUnit(), (int) resist, effect.targetData.getLevel()) * 100F;
 *     ...
 *     effect.data.setBoolean(EventData.RESISTED_ALREADY, true);
 *
 * Physical is the odd one out twice over: its penetration is discarded here (armour
 * penetration is a flat value, not a percentage, and is spent by `ArmorEffect` instead), and
 * it reduces `physical_mitigation` rather than `elemental_mitigation`.
 */
function resistEffect(ctx: DamageCtx, element: ElementName, value: number): void {
  // `canActivate`: skip the aggregate, skip if something already resisted, require a match.
  if (element === "Elemental") return;
  if (ctx.event.data.getBoolean(EVENT.RESISTED_ALREADY)) return;
  if (ctx.event.data.getElement() !== element) return;

  const pene = element === "Physical" ? 0 : ctx.event.penetration;
  const raw = Math.trunc(value - pene);

  // `ElementalResist.getUsableValue` — the ceiling is 75 plus this element's max-resist stat,
  // clamped to 90. The `* 100F` in the caller cancels the method's `/ 100F`.
  const guid = ELEMENTS[element].guid;
  const usable = USABLE_STATS[`${guid}_resist`];
  const maxStat = usable && usable.kind === "resist" ? usable.maxStat : `max_${guid}_resist`;
  const min = ctx.index.shapeOf(`${guid}_resist`).min;
  const cap = clamp(RESIST_BASE_CAP + sheetValue(ctx.target, maxStat), min, RESIST_HARD_CAP);
  const resist = clamp(raw, min, cap);

  const layerId = element === "Physical" ? LAYER.PHYSICAL_MITIGATION : LAYER.ELEMENTAL_MITIGATION;
  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.getLayer(layerId, EVENT.NUMBER, "Target")?.reduce(resist);
  // The four numbers this row is made of, so the panel can print the subtraction rather than a
  // result. Nothing reads them unless a breakdown was asked for.
  recorder?.annotateSince(before, {
    sheet: value,
    penetration: pene,
    // The subtraction, not `raw`: `raw` has already been truncated, and the truncation is one of
    // the steps the panel has to be able to show.
    afterPenetration: value - pene,
    min,
    cap,
  });
  ctx.event.data.setBoolean(EVENT.RESISTED_ALREADY, true);
}

/**
 * `ArmorEffect.activate` (ArmorEffect.java:39-66).
 *
 *     float afterPene = data.getValue() - effect.getPenetration();
 *     int points = Math.round(Math.abs(afterPene));
 *     if (points == 0) { return effect; }
 *     float EffectiveArmor = armor.getUsableValue(effect.targetData.getUnit(), points, effect.sourceData.getLevel());
 *     EffectiveArmor = Mth.clamp(EffectiveArmor, 0, armor.getMaxMulti());
 *     // so it can go in negative too if player has high armor pen
 *     float defense = EffectiveArmor * (afterPene > 0 ? 100F : -100F);
 *
 * Three things worth keeping. It runs at zero armour so leftover penetration is not dropped —
 * having no armour at all would otherwise beat having a little. The curve is evaluated at the
 * **attacker's** level, not the target's, unlike every resist. And the sign flip means enough
 * armour penetration actively *increases* damage rather than merely cancelling mitigation.
 */
function armorEffect(ctx: DamageCtx, value: number): void {
  if (ctx.event.data.getElement() !== "Physical") return;

  const afterPene = value - ctx.event.penetration;
  const points = Math.round(Math.abs(afterPene));
  if (points === 0) return;

  const usable = USABLE_STATS["armor"];
  if (!usable || usable.kind !== "curve") return;

  const shape = ctx.index.shapeOf("armor");
  const base = usable.valueNeededAtLevelOne * ctx.balance.multiFor(shape.scaling, ctx.sourceLevel);
  const fraction = points + base === 0 ? 0 : points / (points + base);
  const effective = clamp(fraction, 0, usable.maxMulti);

  const defense = effective * (afterPene > 0 ? 100 : -100);
  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.getLayer(LAYER.ARMOR_MITIGATION, EVENT.NUMBER, "Target")?.reduce(defense);
  // No `cap`: armour's ceiling is the curve's `maxMulti` on the *fraction*, not a bound on the
  // rating, so quoting one here would name a number that never applied to these points.
  recorder?.annotateSince(before, {
    sheet: value,
    penetration: ctx.event.penetration,
    afterPenetration: afterPene,
    points,
  });
}

/**
 * `DodgeRating.Effect` — see the registration above for the quoted source.
 *
 * The accuracy subtraction is the attacker's `accuracy` stat, which the sweep has already written
 * onto the event by the time the defensive layers run.
 */
/**
 * `DamageEvent.canAvoidHit()` — `return source != target;`
 *
 *     // you can't dodge or block a hit you inflicted on yourself - self damage is a resource
 *     // cost, not an incoming attack. mitigation still applies, only avoidance is skipped.
 *
 * Three stats check it before they roll: `DodgeRating`, `BlockChance` and `SpellDodgeEffect`
 * (the third is an accounted gap here). Mitigation — armour, the resists, `dmg_received` — is
 * deliberately *not* behind it, which is what makes a self-hit's log a block of `[Target]` lines
 * with an armour multiplier and no dodge. Confirmed present in `Mine_and_Slash-1.20.1-6.4.13.jar`,
 * not only in the fork.
 */
function canAvoidHit(ctx: DamageCtx): boolean {
  // `noAvoidance` is a caller describing a worst case rather than a property of the hit — see
  // `DamageCtx.noAvoidance`. It rides the same branch because the game's own rule and the
  // maximum-hit question want exactly the same thing: mitigation, no rolls.
  return !ctx.sourceIsTarget && ctx.noAvoidance !== true;
}

function dodgeEffect(ctx: DamageCtx, value: number): void {
  if (!canAvoidHit(ctx)) return;
  if (ctx.event.data.getElement() !== "Physical") return;
  if (ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit") !== "hit") return;
  // `effect.isSpell() && spell.config.tags.contains(SpellTags.magic)` — a magic spell is never
  // dodged, however physical its element.
  if (ctx.spellTags.has("magic")) return;

  const usable = USABLE_STATS["dodge"];
  if (!usable || usable.kind !== "curve") return;

  const accuracy = ctx.event.data.getNumber(EVENT.ACCURACY);
  const points = Math.trunc(Math.max(0, value - accuracy));
  if (points <= 0) return;

  const shape = ctx.index.shapeOf("dodge");
  const base = usable.valueNeededAtLevelOne * ctx.balance.multiFor(shape.scaling, ctx.sourceLevel);
  const fraction = points + base === 0 ? 0 : points / (points + base);
  const chance = clamp(fraction, 0, usable.maxMulti);
  if (chance <= 0) return;

  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.getLayer(LAYER.DAMAGE_BLOCK, EVENT.NUMBER, "Target")?.reduce(100 * chance);
  // The three numbers this row is made of. `afterPenetration` is the subtraction *before* the
  // truncation, exactly as the resist layers record it, so the panel can show the fraction of a
  // point the `(int)` cast drops rather than leaving it to be noticed as a rounding error.
  recorder?.annotateSince(before, {
    sheet: value,
    penetration: 0,
    accuracy,
    afterPenetration: value - accuracy,
    points,
  });
  if (chance >= 1) ctx.event.data.setBoolean(EVENT.IS_DODGED, true);
}

/**
 * `SpellDodgeEffect` — dodge's mirror, for `magic` spells.
 *
 * Averaged onto the same `damage_block` layer for the same reason: a roll that lands zeroes the
 * hit, and a figure over many hits is not one hit. The two cannot both fire on one event in the
 * game because the first to run sets `AVOIDANCE_ROLLED`, and they cannot here either — their
 * gates are disjoint, since dodge refuses a `magic` spell and this one requires it.
 */
function spellDodgeEffect(ctx: DamageCtx, value: number): void {
  if (!canAvoidHit(ctx)) return;
  const attackType = ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit");
  if (attackType !== "hit" && attackType !== "bonus_dmg") return;
  // `effect.isSpell() && tags.contains(SpellTags.magic)` — no element condition at all, unlike
  // dodge: a magic spell is evaded by this whatever it is made of.
  if (!ctx.spellTags.has("magic")) return;

  const usable = USABLE_STATS["spell_dodge"];
  if (!usable || usable.kind !== "curve") return;

  const accuracy = ctx.event.data.getNumber(EVENT.ACCURACY);
  const points = Math.trunc(Math.max(0, value - accuracy));
  if (points <= 0) return;

  const shape = ctx.index.shapeOf("spell_dodge");
  const base = usable.valueNeededAtLevelOne * ctx.balance.multiFor(shape.scaling, ctx.sourceLevel);
  const fraction = points + base === 0 ? 0 : points / (points + base);
  const chance = clamp(fraction, 0, usable.maxMulti);
  if (chance <= 0) return;

  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.getLayer(LAYER.DAMAGE_BLOCK, EVENT.NUMBER, "Target")?.reduce(100 * chance);
  recorder?.annotateSince(before, {
    sheet: value,
    penetration: 0,
    accuracy,
    afterPenetration: value - accuracy,
    points,
  });
  if (chance >= 1) ctx.event.data.setBoolean(EVENT.IS_DODGED, true);
}

/**
 * `BlockChance$Effect` — a shield roll, averaged.
 *
 * Gates the old port had none of, all from `canActivate`:
 *
 *     if (!effect.canAvoidHit()) { return false; }
 *     if (isInheritedBlock(effect)) { return true; }
 *     if (effect.data.isHitAvoided()) { return false; }
 *     if (effect.targetData.getCooldowns().isOnCooldown(BlockChance.BLOCK_CD)) { return false; }
 *     if (!(effect.target.getOffhandItem().getItem() instanceof ShieldItem)) { return false; }
 *     return effect.getAttackType().isHit() || effect.getAttackType() == AttackType.bonus_dmg;
 *
 * The shield is enforced ({@link DamageCtx.targetHasShield}); the cooldown is not, and that is a
 * decision rather than an omission. `BLOCK_CD` is 20 ticks, floored at 5 and divided by
 * `1 + block_recovery / 100`, so how often it is up depends on the rate hits arrive at — the
 * same thing `defence.ts` refuses to invent for regeneration. One hit against a character at
 * full finds block ready, so a single-hit figure is the cooldown's best case and says so.
 *
 * `isInheritedBlock` is also unmodelled and cannot matter here: it re-applies an existing block
 * to the `bonus_dmg` riding on it, and the averaged form has already multiplied that child
 * event's parent by the same factor.
 */
function blockEffect(ctx: DamageCtx, value: number): void {
  if (!canAvoidHit(ctx)) return;
  if (!isHit(ctx)) return;
  // `instanceof ShieldItem` on the offhand stack. Unknown gear is a "no", never a "yes" — the
  // whole point of the gate is that a shieldless build does not block. `defence.ts` raises the
  // diagnostic, once per build rather than once per element swept.
  if (ctx.targetHasShield !== true) return;

  // `getUsableValue(unit, (int) value, lvl)` — the ceiling is `BASE_BLOCK_CAP` plus
  // `max_block_chance`, with no outer clamp to 90 the way a resist has. A build with no
  // `max_block_chance` caps at 75 even though the stat's own `max` is 90, which is the number
  // the old `clamp(value, 0, 100)` was missing.
  const usable = USABLE_STATS["block_chance"];
  const maxStat = usable && usable.kind === "block" ? usable.maxStat : "max_block_chance";
  const min = ctx.index.shapeOf("block_chance").min;
  const cap = BLOCK_BASE_CAP + sheetValue(ctx.target, maxStat);
  const chance = clamp(Math.trunc(value), min, cap) / 100;
  if (chance <= 0) return;

  // `getValueOrBase`, not `getValue`: a sheet that never rolled the stat reads its **base of
  // 100**, not zero. Reading it as zero would make every block stop nothing.
  const shape = ctx.index.shapeOf("block_damage_reduction");
  const reduction = clamp(
    ctx.target.get("block_damage_reduction")?.value ?? shape.base,
    shape.min,
    shape.max,
  );
  if (reduction <= 0) return;

  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.getLayer(LAYER.DAMAGE_BLOCK, EVENT.NUMBER, "Target")?.reduce(reduction * chance);
  recorder?.annotateSince(before, {
    sheet: value,
    penetration: 0,
    afterPenetration: value,
    min,
    cap,
  });
  if (chance >= 1) ctx.event.data.setBoolean(EVENT.IS_BLOCKED, true);
}

/**
 * `BaseDamageIncreaseEffect.activate` — the shared body of every code-only `+% damage` stat.
 *
 * The MORE half is not optional bookkeeping: a `MULTIPLICATIVE_DAMAGE` stat keeps its whole
 * contribution in `m` and leaves the value at zero, so a stat that reached here through
 * `runsOnZero` semantics would otherwise add nothing at all.
 */
function additiveIncrease(ctx: DamageCtx, statId: string, value: number, dmgMulti: number): void {
  ctx.event.getLayer(LAYER.ADDITIVE_DAMAGE, EVENT.NUMBER, "Source")?.add(value);
  if (ctx.index.shapeOf(statId).multiUseType === "MULTIPLICATIVE_DAMAGE") {
    ctx.event.addMoreMulti(statId, EVENT.NUMBER, dmgMulti);
  }
}

/**
 * `NumberModifier.SPELL_DAMAGE_EFFECTIVENESS_MULTI.modify` — the calc's multi, defaulting to 1 —
 * applied to a flat added-damage write, with a note to the trace of what the multiplier was.
 *
 * The three flat-added-damage families all read as a stat the panel then silently inflates:
 * `flat_water_added_damage` sits at 99.84 on the sheet and writes +191.12 into `flat_damage`
 * on a skill whose `dmg_effectiveness` is 1.914, and nothing on screen held the 1.914. It is
 * recorded rather than recomputed by the panel because only this call knows the write happened
 * — off-element flat damage becomes a whole child event instead, with no layer write to annotate.
 */
function addFlatWithEffectiveness(ctx: DamageCtx, element: ElementName, value: number): void {
  const multi = ctx.event.data.getNumber(EVENT.DMG_EFFECTIVENESS, 1);
  const recorder = ctx.event.recorder;
  const before = recorder?.contributions.length ?? 0;
  ctx.event.addBonusEleDmg(element, multi * value, "Source");
  recorder?.scaledSince(before, value, multi);
}

/** `EventData.getBoolean(IS_BONUS_ELEMENT_DAMAGE)` — set on every converted child event. */
function isBonusElementDamage(ctx: DamageCtx): boolean {
  return ctx.event.data.getBoolean(EVENT.IS_BONUS_ELEMENT_DAMAGE);
}

/**
 * `AttackType.isHit()` proper — `this == hit`, and **not** `bonus_dmg`.
 *
 * The looser reading below is a different predicate that happens to share the name in the
 * places it is used; the flat-damage family needs the strict one, because letting `bonus_dmg`
 * through is exactly the double-count `IS_BONUS_ELEMENT_DAMAGE` exists to stop.
 */
function isDirectHit(ctx: DamageCtx): boolean {
  return ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit") === "hit";
}

/** `AttackType.isHit()` — the ordinary hit, or a bonus element riding on one. */
function isHit(ctx: DamageCtx): boolean {
  const attackType = ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit");
  return attackType === "hit" || attackType === "bonus_dmg";
}

/**
 * The shared `canActivate` of `PhysicalToElement` and `BonusPhysicalAsElemental`.
 *
 *     return effect.GetElement() == Elements.Physical
 *             && (effect.getAttackType().isHit() || effect.getAttackType() == AttackType.bonus_dmg)
 *             && effect.conversionDepth < DamageEvent.MAX_CONVERSION_DEPTH;
 */
function physicalSourceHit(ctx: DamageCtx): boolean {
  if (ctx.event.data.getElement() !== "Physical") return false;
  if (ctx.event.conversionDepth >= MAX_CONVERSION_DEPTH) return false;
  const attackType = ctx.event.data.getString(EVENT.ATTACK_TYPE, "hit");
  return attackType === "hit" || attackType === "bonus_dmg";
}

/** Element lookup by GUID, for callers holding a stat id fragment. */
export { elementByGuid };
