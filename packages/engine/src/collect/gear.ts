/**
 * Gear, and the jewels that share its affix machinery.
 *
 * An item in a build document is a recipe, not a result — a base, a rarity, a level and a set
 * of `{ affixId, tier, rollPercent }`. This is where that recipe becomes numbers, in the same
 * order the game assembles them:
 *
 *     IfNotNullAdd(baseStats, list);
 *     IfNotNullAdd(imp, list);
 *     affixes.getAllAffixesAndSockets().forEach(x -> IfNotNullAdd(x, list));
 *     IfNotNullAdd(sockets, list);
 *     IfNotNullAdd(uniqueStats, list);
 *     IfNotNullAdd(ench, list);
 *
 * — `GearItemData.GetAllStatContainers`, GearItemData.java:267-285.
 *
 * Everything on an item scales at the **item's** level, never the character's
 * (`SocketData.GetAllStats` passes `gear.getLevel()`, affixes pass `gear.lvl`).
 */

import type { Item, Jewel } from "@cte2/schema";
import {
  CATEGORY,
  affix,
  baseGearType,
  entry,
  gearRarity,
  offhandWeaponCounts,
  offhandWeaponShare,
  slotFamily,
  wornPieces,
} from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import {
  parseRolledMods,
  parseSourceMods,
  rollToExact,
  sourceToExact,
  type ExactMod,
  type ModOrigin,
  type RolledMod,
} from "../modifier.js";

/**
 * The part of an affix roll that produces numbers.
 *
 * `tier` is deliberately absent: it decides which band the roll was *drawn* from, which is the
 * validator's business, and `ToExactStat(p, lvl)` takes only the percent. Leaving it out also
 * lets implicits through, which have no tier at all (`ImplicitStatsData` saves `p` and `imp`
 * and nothing else).
 */
// `tier` is optional because an implicit genuinely has none — `ImplicitStatsData` stores
// only `p` and `imp` where `AffixData` also stores `rar`.
type AffixRollLike = { affixId: string; rollPercent: number; tier?: string };

/**
 * Every worn item's stats.
 *
 * `dualWieldEffectiveness` is the character's Dual-Wield Effectiveness, which only an offhand
 * weapon reads. The game takes it from the *previous* stat calculation and redoes the gear pass
 * when the next one disagrees (`CachedEntityStats.afterStatCalc`); `settle` in `calculate.ts`
 * runs the same loop.
 */
export function collectGear(
  env: Env,
  gear: readonly Item[],
  dualWieldEffectiveness = 0,
): StatContext[] {
  // The pieces worn, so a `mirrored` ring counts twice and a mirrored sword's offhand half takes
  // the offhand share. The second place keeps the entry's path, so a diagnostic still lands on it.
  const pieces = wornPieces(env.snapshot, gear);
  const items = pieces.map((piece) => piece.item);
  return pieces.flatMap(({ item, index, mirror }) => {
    const path = mirror ? `gear[${index}].mirrored` : `gear[${index}]`;
    // The second place is the same item, so whatever it has to say was said by the first.
    const env_ = mirror ? { ...env, report: () => {} } : env;
    if (item.offhand !== true || !isWeaponBase(env_, item.base)) return collectItem(env_, item, path);

    // `GearData.isUsableBy`: a weapon in `OFFHAND` is refused outright unless it can be dual
    // wielded and the mainhand does not block it. The validator names which.
    if (!offhandWeaponCounts(env.snapshot, item, items)) return [];

    // `GearData.calcStatUtilization` → `percentStatUtilization`, then
    // `stats.forEach(s -> s.multiplyBy(multi))` over everything the item carries.
    const share = offhandWeaponShare(env.snapshot, dualWieldEffectiveness);
    return collectItem(env_, item, path).map((ctx) => ({
      ...ctx,
      stats: ctx.stats.map((mod) => ({ ...mod, value: mod.value * share })),
    }));
  });
}

function isWeaponBase(env: Env, baseId: string): boolean {
  const slotId = baseGearType(env.snapshot, baseId)?.gearSlot;
  return slotId !== undefined && slotFamily(env.snapshot, slotId) === "Weapon";
}

