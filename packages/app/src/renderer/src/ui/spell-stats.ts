/**
 * What a skill or a gem's tooltip says, as data.
 *
 * The counterpart of `item-stats.ts`, and deliberately its twin: that module turns an item into
 * ordered sections of worded lines and `ItemWindow` draws them, so a skill gets the same
 * treatment rather than a second idea of what a tooltip is. The two cards share their chrome
 * (`.item-window`, `.tt-*`) for the same reason the two drill-downs share `StepRow`.
 *
 * ## Why this exists at all
 *
 * A skill and a support gem were the only things in the planner whose hover was a **browser
 * `title` attribute** — a grey box, half a second late, one flat string, no numbers. In game
 * both are among the most information-dense tooltips there are: the description with its damage
 * figure filled in, the rank, the cost at your level, cast and cooldown, the tags, and the
 * gem's own stats at the rank you hold it. None of that was reachable without opening the
 * Skills tab and reading four separate cards.
 *
 * ## The line order is the game's
 *
 * `SpellTooltipUtils` / `ValueCalculation.getShortTooltip`, in that order: name, description,
 * level, costs, timing, tags, stats. A player who knows the game's tooltip can read this one
 * without learning anything.
 *
 * ## What is deliberately left out
 *
 * The in-game wiki this borrows from (`cte2-library`) also prints weights, roll windows, "can
 * roll on" lists and every id. Those answer *browsing* questions — which of five hundred
 * entries is this — and nothing here is being browsed: the thing under the pointer is already
 * chosen. Ids stay on a `title`, where they are there when a number looks wrong and invisible
 * when it does not.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  ORIGINAL_MODE,
  balance,
  baseValue,
  leveledValue,
  levelScalingMulti,
  valueCalc,
  type LeveledValue,
} from "@cte2/engine";
import {
  CATEGORY,
  LANG_KEY,
  auraName,
  entry,
  exileEffectName,
  humanise,
  isSpellPerk,
  mobAffixName,
  parseFormatting,
  perk,
  perkName,
  spellName,
  statName,
  stripGlossaryMarkup,
  supportGemName,
  type Span,
} from "@cte2/schema";

import { totalLines, type StatLine, type StatTotal } from "./item-stats.js";
import { resolveValue } from "./StatLines.js";
import { modsOf } from "./mods.js";
import { num, smart } from "./format.js";

/** 20 ticks to the second, everywhere in this mod. */
const TICKS = 20;

/** One `label: value` row of the card's footer block. */
export type CardFact = {
  label: string;
  value: string;
  /** The source behind it, for a hover — a config key, a jar method. */
  title?: string;
};

/** A cost line, which the game colours by which pool pays it. */
export type CardCost = { label: string; value: number; colour: string };

/**
 * A skill's tooltip.
 *
 * `description` is already resolved and split: one entry per paragraph, each a list of styled
 * runs, because the pack writes these as Minecraft-formatted strings and half the information
 * in them is the colour.
 */
export type SpellCard = {
  id: string;
  name: string;
  /** "Skill", or "Channelled Skill" — what the line under the name says. */
  kind: string;
  description: Span[][];
  level: { shown: number; natural: number; ceiling: number };
  costs: CardCost[];
  facts: CardFact[];
  tags: string[];
  /** `statsForSkillGem`, resolved at this rank. */
  stats: StatLine[];
  /** A sentence the planner adds, below a rule. See {@link GemCard.note}. */
  note?: string;
};

/**
 * The small card: a name, a list of stat lines, a short footer.
 *
 * A support gem, an Augment, an exile effect and a class perk are all this shape, and they are
 * one type rather than four because the differences between them are two strings — the `kind`
 * the subtitle prints, and the icon. Everything else a reader wants off any of them is "what
 * does this grant me", worded by the same `totalLines` the item card uses.
 */
