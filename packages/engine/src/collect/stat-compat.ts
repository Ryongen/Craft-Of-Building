/**
 * `mmorpg_stat_compat` — vanilla attributes and enchantments turned into Mine and Slash stats.
 *
 * This is the bridge the pack uses to let *other mods* affect the character sheet, and it is
 * not a minor one: Craft to Exile 2 ships 72 entries, and Solonion's food-diversity benefits
 * alone grant `minecraft:generic.max_health`, `kubejs:armor`, `kubejs:magic_shield`,
 * `kubejs:dodge`, `kubejs:weapon_damage` and `kubejs:all_attributes`, every one of which lands
 * here. A character that has eaten a varied diet has measurably more health and magic shield
 * than the same character that has not, and nothing about their gear says so.
 *
 *     public ExactStatData getResult(LivingEntity en, int lvl) {
 *         if (ExileDB.Stats().get(mns_stat_id) instanceof AttributeStat) { return null; }
 *         var at = getAttribute();
 *         if (at == null) { ... return null; }
 *         int val = (int) (en.getAttributeValue(at) * conversion);
 *         int value = MathHelper.clamp(val, minimum_cap, maximum_cap);
 *         if (value != 0) {
 *             value = (int) scaling.scale(value, lvl);
 *             var data = ExactStatData.noScaling(value, mod_type, mns_stat_id);
 *             return data;
 *         }
 *         return null;
 *     }
 *
 * — StatCompat.java:101-126. Four things in that are easy to get wrong:
 *
 *  - **`getAttributeValue` is the total**, base included, not the bonus other mods added. A
 *    player with no food at all still has `minecraft:generic.max_health` at 20.
 *  - **Two truncations, not one.** `(int)` on the conversion, then `(int)` again after
 *    scaling. Both go toward zero.
 *  - **A stat that is itself an `AttributeStat` is skipped**, because that would be a loop:
 *    `attack_speed` and `draw_speed` push MnS values *onto* vanilla attributes, so they must
 *    not read back out of them.
 *  - **Zero contributes nothing at all** — the `value != 0` guard means a clamp to 0 produces
 *    no modifier rather than a zero one, which matters only for provenance, but matters there.
 *
 * The enchantment half (`getEnchantCompatResult`) counts enchantment levels across equipped
 * stacks, which the exporter records per piece under `gear[].enchantments`.
 *
 * It is a **separate context** in the game, not a second helping of this one:
 *
 *     StatContext ctx = new SimpleStatCtx(StatContext.StatCtxType.ENCHANT_COMPAT, list);
 *
 * — GearItemData.java:327,358, against `CommonStatUtils` returning `VANILLA_STAT_COMPAT` for the
 * attribute half. Both are returned here so a breakdown can say "36% of your armour is
 * Protection V on four pieces" rather than filing it under vanilla attributes, where nothing the
 * player can see would explain it. Twenty-seven of this pack's seventy-two entries are
 * enchantments, so the mislabelled share was not a rounding detail.
 */

import type { BuildDoc } from "@cte2/schema";
import { CATEGORY, entry, wornItems } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import type { ExactMod } from "../modifier.js";
import { clamp } from "../container.js";
import { modTypeFromString, type ModType } from "../modifier.js";
import { isStatScaling } from "@cte2/schema";

type CompatEntry = {
  id: string;
  attributeId: string;
  enchantId: string;
  statId: string;
  conversion: number;
  minimumCap: number;
  maximumCap: number;
  perItemMin: number;
  perItemMax: number;
  modType: ModType;
  scaling: string;
};