function collectItem(env: Env, item: Item, path: string): StatContext[] {
  const base = baseGearType(env.snapshot, item.base);
  if (!base) {
    env.report("error", "unknown-base", path, `No base gear type \`${item.base}\`.`);
    return [];
  }

  // `GearData.isUsableBy`: `if (gear.lvl > data.getLevel()) { return false; }`
  // (GearData.java:113-119). An item above the character's level is worn but contributes
  // nothing at all — not a reduced amount, nothing.
  if (item.itemLevel > env.level) {
    env.report(
      "warning",
      "item-above-character-level",
      path,
      `Item level ${item.itemLevel} exceeds character level ${env.level}, so the game grants none of its stats.`,
    );
    return [];
  }

  const level = item.itemLevel;

  // Everything except the base stats is gathered first, because `BaseStatsData.GetAllStats`
  // feeds those back into the base stats before anything leaves the item — see
  // `applyBaseStatModifiers`.
  const rest: ExactMod[] = [];

  for (const [section, kind, rolls] of [
    ["implicits", "implicit", item.implicits],
    ["prefixes", "prefix", item.prefixes],
    ["suffixes", "suffix", item.suffixes],
    ["corruptions", "corruption", item.corruptions],
    ["enchant", "enchant", item.enchant ? [item.enchant] : undefined],
  ] as const) {
    (rolls ?? []).forEach((roll, i) => {
      rest.push(...affixStats(env, roll, level, `${path}.${section}[${i}]`, kind));
    });
  }

  if (item.unique !== undefined) {
    rest.push(...uniqueStats(env, item, level, path));
  }

  rest.push(...socketStats(env, item, base.gearSlot, level, path));

  // Base stats, rolled within the *rarity's* `base_stat_percents` band rather than the affix
  // band (`BaseStatsData.getMinMax` returns `gear.getRarity().base_stat_percents`). A document
  // that omits the rolls cannot be made up, so the band's **minimum** is used: that is the
  // floor the game can actually produce for this rarity. Using 0 instead — as this did — is
  // not a conservative estimate but an impossible item, since a unique never rolls below 75.
  const baseMods = parseRolledMods(base.baseStats);
  const baseStats: ExactMod[] = [];
  if (baseMods.length > 0) {
    const band = rarityOf(env, item.rarity)?.baseStatPercents;
    const floor = band?.min ?? 0;
    const rolls = item.baseRolls;
    if (rolls === undefined) {
      env.report(
        "warning",
        "missing-base-rolls",
        path,
        `No \`baseRolls\` recorded, so the ${baseMods.length} base stat(s) are computed at ${floor}% — the lowest \`${item.rarity}\` can roll, not the item's real value.`,
      );
    } else if (rolls.length !== baseMods.length) {
      env.report(
        "error",
        "base-roll-count-mismatch",
        path,
        `\`${item.base}\` has ${baseMods.length} base stat(s) but ${rolls.length} roll(s) were given.`,
      );
    }
    // `BaseStatsData.GetAllStats` adds quality to the roll before resolving the band:
    //     int p = (int) (this.p + gear.getQualityBaseStatsBonus(stack));
    // so an item with quality rolls above what its stored percent alone would give. The two are
    // recorded separately, which is the only way a document can describe a 100% roll on a
    // quality item without claiming the roll itself was 100.
    const quality = item.quality ?? 0;
    if (quality !== 0 && !Number.isFinite(quality)) {
      env.report("error", "bad-quality", `${path}.quality`, `Quality must be a finite number.`);
    }
    const bonus = Number.isFinite(quality) ? quality : 0;

    baseMods.forEach((mod, i) => {
      const roll = (rolls?.[i] ?? floor) + bonus;
      baseStats.push(exact(env, mod, roll, level, { kind: "base", rollPercent: roll }));
    });
    applyBaseStatModifiers(baseStats, rest);
  }

  return [context("GEAR", item.base, path, [...baseStats, ...rest])];
}

/**
 * Jewels carry affixes in their own tag space but resolve them exactly like gear does.
 * `Jewel` has no base, so there are no base stats and no sockets.
 *
 * `JewelItemData.getStatAndContext` (JewelItemData.java:235-259) walks **two** affix lists into
 * the one JEWEL context:
 *
 *     for (AffixData affix : this.affixes) { list.addAll(affix.GetAllStats(lvl)); }
 *     for (AffixData affix : this.cor)     { list.addAll(affix.GetAllStats(lvl)); }
 *
 * `cor` is the corruption list, and it is not a rounding-error case: a corrupted jewel is where
 * `slow_immunity`, `max_fire_resist` and a third of a build's `spirit_cost` live, and dropping
 * it made those stats read as if the jewel were not socketed at all.
 *
 * Then the Watcher's Eye stats, which are conditional and therefore come *before* it in the
 * list the game returns, each in a JEWEL context of their own.
 */