export type GemCard = {
  id: string;
  name: string;
  kind: string;
  stats: StatLine[];
  facts: CardFact[];
  /**
   * The pack texture to draw in the header — the one the game draws for this thing.
   *
   * Everything on this card has one. A perk names its own in the registry. An exile effect's is
   * `textures/item/mob_effects/<id>.png`, which is what `ExileEffect.getTexture()` returns. A
   * support gem's and an Augment's is `textures/item/skill_gems/{support,aura}/<style>.png`,
   * which is keyed on `PlayStyle` and not on the gem — the game really does draw every Fortify
   * gem as the same green gem, so that is the honest icon rather than a shortfall.
   *
   * Unset falls back to the kind's generic plate. See `SpellTooltip`'s `GEM_LOOK`.
   */
  icon?: string;
  /**
   * A sentence the *planner* has to add, not the game: what linking this gem would be worth.
   *
   * Set by the ranked picker, where it is the whole reason the row is where it is in the list.
   * It sits at the foot of the card, below a rule, so it reads as this app's own remark rather
   * than as something the gem says about itself.
   */
  note?: string;
};

/**
 * Everything a skill's card needs.
 *
 * `level` and `ceiling` are handed in rather than derived. The panel already knows them — a rank
 * is the class allocation, plus `plus_lvl_<tag>_spells` off gear, clamped, or a number pinned
 * into the document — and re-deriving them here would be a second answer to a question the
 * Skills tab has already answered carefully. See `SkillsPanel`'s `resolvedRank`.
 */
export function spellCard(
  snapshot: Snapshot,
  spellId: string,
  at: { level: number; natural: number; ceiling: number; characterLevel: number },
): SpellCard | undefined {
  const data = entry(snapshot, CATEGORY.spell, spellId)?.data;
  if (!data) return undefined;

  const config = asObject(data["config"]) ?? {};
  const bal = balance(snapshot);
  const channel = config["channel_skill"] === true;

  /*
    The cost multiplier at the *character's* level, not the skill's.

    `SpellStatsCalculationEvent` reads `MANA_COST_SCALING` against the caster and then the band
    against the gem's rank, so a rank-1 spell on a level-100 character is expensive. Printing the
    raw band — which is what the Skills tab's `Fact` row does, correctly, because that row is
    labelled as the pack's declared number — would say 6 where the cast pays 258.
  */
  const costMulti = levelScalingMulti(bal.manaCostScaling, at.characterLevel, bal.maxLevel);
  const rank = (band: unknown): number =>
    Math.trunc(costMulti * leveledValue(leveledOf(band), at.level, at.ceiling));

  const costs: CardCost[] = [];
  const mana = rank(config["mana_cost"]);
  const energy = rank(config["ene_cost"]);
  if (mana > 0) costs.push({ label: "Mana Cost", value: mana, colour: "#5555ff" });
  if (energy > 0) costs.push({ label: "Energy Cost", value: energy, colour: "#55ff55" });
  // One pool pays both on a Blood Mage, and the sum is a figure neither line above gives. Only
  // worth saying when there are two of them — on a single-cost skill it would repeat the number.
  if (mana > 0 && energy > 0) {
    costs.push({ label: "Blood Cost", value: mana + energy, colour: "#aa0000" });
  }

  const facts: CardFact[] = [];
  const charges = numberAt(config, "charges");
  if (charges > 0) {
    facts.push({ label: "Max Charges", value: String(charges), title: "config.charges" });
    const regen = numberAt(config, "charge_regen");
    if (regen > 0) facts.push({ label: "Charge Regen", value: seconds(regen) });
  } else {
    const cooldown = numberAt(config, "cooldown_ticks");
    if (cooldown > 0) facts.push({ label: "Cooldown", value: seconds(cooldown) });
  }
  const castTime = numberAt(config, "cast_time_ticks");
  facts.push({
    label: channel ? "Channel Pulse" : "Cast Time",
    value: castTime <= 1 && !channel ? "Instant" : seconds(castTime),
    title: "config.cast_time_ticks",
  });
  const recovery = numberAt(config, "cast_speed_ticks");
  if (recovery > 0) {
    facts.push({
      label: "Recovery",
      value: seconds(recovery),
      title: "config.cast_speed_ticks: the animation you are locked into after the cast",
    });
  }
  const weapon = stringAt(config, "castingWeapon");
  if (weapon !== undefined) facts.push({ label: "Weapon", value: titleCase(weapon) });
  const minLevel = numberAt(data, "min_lvl");
  if (minLevel > 1) {
    facts.push({
      label: "Requires Level",
      value: String(minLevel),
      title: "Spell.getRequiredLevel",
    });
  }

  return {
    id: spellId,
    name: spellName(snapshot, spellId),
    kind: channel ? "Channelled Skill" : "Skill",
    description: describe(snapshot, spellId, at, bal),
    level: { shown: at.level, natural: at.natural, ceiling: at.ceiling },
    costs,
    facts,
    tags: tagsOf(config),
    // `Spell.getStats`: the percent is the rank's share of the ceiling, **truncated to an int**,
    // and the flats scale to the player's level rather than the spell's.
    stats: linesFrom(
      snapshot,
      data["statsForSkillGem"],
      Math.trunc((at.level / Math.max(at.ceiling, 1)) * 100),
      at.characterLevel,
    ),
  };
}