function readEntries(env: Env): CompatEntry[] {
  const reg = env.snapshot.registries[CATEGORY.statCompat] ?? {};
  const out: CompatEntry[] = [];
  for (const [id, node] of Object.entries(reg)) {
    const d = (node as { data?: Record<string, unknown> }).data;
    if (!d) continue;
    const type = typeof d["mod_type"] === "string" ? d["mod_type"] : "PERCENT";
    out.push({
      id,
      attributeId: typeof d["attribute_id"] === "string" ? d["attribute_id"] : "",
      enchantId: typeof d["enchant_id"] === "string" ? d["enchant_id"] : "",
      statId: typeof d["mns_stat_id"] === "string" ? d["mns_stat_id"] : "",
      // The Java field defaults, for an entry that omits them.
      conversion: typeof d["conversion"] === "number" ? d["conversion"] : 0.5,
      minimumCap: typeof d["minimum_cap"] === "number" ? d["minimum_cap"] : 0,
      maximumCap: typeof d["maximum_cap"] === "number" ? d["maximum_cap"] : 100,
      perItemMin: typeof d["per_item_min"] === "number" ? d["per_item_min"] : 0,
      perItemMax: typeof d["per_item_max"] === "number" ? d["per_item_max"] : 100,
      // `ModType.fromString` lowercases and falls back to FLAT; the registry spells these
      // uppercase throughout, but go through the same reader rather than trusting that.
      modType: modTypeFromString(type),
      scaling: typeof d["scaling"] === "string" ? d["scaling"] : "NONE",
    });
  }
  return out;
}

/**
 * `getEnchantCompatResult` — one entry, summed over every equipped piece.
 *
 *     for (ItemStack stack : stacks) {
 *         int enchlvl = stack.getEnchantmentLevel(ench);
 *         if (enchlvl < 1) { continue; }
 *         int val = (int) (enchlvl * conversion);
 *         value += MathHelper.clamp(val, per_item_min, per_item_max);
 *     }
 *     if (value != 0) {
 *         value = MathHelper.clamp(value, minimum_cap, maximum_cap);
 *         value = (int) scaling.scale(value, lvl);
 *
 * The two clamps are the whole point and are easy to collapse into one: the per-item clamp
 * bounds what a single piece may contribute, the second bounds the total. Protection IV on
 * four pieces and Protection XVI on one are different numbers.
 */
function enchantResult(
  env: Env,
  e: CompatEntry,
  enchanted: readonly Record<string, number>[],
): ExactMod | null {
  let value = 0;
  for (const onItem of enchanted) {
    const level = onItem[e.enchantId];
    // `if (enchlvl < 1) { continue; }` — an absent enchantment reads 0 and is skipped.
    if (level === undefined || !Number.isFinite(level) || level < 1) continue;
    value += clamp(Math.trunc(level * e.conversion), e.perItemMin, e.perItemMax);
  }
  if (value === 0) return null;

  const total = clamp(value, e.minimumCap, e.maximumCap);
  const scaled = Math.trunc(
    isStatScaling(e.scaling) ? total * env.balance.multiFor(e.scaling, env.level) : total,
  );
  if (scaled === 0) return null;
  return {
    statId: e.statId,
    type: e.modType,
    value: scaled,
    from: { kind: "enchantment", id: e.enchantId, via: e.id },
  };
}

/**
 * The vanilla attribute totals Solonion's food diversity would produce at a given count.
 *
 * Every benefit whose `threshold` is at or below the count applies, and they stack — the
 * config lists `max_health +2` at 3 foods and `+4` at 6, and a character at 6 has both. Only
 * ADDITION (`op:0`) is modelled, which is every benefit this pack ships; anything else is
 * left out rather than guessed at, and reported by the caller.
 *
 * The base values are vanilla's own attribute defaults, because `getAttributeValue` returns
 * the total: a player with no food at all still has `generic.max_health` 20.
 */
const VANILLA_ATTRIBUTE_DEFAULTS: Record<string, number> = {
  "minecraft:generic.max_health": 20,
  "minecraft:generic.attack_damage": 1,
  "minecraft:generic.attack_speed": 4,
  "minecraft:generic.armor": 0,
  "minecraft:generic.armor_toughness": 0,
  "minecraft:generic.knockback_resistance": 0,
  "minecraft:generic.luck": 0,
};

export function attributesFromFoodDiversity(
  env: Env,
  count: number,
): { attributes: Record<string, number>; unsupported: number } {
  const config = env.snapshot.externalConfig?.foodDiversity;
  const out: Record<string, number> = {};
  let unsupported = 0;
  if (!config) return { attributes: out, unsupported };

  for (const b of config.benefits) {
    if (b.attributeId === "" || b.threshold > count) continue;
    if (b.operation !== 0) {
      unsupported++;
      continue;
    }
    out[b.attributeId] = (out[b.attributeId] ?? VANILLA_ATTRIBUTE_DEFAULTS[b.attributeId] ?? 0) + b.value;
  }
  return { attributes: out, unsupported };
}