export function collectJewels(
  env: Env,
  jewels: readonly Jewel[],
  aurasOn: ReadonlySet<string>,
  sockets: number = Number.POSITIVE_INFINITY,
): StatContext[] {
  return jewels.flatMap((jewel, i) => {
    const path = `jewels[${i}]`;
    const out: StatContext[] = [];

    // A jewel past the last socket is not a weaker jewel, it is a jewel on the floor.
    // `JewelInvHelper.checkRemoveJewels` walks the inventory counting as it goes and calls
    // `unequip` on everything past `jewel_socket`, so the surplus contributes nothing — which
    // is what this used to get wrong: every jewel in the document was summed whether or not
    // the tree had a socket for it, and a build with no sockets at all still wore them.
    if (i >= sockets) {
      env.report(
        "warning",
        "jewel-without-socket",
        path,
        `This build has ${sockets} jewel socket(s) and this is jewel ${i + 1}, so the game ` +
          `unequips it (\`JewelInvHelper.checkRemoveJewels\`) and none of its stats are counted. ` +
          `Allocate a \`jewel_socket\` talent — or wear a unique that grants one — to use it.`,
      );
      return out;
    }

    for (const conditional of auraStatContexts(env, jewel, aurasOn, path)) out.push(conditional);

    const stats = [
      ...(jewel.affixes ?? []).flatMap((roll, j) =>
        affixStats(env, roll, jewel.itemLevel, `${path}.affixes[${j}]`, "prefix"),
      ),
      ...(jewel.corruptions ?? []).flatMap((roll, j) =>
        affixStats(env, roll, jewel.itemLevel, `${path}.corruptions[${j}]`, "corruption"),
      ),
    ];
    out.push(context("JEWEL", jewel.rarity, path, stats));
    return out;
  });
}

/**
 * `StatsWhileUnderAuraData` — a Watcher's Eye line, live only while its aura is socketed:
 *
 *     for (StatsWhileUnderAuraData aura : auraStats) {
 *         if (data.aurasOn.contains(aura.getAura().id)) { ctx.addAll(aura.getStatAndContext(en)); }
 *     }
 *
 * Which aura gates a line is a property of the *affix* (`Affix.eye_aura_req`), not of the
 * record, and the roll scales to the **jewel's** level rather than the character's — the record
 * carries its own `lvl` for exactly that reason. The result is a JEWEL context like any other,
 * so `jewel_effect` reaches it.
 */
function auraStatContexts(
  env: Env,
  jewel: Jewel,
  aurasOn: ReadonlySet<string>,
  path: string,
): StatContext[] {
  const out: StatContext[] = [];
  (jewel.auraStats ?? []).forEach((line, j) => {
    const at = `${path}.auraStats[${j}]`;
    const view = affix(env.snapshot, line.affixId);
    if (!view) {
      env.report("error", "unknown-affix", at, `No ${CATEGORY.affix} entry \`${line.affixId}\`.`);
      return;
    }
    // `getAura()` resolves `eye_aura_req` against the aura registry; a line whose aura is not
    // running contributes nothing, which is the whole point of the record.
    const required = view.eyeAuraReq ?? "";
    if (required.length === 0) {
      env.report(
        "warning",
        "aura-stat-without-aura-requirement",
        at,
        `\`${line.affixId}\` carries no \`eye_aura_req\`, so nothing says which aura gates it. Skipped.`,
      );
      return;
    }
    if (!aurasOn.has(required)) return;
    out.push(
      context("JEWEL", line.affixId, at, affixStats(env, line, line.itemLevel, at)),
    );
  });
  return out;
}

/**
 * Which base stats each `IBaseStatModifier` stat rewrites.
 *
 * Only two stats implement that interface. `gear_defense` covers all three defensive base
 * stats (`GearDefense.canModifyBaseStat`, GearDefense.java:50-53) and `gear_weapon_damage`
 * covers weapon damage (GearDamage.java:50-52). They are *local*: they change the numbers on
 * the item carrying them and are inert as unit stats, which is why a helmet's +14%
 * `gear_defense` must show up as bigger armor rather than as a line of its own.
 */