/** A support gem at the rarity and roll it is socketed at. */
export function supportGemCard(
  snapshot: Snapshot,
  gemId: string,
  at: { rollPercent: number; characterLevel: number },
): GemCard | undefined {
  const data = entry(snapshot, CATEGORY.supportGem, gemId)?.data;
  if (!data) return undefined;

  const facts: CardFact[] = [];
  const multi = numberAt(data, "manaMulti");
  if (multi !== 0 && multi !== 1) {
    facts.push({
      label: "Cost Multiplier",
      value: `${multi.toFixed(2)}×`,
      title: "SocketedGem.getManaCostMulti: every linked gem's multiplied together",
    });
  }
  pushShared(facts, data);

  const icon = gemTexture("support", stringAt(data, "style"));
  return {
    id: gemId,
    name: supportGemName(snapshot, gemId),
    kind: "Support Gem",
    stats: linesFrom(snapshot, data["stats"], at.rollPercent, at.characterLevel),
    facts,
    ...(icon === undefined ? {} : { icon }),
  };
}

/** An Augment — the player's word for what the data calls an aura. */
export function auraCard(
  snapshot: Snapshot,
  auraId: string,
  at: { rollPercent: number; characterLevel: number },
): GemCard | undefined {
  const data = entry(snapshot, CATEGORY.aura, auraId)?.data;
  if (!data) return undefined;

  const facts: CardFact[] = [];
  const reservation = numberAt(data, "reservation");
  if (reservation > 0) {
    facts.push({
      label: "Reservation",
      value: `${Math.round(reservation * 100)}%`,
      title: "What fraction of the pool this Augment holds while it is up",
    });
  }
  pushShared(facts, data);

  const icon = gemTexture("aura", stringAt(data, "style"));
  return {
    id: auraId,
    name: auraName(snapshot, auraId),
    kind: "Augment",
    stats: linesFrom(snapshot, data["stats"], at.rollPercent, at.characterLevel),
    facts,
    ...(icon === undefined ? {} : { icon }),
  };
}

/**
 * An exile effect — a buff on you or a debuff on the mob — at the roll and stacks it is up at.
 *
 * These carry most of a finished build's MORE multipliers and were the largest group of rows on
 * the damage trace with nothing behind them: Frenzy Charge's ×1.09, Eighth Gate's ×1.20,
 * Ice-Tipped Blade's ×1.10 each named something the reader had no way to look at. The effect is
 * not a thing in the document — what applies it is — so this resolves against the registry, and
 * takes the roll and the stack count from the `EffectState` the engine settled.
 *
 * Both numbers matter and neither is decoration. `rollPercent` interpolates the `{min, max}`
 * bands off the rank of whatever applied the effect, so Fighter Stance's attack speed is
 * anywhere from 15 to 30; `stacks` multiplies the whole list where `stacks_affect_stats` is set,
 * which is what makes three Frenzy Charges ×1.09 rather than ×1.03.
 *
 * `strMulti` is deliberately **not** applied. It is the character's `inc_effect_of_*_buff_*`
 * stats, which are a property of the reader rather than of the effect, and the toggle on the
 * Effects card is where that number is already explained.
 */