const ATTACK_DAMAGE = "minecraft:generic.attack_damage";

/**
 * A capture whose `attributes` were read while the character was holding something else.
 *
 * `attack_damage_compat` is the one compat entry that decides damage rather than defence:
 * `generic.attack_damage` at 0.5 becomes `total_damage`, and `total_damage` is the only
 * additive-damage stat in the pack with an empty `ifs` — it multiplies **every** element of
 * every hit, the conversion children included. A weapon's own attribute modifier is a
 * Minecraft item property, so `mmorpg_base_gear_types` cannot supply it (`possible_items`
 * names `roe_weapons:sword_3`; the number lives in that item) — the capture is the only
 * place it comes from, exactly as {@link BuildDoc.character.baseAttackSpeed} is for the swing.
 *
 * Which makes the failure silent and cheap to cause: press F6 before equipping the weapon and
 * the document names a sword in `gear` while the attributes describe a bare fist. Nothing in
 * the stat sheet disagrees — `total_damage` reads 0 either way, and 0 is a legal value — so
 * the fixture runner stays at 0 wrong while every damage figure is low by the missing percent.
 * A level-100 sword is worth 4% here.
 *
 * Vanilla's own player base is 1.0 (`VANILLA_ATTRIBUTE_DEFAULTS`), and every weapon in this
 * pack raises it, so "a weapon is equipped and the attribute is still 1" is exact rather than
 * a heuristic.
 */
function reportStaleWeaponAttribute(
  env: Env,
  build: BuildDoc,
  attributes: Record<string, number>,
): void {
  const total = attributes[ATTACK_DAMAGE];
  if (total !== undefined && total > (VANILLA_ATTRIBUTE_DEFAULTS[ATTACK_DAMAGE] ?? 1)) return;

  const weapons = (build.gear ?? [])
    .filter((item) => item.offhand !== true)
    .map((item) => item.base)
    .filter((base) => {
      const type = entry(env.snapshot, CATEGORY.baseGearType, base)?.data["weapon_type"];
      return typeof type === "string" && type !== "" && type !== "none";
    });
  if (weapons.length === 0) return;

  env.report(
    "warning",
    "weapon-attack-damage-unrecorded",
    `character.attributes.${ATTACK_DAMAGE}`,
    `\`${ATTACK_DAMAGE}\` is ${total === undefined ? "absent" : `${total}`}, which is the ` +
      `bare-handed value, but ${weapons.join(", ")} is equipped. \`attack_damage_compat\` ` +
      `turns that attribute into \`total_damage\` at 0.5x, and \`total_damage\` is additive ` +
      `damage with no condition on it, so every element of every hit reads low — the weapon's ` +
      `own attribute modifier is a Minecraft item property no registry carries. Capture again ` +
      `with the weapon in hand, or set the attribute yourself.`,
  );
}