const BASE_STAT_MODIFIERS: Record<string, readonly string[]> = {
  gear_defense: ["armor", "dodge", "magic_shield"],
  gear_weapon_damage: ["weapon_damage"],
};

/**
 * Folds an item's own `gear_defense` / `gear_weapon_damage` into its base stats.
 *
 * `BaseStatsData.GetAllStats` collects every stat container on the item **except** the base
 * one, keeps the `IBaseStatModifier` entries, and runs two passes in this order
 * (BaseStatsData.java:120-155):
 *
 *     FLAT    -> baseStat.add(...)                  // added to the rolled base value
 *     PERCENT -> baseStat.percentIncrease = value;  // note: assignment, not +=
 *                baseStat.increaseByAddedPercent()
 *
 * Both details matter. FLAT before PERCENT means a flat bonus is itself multiplied. And the
 * PERCENT pass *assigns* rather than accumulates, applying each source immediately — so two
 * +20% sources compound to 1.2 x 1.2 = +44%, not +40%. Replicating that multiplicatively is
 * not a liberty; adding them would under-count every multi-source item.
 *
 * `MORE` modifiers are ignored here exactly as the game ignores them: neither pass tests for
 * that type, so a `MORE` gear_defense would silently do nothing to base stats.
 */
function applyBaseStatModifiers(baseStats: ExactMod[], others: readonly ExactMod[]): void {
  const modifiers = others.filter((mod) => mod.statId in BASE_STAT_MODIFIERS);
  if (modifiers.length === 0) return;

  for (const mod of modifiers) {
    if (mod.type !== "FLAT") continue;
    for (const base of baseStats) {
      if (BASE_STAT_MODIFIERS[mod.statId]!.includes(base.statId)) base.value += mod.value;
    }
  }

  for (const mod of modifiers) {
    if (mod.type !== "PERCENT") continue;
    for (const base of baseStats) {
      if (BASE_STAT_MODIFIERS[mod.statId]!.includes(base.statId)) {
        base.value *= 1 + mod.value / 100;
      }
    }
  }
}

function affixStats(
  env: Env,
  roll: AffixRollLike,
  level: number,
  path: string,
  kind: ModOrigin["kind"] = "prefix",
): ExactMod[] {
  const view = affix(env.snapshot, roll.affixId);
  if (!view) {
    env.report("error", "unknown-affix", path, `No affix \`${roll.affixId}\`.`);
    return [];
  }
  const from: ModOrigin = {
    kind,
    id: roll.affixId,
    rollPercent: roll.rollPercent,
    ...(roll.tier === undefined ? {} : { tier: roll.tier }),
  };
  return parseRolledMods(view.stats).map((mod) => exact(env, mod, roll.rollPercent, level, from));
}

function uniqueStats(env: Env, item: Item, level: number, path: string): ExactMod[] {
  const view = item.unique === undefined ? undefined : uniqueOf(env, item.unique);
  if (!view) {
    env.report("error", "unknown-unique", path, `No unique \`${item.unique}\`.`);
    return [];
  }
  const mods = parseRolledMods(view.uniqueStats);
  const rolls = item.uniqueRolls;
  if (rolls === undefined && mods.length > 0) {
    env.report(
      "warning",
      "missing-unique-rolls",
      path,
      `No \`uniqueRolls\` recorded, so \`${item.unique}\`'s ${mods.length} stat(s) are computed at 0%.`,
    );
  }
  return mods.map((mod, i) =>
    exact(env, mod, rolls?.[i] ?? 0, level, {
      kind: "unique",
      ...(item.unique === undefined ? {} : { id: item.unique }),
      rollPercent: rolls?.[i] ?? 0,
    }),
  );
}