export function effectCard(
  snapshot: Snapshot,
  effectId: string,
  at: { rollPercent: number; stacks: number; characterLevel: number },
): GemCard | undefined {
  const data = entry(snapshot, CATEGORY.exileEffect, effectId)?.data;
  if (!data) return undefined;

  const negative = stringAt(data, "type") === "negative";
  const declaredMax = numberAt(data, "max_stacks");
  // `ExileEffect.getExactStats`: N stacks multiply every band by N, but only where the effect
  // says so. Half the pack's stacking effects do not, and showing their stats multiplied would
  // be a number the game never grants.
  const stacksAffect = data["stacks_affect_stats"] === true;
  const stacks = Math.max(1, Math.trunc(at.stacks));
  const multi = stacksAffect ? stacks : 1;

  const facts: CardFact[] = [];
  if (declaredMax > 1) {
    facts.push({
      label: "Stacks",
      value: `${stacks} / ${declaredMax}`,
      title: stacksAffect
        ? "max_stacks. `stacks_affect_stats` is set, so the stats above are this many times " +
          "their band. That is what `increaseByAddedPercent` does."
        : "max_stacks. This effect does not set `stacks_affect_stats`, so stacking it changes " +
          "nothing about the stats above.",
    });
  }
  facts.push({
    label: "Rolled At",
    value: `${Math.round(at.rollPercent)}%`,
    title:
      "`new LeveledValue(0, 100).getValue(caster, spell)`: the rank of whatever applies this " +
      "effect decides where in each band its stats sit.",
  });

  return {
    id: effectId,
    name: exileEffectName(snapshot, effectId),
    kind: negative ? "Debuff" : "Buff",
    stats: linesFrom(snapshot, data["stats"], at.rollPercent, at.characterLevel, multi),
    facts,
    icon: effectTexture(effectId),
  };
}

/**
 * A class perk — a spell rank or a passive on the Classes grid — at the level it is taken to.
 *
 * The Classes tab was the last screen in the planner still explaining itself through a browser
 * `title`: a grey box, half a second late, with the name, a fraction and the stats concatenated
 * into one string. Everything else a build is made of has had a real card for a long time, and
 * a passive perk is not a lesser thing than a support gem.
 *
 * **A perk at level N grants N times its listed stats**, which is why the level multiplies the
 * lines rather than interpolating them: these are `{type, stat, v1, scale_to_lvl}` modifiers with
 * no band to sit in, so there is nothing for a roll to move. `resolveValue` still runs each one
 * through `sourceToExact`, because 40 of this pack's 1,497 perk stats set `scale_to_lvl` and the
 * un-levelled `v1` is the wrong number for every one of them.
 *
 * `learn_*` is dropped: a spell perk carries one, it is how the grid knows the perk teaches a
 * skill, and "+1 Learn Tailwind Sweep" is not a stat anybody wants to read.
 */
export function perkCard(
  snapshot: Snapshot,
  perkId: string,
  at: { perkLevel: number; characterLevel: number },
): GemCard | undefined {
  const view = perk(snapshot, perkId);
  const data = entry(snapshot, CATEGORY.perk, perkId)?.data;
  if (!view || !data) return undefined;

  const facts: CardFact[] = [];
  if (view.maxLevels > 1) {
    facts.push({
      label: "Level",
      value: `${at.perkLevel} / ${view.maxLevels}`,
      title: "`max_lvls`. Every rank grants the stats above once more.",
    });
  }
  if (view.oneKind !== undefined) {
    facts.push({
      label: "One Of",
      value: view.oneKind,
      // The game prints the same caution on its own tooltip (`Perk.java:135-139`).
      title: `Only one perk of kind ${view.oneKind} may be allocated.`,
    });
  }
  if (view.isEntry) {
    facts.push({
      label: "Entry",
      value: "yes",
      title: "An entry node: taking it is what opens this school.",
    });
  }

  const stats = linesFrom(
    snapshot,
    stripLearn(data["stats"]),
    100,
    at.characterLevel,
    Math.max(1, at.perkLevel),
  );

  return {
    id: perkId,
    name: perkName(snapshot, perkId),
    kind: isSpellPerk(snapshot, perkId) ? "Skill" : "Passive",
    stats,
    facts,
    ...(view.icon === "" ? {} : { icon: view.icon }),
  };
}

/**
 * A mob affix, resolved the way `MobAffix.getStatAndContext` resolves it: fixed at 100% and
 * scaled to the **mob's** level, not the character's. So the lines read what the Config tab's
 * toggle adds to the target, and agree with `mobAffixMods` in the engine.
 */