export function collectStatCompat(env: Env, build: BuildDoc): StatContext[] {
  const entries = readEntries(env);
  if (entries.length === 0) return [];

  /*
   * Food diversity, against whatever the capture managed to read.
   *
   * The old rule here was "a capture always wins, because `character.attributes` already
   * includes food diversity". That is true of `minecraft:generic.max_health` and false of every
   * other attribute the benefits grant: in the reference capture `kubejs:weapon_damage`,
   * `kubejs:armor`, `kubejs:magic_shield`, `kubejs:dodge` and `kubejs:all_attributes` all read
   * **0** while `max_health` reads 220 — they are server-derived and the exporter reads them
   * client-side, so they come back empty. Under the old rule the box on screen was disabled and
   * the stats were simply missing, with a warning saying they had been counted already.
   *
   * So the two are merged per attribute rather than one replacing the other, and the capture
   * only wins where it actually recorded something. A captured 220 max health keeps its 220; a
   * captured 0 dodge takes the number the stated diversity implies. Nothing is double-counted,
   * because an attribute cannot be both non-zero and absent.
   */
  let attributes = build.character.attributes;
  const diversity = build.character.foodDiversity;
  if (diversity !== undefined && diversity > 0) {
    const derived = attributesFromFoodDiversity(env, diversity);
    if (attributes === undefined) {
      attributes = derived.attributes;
    } else {
      const filled: string[] = [];
      const merged: Record<string, number> = { ...attributes };
      for (const [id, value] of Object.entries(derived.attributes)) {
        const captured = merged[id];
        if (captured !== undefined && captured !== 0) continue;
        merged[id] = value;
        filled.push(id);
      }
      attributes = merged;
      if (filled.length > 0) {
        env.report(
          "info",
          "food-diversity-filled-gaps",
          "character.foodDiversity",
          `The capture reported no value for ${filled.join(", ")}, so \`foodDiversity: ` +
            `${diversity}\` supplied ${filled.length === 1 ? "it" : "them"}. Every other ` +
            `attribute is the captured one — a food benefit the game did report is not ` +
            `counted twice.`,
        );
      }
    }
    if (derived.unsupported > 0) {
      env.report(
        "warning",
        "food-diversity-operation-unsupported",
        "character.foodDiversity",
        `${derived.unsupported} food-diversity benefit(s) use a multiplying attribute operation, ` +
          `which is not modelled. Only ADDITION benefits are applied.`,
      );
    }
  }
  const mods: ExactMod[] = [];
  const enchantMods: ExactMod[] = [];
  let sawAttributeEntry = false;

  // Enchantment levels, per equipped piece. `getEnchantCompatStats(Player, List<GearData>)`
  // gathers the distinct enchantments across all gear and hands every stack to each matching
  // entry, so the sum is over pieces and each entry fires once.
  const enchanted = wornItems(env.snapshot, build.gear ?? [])
    .map((item) => item.enchantments)
    .filter((e): e is Record<string, number> => e !== undefined);

  for (const e of entries) {
    if (e.statId === "") continue;

    // Either arm: a stat that is itself an `AttributeStat` is skipped, because it pushes
    // outward onto a vanilla attribute and reading it back would be circular. `attack_speed`
    // and `draw_speed` are the two that matter in this pack.
    if (env.index.get(e.statId)?.kind === "vanilla_attribute") continue;

    if (e.attributeId === "") {
      if (e.enchantId === "") continue;
      const mod = enchantResult(env, e, enchanted);
      if (mod) enchantMods.push(mod);
      continue;
    }
    sawAttributeEntry = true;
    if (attributes === undefined) continue;

    const total = attributes[e.attributeId];
    if (total === undefined || !Number.isFinite(total)) continue;

    const val = Math.trunc(total * e.conversion);
    const value = clamp(val, e.minimumCap, e.maximumCap);
    if (value === 0) continue;

    // `scaling.scale(value, lvl)` uses the **compat entry's** own scaling, not the target
    // stat's. Every entry this pack ships is NONE, so this is inert today — but reading the
    // stat's shape here instead would be a different number the moment one is not.
    const scaled = Math.trunc(
      isStatScaling(e.scaling) ? value * env.balance.multiFor(e.scaling, env.level) : value,
    );
    if (scaled === 0) continue;

    // Tagged with the attribute rather than left anonymous: the context is one bag called
    // `stat_compat`, and "which attribute" is the only thing that tells a weapon's
    // `generic.attack_damage` apart from a meal's `kubejs:magic_shield` on the breakdown.
    mods.push({
      statId: e.statId,
      type: e.modType,
      value: scaled,
      from: { kind: "attribute", id: e.attributeId, via: e.id },
    });
  }

  if (attributes !== undefined) reportStaleWeaponAttribute(env, build, attributes);

  if (sawAttributeEntry && attributes === undefined) {
    env.report(
      "warning",
      "vanilla-attributes-unknown",
      "character.attributes",
      `${entries.length} \`${CATEGORY.statCompat}\` entries turn vanilla attributes into stats ` +
        `and no \`character.attributes\` was recorded, so none of them apply. In this pack that ` +
        `is Solonion's food-diversity benefits, Mine and Meals and the KubeJS attributes — ` +
        `health, magic shield, dodge and armour all read low without them.`,
    );
  }
  const out: StatContext[] = [];
  if (mods.length > 0) {
    out.push(context("VANILLA_STAT_COMPAT", "stat_compat", "character.attributes", mods));
  }
  if (enchantMods.length > 0) {
    // Pathed at the gear, because that is where the player changes it: the fix for an enchant
    // stat reading wrong is a different book, not a different attribute.
    out.push(context("ENCHANT_COMPAT", "enchant_compat", "gear", enchantMods));
  }
  return out;
}