function uniqueOf(env: Env, id: string) {
  const data = entry(env.snapshot, CATEGORY.unique, id)?.data;
  if (!data) return undefined;
  const stats = data["unique_stats"];
  return {
    uniqueStats: Array.isArray(stats)
      ? stats.filter(
          (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
        )
      : [],
  };
}

/**
 * Gems, runes and the runeword.
 *
 * Which of the three stat lists applies is the slot's family, defaulting to armor:
 *
 *     if (sfor == SlotFamily.Armor) { return on_armor_stats; }
 *     if (sfor == SlotFamily.Jewelry) { return on_jewelry_stats; }
 *     if (sfor == SlotFamily.Weapon) { return on_weapons_stats; }
 *     return on_armor_stats;
 *
 * — BaseGem.java:33-46, and Rune.java:76-89 identically. So an offhand takes the armor list.
 *
 * Gems are exact values, so they are fully determined. Runes and runewords are ranges rolled
 * when they are socketed (`SocketData.p`, `GearSocketsData.rp`) and the build document has no
 * field for either roll — it records only the ids. They are computed at 0% with a warning.
 */
function socketStats(
  env: Env,
  item: Item,
  gearSlot: string | undefined,
  level: number,
  path: string,
): ExactMod[] {
  const family = gearSlot === undefined ? undefined : slotFamily(env.snapshot, gearSlot);
  const listKey =
    family === "Jewelry" ? "on_jewelry_stats" : family === "Weapon" ? "on_weapons_stats" : "on_armor_stats";

  const stats: ExactMod[] = [];

  (item.sockets ?? []).forEach((gemId, i) => {
    const data = entry(env.snapshot, CATEGORY.gem, gemId)?.data;
    if (!data) {
      env.report("error", "unknown-gem", `${path}.sockets[${i}]`, `No gem \`${gemId}\`.`);
      return;
    }
    const raw = data[listKey];
    for (const mod of Array.isArray(raw) ? parseSourceMods(raw) : []) {
      stats.push(sourceToExact(mod, level, env.index.shapeOf(mod.statId), env.balance));
    }
  });

  (item.runes ?? []).forEach((runeId, i) => {
    const data = entry(env.snapshot, CATEGORY.rune, runeId)?.data;
    if (!data) {
      env.report("error", "unknown-rune", `${path}.runes[${i}]`, `No rune \`${runeId}\`.`);
      return;
    }
    const raw = data[listKey];
    const mods = Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];
    // `SocketData.p`, recorded per rune in the same order as `runes`.
    const roll = item.runeRolls?.[i];
    if (mods.length > 0 && roll === undefined) {
      env.report(
        "warning",
        "rune-roll-unknown",
        `${path}.runes[${i}]`,
        `\`${runeId}\` rolls its stats when socketed (\`SocketData.p\`) and no \`runeRolls[${i}]\` was recorded, so it is computed at 0% — its stats read at their minimum.`,
      );
    }
    const from: ModOrigin = { kind: "rune", id: runeId, rollPercent: roll ?? 0 };
    for (const mod of mods) stats.push(exact(env, mod, roll ?? 0, level, from));
  });

  if (item.runeword !== undefined) {
    const data = entry(env.snapshot, CATEGORY.runeword, item.runeword)?.data;
    if (!data) {
      env.report("error", "unknown-runeword", path, `No runeword \`${item.runeword}\`.`);
    } else {
      const raw = data["stats"];
      const mods = Array.isArray(raw) ? parseRolledMods(raw as Record<string, unknown>[]) : [];
      // `GearSocketsData.rp`, rolled once when the runeword completed. The document carries it
      // as `runewordRoll`; using it is the difference between a runeword at its floor and the
      // one actually being worn.
      const roll = item.runewordRoll;
      if (mods.length > 0 && roll === undefined) {
        env.report(
          "warning",
          "runeword-roll-unknown",
          path,
          `\`${item.runeword}\` rolls its stats when completed (\`GearSocketsData.rp\`) and no \`runewordRoll\` was recorded, so it is computed at 0% — its stats read at their minimum.`,
        );
      }
      const from: ModOrigin = { kind: "runeword", id: item.runeword, rollPercent: roll ?? 0 };
      for (const mod of mods) stats.push(exact(env, mod, roll ?? 0, level, from));
    }
  }

  return stats;
}

function exact(
  env: Env,
  mod: RolledMod,
  rollPercent: number,
  level: number,
  from?: ModOrigin,
): ExactMod {
  const resolved = rollToExact(mod, rollPercent, level, env.index.shapeOf(mod.statId), env.balance);
  return from === undefined ? resolved : { ...resolved, from };
}

/** Re-exported so `calculate` can report a rarity it could not resolve without importing schema. */
export function rarityOf(env: Env, id: string) {
  return gearRarity(env.snapshot, id);
}