export function mobAffixCard(
  snapshot: Snapshot,
  affixId: string,
  at: { mobLevel: number },
): GemCard | undefined {
  const data = entry(snapshot, CATEGORY.mobAffix, affixId)?.data;
  if (!data) return undefined;

  const suffix = stringAt(data, "type") === "suffix";
  return {
    id: affixId,
    name: mobAffixName(snapshot, affixId),
    kind: suffix ? "Mob Suffix" : "Mob Prefix",
    stats: linesFrom(snapshot, data["stats"], 100, at.mobLevel),
    facts: [
      {
        label: "Scaled To",
        value: `Mob level ${at.mobLevel}`,
        title: "`ToExactStat(100, level)`: the mob's level, not yours",
      },
    ],
    note: "A mob rolls at most one prefix and one suffix.",
  };
}

/**
 * A map affix, at the map's roll and level.
 *
 * Map affixes have no lang name — the game's map tooltip prints only their stat lines, grouped
 * under "Mob Affixes" and "Player Affixes" — so the name is the humanised id and the lines are
 * what identifies it.
 */
export function mapAffixCard(
  snapshot: Snapshot,
  affixId: string,
  at: { roll: number; level: number },
): GemCard | undefined {
  const data = entry(snapshot, CATEGORY.mapAffix, affixId)?.data;
  if (!data) return undefined;

  const onPlayers = stringAt(data, "affected") === "Players";
  return {
    id: affixId,
    name: humanise(affixId),
    kind: onPlayers ? "Map Affix · on you" : "Map Affix · on mobs",
    stats: linesFrom(snapshot, data["stats"], at.roll, at.level),
    facts: [
      {
        label: "Roll",
        value: `${Math.round(at.roll)}%`,
        title: "`MapAffixData.p`: drawn from the map rarity's `stat_percents`",
      },
      {
        label: "Scaled To",
        value: `Map level ${at.level}`,
        title: "`getStats(p, getLevel())`: the map's level",
      },
    ],
  };
}

/** A perk's stat list without the `learn_<spell>` marker that makes it a spell perk. */
function stripLearn(raw: unknown): Record<string, unknown>[] {
  return modsOf(raw).filter((mod) => {
    const statId = mod["stat"];
    return typeof statId !== "string" || !statId.startsWith("learn_");
  });
}

/**
 * The item texture the game draws for a skill-gem-type item, by its `PlayStyle`.
 *
 * `assets/mmorpg/textures/item/skill_gems/{skill,support,aura}/{str,dex,int}.png` — nine files
 * for every gem in the game. There is no per-gem art anywhere in the install, which is worth
 * saying out loud because its absence looks like a missing extraction: a support gem is
 * identified in the inventory by its colour and its name, and the colour is the style.
 */
function gemTexture(kind: "skill" | "support" | "aura", style: string | undefined): string | undefined {
  const lower = (style ?? "").toLowerCase();
  if (lower !== "str" && lower !== "dex" && lower !== "int") return undefined;
  return `mmorpg:textures/item/skill_gems/${kind}/${lower}.png`;
}

/** `ExileEffect.getTexture()` — 209 of this pack's 212 effects ship one. */
function effectTexture(effectId: string): string {
  return `mmorpg:textures/item/mob_effects/${effectId}.png`;
}

/** The two footer rows a gem and an Augment word identically. */
function pushShared(facts: CardFact[], data: Record<string, unknown>): void {
  const style = stringAt(data, "style");
  if (style !== undefined) facts.push({ label: "Style", value: titleCase(style) });
  const minLevel = numberAt(data, "min_lvl");
  if (minLevel > 1) facts.push({ label: "Requires Level", value: String(minLevel) });
}

/**
 * The description, with its `[calc:…]` placeholders filled in.
 *
 * This is the half of a skill's tooltip that carries the actual numbers, and nothing in this app
 * resolved it before — the Skills tab printed `dealing [calc:arrow_barrage] ☀ Physical Damage`,
 * the variable name and all. The game substitutes `ValueCalculation.getShortTooltip`, which is
 * the base value at the caster's level followed by one `+N% Stat` per scaling term:
 *
 *     Channel to shoot out arrows, each dealing 412 +120% Attack Damage ☀ Physical Damage.
 *
 * Only the **base** is computed here, not `calculatedValue`. The scalings are printed as the
 * percentages they are rather than resolved against the sheet, exactly as the game prints them:
 * "+120% Attack Damage" is a property of the skill, and what your build turns it into is the
 * Damage tab's whole job one screen over.
 *
 * The raw lang string is read rather than `spellDesc`, because that helper strips the `§` codes
 * and the colours are half of what the line says.
 */
function describe(
  snapshot: Snapshot,
  spellId: string,
  at: { level: number; ceiling: number; characterLevel: number },
  bal: ReturnType<typeof balance>,
): Span[][] {
  const raw = snapshot.lang[LANG_KEY.spellDesc(spellId)];
  if (typeof raw !== "string" || raw.length === 0) return [];

  const filled = stripGlossaryMarkup(raw).replace(CALC_MARKUP, (whole, id: string) => {
    const calc = valueCalc(snapshot, id);
    if (calc === undefined) return whole;
    const base = baseValue(calc, at.level, at.ceiling, at.characterLevel, bal, ORIGINAL_MODE);
    const parts = [`§a${smart(base)}§7`];
    for (const scaling of calc.statScalings) {
      const percent = leveledValue(scaling.multi, at.level, at.ceiling) * 100;
      parts.push(`§b+${num(percent, 0)}% ${statName(snapshot, scaling.statId)}§7`);
    }
    return parts.join(" ");
  });

  return filled
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseFormatting(`§7${line}`));
}

/** `[calc:arrow_barrage]` — the only placeholder these strings carry. */
const CALC_MARKUP = /\[calc:([a-z0-9_]+)\]/gi;

/**
 * A registry entry's `stats` array, worded the way the item card words an affix.
 *
 * Through `totalLines` rather than `exactModLines`, for one thing the latter does not carry:
 * `StatLine.good`, which is `minus_is_good` and not the sign. A Support Gem whose whole purpose
 * is `MORE −20% Cast Speed` for more damage should read red on that line, and half this pack's
 * gems have exactly such a downside.
 *
 * `resolveValue` is the call the collectors make, so a number here cannot disagree with what the
 * gem actually contributes to the sheet.
 */
function linesFrom(
  snapshot: Snapshot,
  raw: unknown,
  rollPercent: number,
  characterLevel: number,
  /**
   * A whole-list multiplier, for a stacking exile effect. 1 everywhere else — a gem has no
   * equivalent, and folding it into `rollPercent` would be wrong: the stacks multiply the
   * interpolated value, they do not move it up its band.
   */
  stackMulti = 1,
): StatLine[] {
  const totals = new Map<string, StatTotal>();
  for (const mod of modsOf(raw)) {
    const statId = typeof mod["stat"] === "string" ? mod["stat"] : undefined;
    if (statId === undefined) continue;
    const rolled = resolveValue(snapshot, mod, rollPercent, characterLevel);
    if (rolled === undefined) continue;
    const value = rolled * stackMulti;

    let bucket = totals.get(statId);
    if (bucket === undefined) {
      bucket = { flat: 0, percent: 0, more: 0 };
      totals.set(statId, bucket);
    }
    const type = mod["type"];
    if (type === "PERCENT") bucket.percent += value;
    else if (type === "MORE") bucket.more += value;
    else bucket.flat += value;
  }
  return totalLines(snapshot, totals);
}

/** `config.tags.tags` — nested one deeper than every other list on the entry. */
function tagsOf(config: Record<string, unknown>): string[] {
  const node = asObject(config["tags"]);
  const list = node?.["tags"];
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is string => typeof t === "string");
}

function seconds(ticks: number): string {
  return `${num(ticks / TICKS, 2)}s`;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function leveledOf(raw: unknown): LeveledValue {
  const node = asObject(raw);
  const min = node === undefined ? 0 : numberAt(node, "min");
  const max = node === undefined ? 0 : numberAt(node, "max");
  return { min, max };
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function numberAt(node: Record<string, unknown>, key: string): number {
  const value = node[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringAt(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
