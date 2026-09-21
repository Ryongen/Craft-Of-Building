/**
 * The build document — the contract every other part of this project speaks.
 *
 * Three things will produce a `BuildDoc`, and they must all produce the *same* shape:
 *   1. a person authoring a character by hand (today),
 *   2. the app's editor UI (phase 1+),
 *   3. the companion Forge mod's character dump (after phase 3).
 *
 * That last one is why this package exists now rather than alongside the mod. The mod is
 * deferred, but the format it will emit is not — defining it up front means nothing
 * transcribed by hand today has to be re-entered later.
 *
 * ## Design rule: items are *constructed*, never a bag of finished stats
 *
 * An `Item` records the same fields Mine and Slash itself stores (`GearItemData`): a base,
 * a rarity, a level, and per-affix `{ id, tier, rollPercent }`. It never records "this item
 * gives +47 armor". The engine derives that. Recording outcomes instead of inputs would
 * make it impossible to tell a legal item from an impossible one, and the whole point of
 * hand-authored characters is that they be *recreatable* — faithful enough that a mismatch
 * against the game means the engine is wrong, not that the item was fictional.
 *
 * Every section below is optional. Phases add support incrementally, and the validator
 * checks only what is present, so a level-1 tree-only build and a fully geared one are both
 * valid documents at `schemaVersion: 1`.
 */

/** Build document format version. Bump only on an incompatible shape change. */
export const BUILD_DOC_VERSION = 1;

/**
 * A position in a talent tree's CSV grid, `[row, column]`, both 0-based.
 *
 * Trees are stored as comma-separated grids in `mmorpg_talent_tree/*.json` — 138 rows x 173
 * columns for `talents` and `atlas_passives`, 139 x 173 for `ascendancy`. Coordinates are
 * the identity of an allocation because the same perk id appears at many positions.
 */
export type TreeCoord = [row: number, col: number];

/**
 * One rolled affix on an item.
 *
 * `tier` is the subtle one. In `AffixData` the affix carries its **own** rarity (`rar`,
 * defaulting to `common`), which is *not* the item's rarity — `randomizeTier()` picks any
 * non-unique gear rarity whose `item_tier` is at most the item's, weighted by
 * `affix_rarity_weight`. The roll band then comes from that tier:
 *
 *     public MinMax getMinMax() { return getRarity().stat_percents; }
 *
 * So a mythic item can carry a common-tier affix rolling 0-17%, and recording only the
 * item's rarity would lose that. Ported from mahjerion/Mine-And-Slash-Rework @ 1.20-Forge,
 * `saveclasses/gearitem/gear_parts/AffixData.java`.
 */
export type AffixRoll = {
  /** `mmorpg_affixes` id. */
  affixId: string;
  /**
   * The affix's own tier: a `mmorpg_gear_rarity` id. `AffixData.rar`.
   *
   * **Absent for implicits, which have no tier at all.** `ImplicitStatsData` stores exactly
   * two fields — `Integer p` and `String imp` — where `AffixData` stores `rar` alongside them.
   * An implicit is not drawn from a tier and does not belong to one, so the field is optional
   * rather than filled with something plausible.
   */
  tier?: string;
  /**
   * `AffixData.p`, 0-100.
   *
   * For a tiered roll this is drawn from the **tier's** `stat_percents`, not the item's. For
   * an implicit it is drawn from `IGearPartTooltip.getMinMax`'s default `new MinMax(0, 100)`:
   * `ImplicitStatsData` is the one gear part that does not override it, so an implicit on a
   * common item rolls the same 0-100 as one on a mythic.
   */
  rollPercent: number;
};

/**
 * A piece of gear, expressed the way the game stores it.
 *
 * Uniques are a different shape rather than a flag: they carry `unique_stats` with their
 * own ranges instead of prefixes and suffixes, so mixing the two would allow documents the
 * game cannot produce.
 */
export type Item = {
  /** `mmorpg_base_gear_types` id. Determines the slot, the tags, and the base stat ranges. */
  base: string;
  /** `mmorpg_gear_rarity` id. Determines affix count, roll bands, socket and rune caps. */
  rarity: string;
  itemLevel: number;
  /**
   * Roll percent per entry of the base's `base_stats`, in declaration order. Bounded by the
   * item rarity's `base_stat_percents` (not `stat_percents`, which governs affixes).
   */
  baseRolls?: number[];
  implicits?: AffixRoll[];
  prefixes?: AffixRoll[];
  suffixes?: AffixRoll[];
  /** Affix of type `enchant`. At most one per item. */
  enchant?: AffixRoll;
  /** Affixes of type `chaos_stat` — what corruption adds. */
  corruptions?: AffixRoll[];
  /** `mmorpg_unique_gears` id. When set, prefixes/suffixes must be empty. */
  unique?: string;
  /** Roll percent per entry of the unique's `unique_stats`, in declaration order. */
  uniqueRolls?: number[];
  /** `mmorpg_gems` ids, one per filled socket. */
  sockets?: string[];
  /** `mmorpg_runes` ids. */
  runes?: string[];
  /**
   * `SocketData.p` per entry of `runes`, in the same order, 0-100.
   *
   * A rune rolls its stats when it is socketed, exactly as an affix does, and `SocketData`
   * stores the percent next to the id:
   *
   *     // gem id
   *     public String g = "";
   *     public int p = 0;
   *
   * Without it every rune computes at its minimum, which for a fully socketed runeword item is
   * a large and entirely invisible shortfall.
   */
  runeRolls?: number[];
  /** `mmorpg_runeword` id, legal only on a rarity with `can_have_runewords`. */
  runeword?: string;
  /**
   * `GearSocketsData.rp` — the roll the runeword got when it completed, 0-100.
   *
   * Without it a runeword computes at 0%, which is a real item but rarely the one being worn.
   */
  runewordRoll?: number;
  /**
   * `CustomItemData.KEYS.QUALITY` — the quality percent, which the game **adds to the base
   * stat roll**: `int p = this.p + gear.getQualityBaseStatsBonus(stack)`.
   *
   * Recorded separately from `baseRolls` so the two stay distinguishable. When it is present,
   * `baseRolls` holds the stored roll alone and the engine adds this; when it is absent,
   * `baseRolls` is whatever the document's author put there.
   */
  quality?: number;
  /**
   * Vanilla enchantments on the item, keyed by registry id
   * (`minecraft:protection`, `minecraft:fire_protection`, ...) with the level as the value.
   *
   * 27 of the pack's `mmorpg_stat_compat` entries are enchantment compat, and they are summed
   * **across every equipped piece** rather than per item:
   *
   *     for (ItemStack stack : stacks) {
   *         int enchlvl = stack.getEnchantmentLevel(ench);
   *         if (enchlvl < 1) { continue; }
   *         int val = (int) (enchlvl * conversion);
   *         value += MathHelper.clamp(val, per_item_min, per_item_max);
   *     }
   *     value = MathHelper.clamp(value, minimum_cap, maximum_cap);
   *
   * — StatCompat.getEnchantCompatResult:73-98. Note the two clamps: one per item, one on the
   * total. Protection IV on four pieces is not the same as Protection XVI on one.
   */
  enchantments?: Record<string, number>;
};

/**
 * The omen — a "Codex" in Craft to Exile 2's own wording — worn in its own curio slot.
 *
 * Not a piece of gear, and deliberately not modelled as one. An omen is a **conditional set
 * bonus**: it grants nothing by itself, and what it grants depends on how much of the rest of
 * your loadout meets requirements it carries. `OmenData` is what the item stores, and every
 * field below is one of its fields.
 *
 * ## How it pays out
 *
 * `OmenSet`'s constructor buckets the omen's stats by how many qualifying pieces they need:
 *
 *     int index = max;                      // max = sum of every entry in `rarities`
 *     int perc  = OmenData.getStatPercent(rarities, slot_req, getRarity());
 *     stats.get(index).addAll(getOmen().mods.map(x -> x.ToExactStat(perc, lvl)));
 *     index--;
 *     for (AffixData affix : data.aff) { stats.put(index, affix.GetAllStats(lvl)); index--;
 *                                        if (index < 2) { index = 2; } }
 *
 * and `getStats` pays out every bucket whose key is at most `omensFilled`:
 *
 *     for (var en : this.stats.entrySet()) { if (fill >= en.getKey()) all.addAll(en.getValue()); }
 *
 * So the omen's own `mods` are all-or-nothing at the full requirement, and each corruption
 * affix unlocks one piece earlier than the last, never below two.
 *
 * ## The roll percent is earned, not rolled
 *
 * There is no roll on an omen's own mods. `getStatPercent` derives one from how hard the omen
 * is to satisfy — the class comments it "the more difficult the omen is to assemble, the more
 * stats it provides":
 *
 *     int num = 0;
 *     for (var en : rarities.entrySet()) { num += en.getValue() * 10; }
 *     num += slot_req.size() * 10;
 *     num *= rar.omens.stat_multi;
 *
 * Note `num` is an `int` and `stat_multi` a `float`, so the compound assignment truncates.
 * Note also that **nothing clamps it to 100**: `ExactStatData.fromStatModifier` is a bare
 * `min + (max - min) * percent / 100F`, and a mythic omen with heavy requirements can reach
 * 125, putting its stats above the declared maximum. That is the game's behaviour, so it is
 * this project's too.
 */
export type OmenSetup = {
  /** `mmorpg_omen` id — `OmenData.id`. Nine exist: blood, echoes, fangs, flames, ... */
  id: string;
  /** `OmenData.lvl`. Its own mods and affixes scale at this, not the character's level. */
  itemLevel: number;
  /** `OmenData.rar`, a `mmorpg_gear_rarity` id. Only its `omens.stat_multi` is read. */
  rarity: string;
  /**
   * `OmenData.rarities` — how many equipped pieces of each `GearRarityType` are required.
   *
   * Keys are `NORMAL`, `UNIQUE` or `RUNED`, which is the *type* of a gear rarity rather than
   * the rarity: all six ordinary rarities are `NORMAL`, so "two NORMAL" is satisfied by a
   * common and a mythic. The sum of these is the threshold the omen's own mods sit at.
   */
  requires?: Record<string, number>;
  /**
   * `OmenData.slot_req` — a specific slot that must hold a specific rarity type.
   *
   * These do not add to the piece count. They *disqualify*: a piece in a named slot whose type
   * does not match stops that piece counting at all. They do raise the stat percent, by ten
   * each.
   */
  slotRequirements?: { slot: string; rarityType: string }[];
  /**
   * `OmenData.aff` — corruption affixes, each unlocking one piece earlier than the last.
   *
   * Only `affixId` is an input. An omen's affix does not roll: `OmenBlueprint.generate` sets
   * `adata.rar` to the omen's own rarity and `adata.p` to
   * `OmenData.getStatPercent(rarities, slot_req, rar)` — the same number the omen's own mods
   * resolve at — rather than calling `AffixData.RerollNumbers`, and the two currencies that
   * edit an omen in place rewrite both from those same sources. So the `tier` and
   * `rollPercent` recorded here are copies of the omen's, kept because the exporter writes
   * what the game stored; `omenBuckets` re-derives them, and the validator reports a copy that
   * has fallen out of step.
   */
  affixes?: AffixRoll[];
};

/** A jewel socketed into the tree. Jewels carry affixes of type `jewel`. */
export type Jewel = {
  rarity: string;
  itemLevel: number;
  /**
   * `JewelItemData.style` — a `PlayStyle` id: `str`, `dex` or `int`. Defaults to `str`, as
   * the Java field does.
   *
   * It looks cosmetic and is not. It decides two things:
   *
   *  - **which item the jewel is**, and so what it is called — Meteorite, Viridian or
   *    Stardust Jewel (`JewelItemData.getItem()`);
   *  - **which affixes may roll on it.** `generateAffixes` filters the pool to
   *    `any_jewel` plus the style's own tag, so of the pack's 53 `jewel` affixes a Viridian
   *    jewel may carry 44 and a Meteorite one 45. A jewel with `jewel_mana_regen` and
   *    `style: "str"` is not an item the game can produce.
   */
  style?: string;
  affixes?: AffixRoll[];
  /** `JewelItemData.cor` — corruption affixes, kept apart from the rolled ones. */
  corruptions?: AffixRoll[];
  /** Where it is socketed, if known — a coordinate in the `talents` grid. */
  socket?: TreeCoord;
  /**
   * `CraftedUniqueJewelData` — a crafted unique jewel, such as a Watcher's Eye.
   *
   * `id` is a `mmorpg_unique_gears` entry and `rollPercent` the single percent its stats roll
   * at (`CraftedUniqueJewelData.perc`); `tier` is the crafted tier, which decides how many of
   * the unique's stats it actually carries.
   */
  unique?: { id: string; rollPercent: number; tier?: number };
  /**
   * `JewelItemData.auraStats` — affixes that apply only while a given aura is running.
   *
   * Each entry is one `StatsWhileUnderAuraData`: an affix, its roll and the level it rolls at,
   * which is the jewel's own rather than the character's. Which aura gates it is a property of
   * the affix (`getAura()`), not of this record.
   */
  auraStats?: { affixId: string; rollPercent: number; itemLevel: number }[];
};

/**
 * One support gem linked into a skill, with the roll that gem itself carries.
 *
 * A note on names, because the Java is misleading: the game stores a **Skill** and a **support
 * gem** in the same `SkillGemData` class, distinguished only by a `SkillGemType`. To a player
 * they are not the same thing at all — a Skill is what sits on the bar, support gems are what
 * link into it — so this file uses the player's words and quotes the Java's.
 *
 * Each support gem is a separate item with its own `SkillGemData`, and `collectGemStats` rolls
 * it at **its own** percent:
 *
 *     for (SkillGemData d : gem.getSupportDatas()) {
 *         statContexts.add(new SimpleStatCtx(SUPPORT_GEM, d.getSupport().GetAllStats(data, d)));
 *     }
 *
 * with `SupportGem.GetAllStats` reading `data.getStatPercent()` off that `d`. Five support gems
 * linked into one Skill are five independent rolls; the Skill's own percent is not one of them
 * and does not reach them.
 *
 * A bare string is the same link with no roll recorded — that is what every document written
 * before this field existed says, and it still means "fall back to the skill's `gemPercent`".
 */
export type SupportLink = {
  /** `mmorpg_support_gem` id. */
  id: string;
  /** `SkillGemData.getStatPercent()` for this gem, 0-100. */
  rollPercent?: number;
  /**
   * `SkillGemData.rar` — a `mmorpg_gear_rarity` id, common through mythic.
   *
   * Support gems carry a rarity exactly as Augments do, and it means the same thing: not stats
   * of its own, but the band `rollPercent` was drawn from. See {@link AuraSetup.rarity}.
   */
  rarity?: string;
  /**
   * Whether this link counts at all. Defaults to true; read it through {@link isSupportEnabled}.
   *
   * Nothing in the game has this switch — a socketed gem is socketed. It is a planner
   * affordance, and the same one {@link SkillSetup.enabled} is: the question a support gem list
   * exists to answer is "what would this gem be worth to me", and the only way to read that off
   * the damage number is to take the gem out and put it back. Doing that by deleting the link
   * loses the rarity and the roll, which are the two things that made it *your* gem rather than
   * a generic one — so the comparison you wanted costs you the setup you were comparing
   * against.
   *
   * A disabled link contributes no stats and no cast-cost multiplier, exactly as an empty
   * socket would, and keeps everything else.
   */
  enabled?: boolean;
};

export type SkillSetup = {
  /** `mmorpg_spells` id. */
  spellId: string;
  /** The Skill's rank. Omit for the default. */
  level?: number;
  /** `mmorpg_support_gem` ids linked to this skill, each with its own roll. */
  supports?: (string | SupportLink)[];
  /**
   * `SkillGemData.getStatPercent()` for the **Skill's own** item, 0-100.
   *
   * In game this does nothing: `Spell.getStats` derives its own percent from the Skill's rank
   * (`getLevelOf(p) / getMaxLevelWithBonuses() * 100`) and never reads the item. It is kept
   * because a capture records it, and because it is the fallback roll for any support gem that
   * has not recorded one of its own — which is the best a pre-`SupportLink` document can offer.
   * Omitting both computes support gems at 0% with a warning, the same floor auras and runes
   * get, rather than inventing a percent.
   */
  gemPercent?: number;
  /**
   * The skill damage is reported for. At most one skill in a document may set it; with none
   * set the engine takes the first, and says so.
   */
  main?: boolean;
  /**
   * Include this skill in the Full DPS rotation.
   *
   * Ticking several skills asks "what do I do to a target when I play normally", which for this
   * pack is rarely one button: a `finisher` such as `raging_dragon` refuses to cast at all
   * without the `combo_extender` an `extender` skill grants, and the extender's cast costs the
   * finisher real time through the shared global cooldown. Full DPS models one pass through
   * every ticked skill; `main` still selects the single-skill figure beside it.
   */
  includeInFullDps?: boolean;
  /**
   * Whether this skill counts at all. Defaults to true; read it through `isSkillEnabled`.
   *
   * A disabled skill keeps everything it has — its level, its support gems, its place in the
   * list — and contributes nothing: no innate stats, no support-gem stats, no Full DPS, none of
   * the exile effects it would have made available, and nothing when a `proc_spell` casts it for
   * you. That is the point. Comparing two support setups means turning one off and reading the
   * number, and deleting the skill to do it loses the setup you were comparing against.
   *
   * The proc case is the one worth naming, because it is the only route a switched-off skill has
   * back into a figure: a procced spell is resolved by id rather than off the skill list, so
   * nothing else in the pipeline would have noticed the switch. This box is therefore the single
   * place a proc is turned off — there is no separate toggle for one, and there should not be:
   * a proc is what your gear does, not something you opt into.
   */
  enabled?: boolean;
};

/**
 * Where the enemy stands, relative to the caster.
 *
 * The one thing a build document has to state that the game data cannot answer. A cast of
 * `raging_dragon` throws nine projectiles that spiral outward pulsing every 0.2s; how many of
 * those pulses reach a given enemy is decided by where that enemy is, and the engine flies the
 * projectiles rather than guessing — but it has to be told what it is flying at.
 *
 * The defaults describe melee range against a player-sized mob directly in front of you.
 */
export type TargetPlacement = {
  /** Horizontal blocks from the caster to the target's centre. */
  distance: number;
  /** The target's collision radius — 0.3 for a vanilla humanoid mob. */
  radius: number;
  /** Degrees between where the caster faces and the target. 0 is dead ahead. */
  bearing: number;
  /** Blocks from the caster's feet to the target's centre height. */
  height: number;
};

/**
 * The target a damage event resolves against.
 *
 * Stated rather than derived. The game builds a mob's defences by running the same stat
 * calculation over `mmorpg_entity` + `mmorpg_mob_rarity` + map tier, and reproducing that
 * would stack a second unverified calculation underneath every damage number — a mismatch
 * would not say which half was wrong. Sandbox numbers are an assumption a fixture can pin.
 *
 * Keys of `resists` and `maxResists` are element GUIDs: `physical`, `fire`, `water`,
 * `lightning`, `chaos` (`Elements.guidName`). A missing element reads 0.
 */
/**
 * The same mob, read from the other side: what its hit does to *you*.
 *
 * Mirrors the Training Dummy mod's offensive stat groups, which is where these come from — the
 * dummy hits back, and `DummyStatCatalog` groups exactly these as the stats that decide what its
 * return hit is worth. Like the defensive block above, it is **stated rather than derived**, and
 * `buildTargetEnemy` fills it from what `MobStatUtils` actually gives a mob:
 *
 *     stats.add(ExactStatData.scaleTo(1, ModType.FLAT, OffenseStats.ACCURACY.get().GUID(), lvl));
 *
 * and nothing else offensive. A mob has **no penetration and no critical strike chance** from the
 * base formula — those come from map affixes and per-entity config, which is why they are fields
 * you can fill rather than numbers a preset invents.
 *
 * Keys of `penetration` are element GUIDs, as in `resists`.
 */
export type MobOffence = {
  /**
   * `accuracy`, subtracted from your dodge rating before the curve
   * (`DodgeRating`: `clamp(dodge - ACCURACY, 0, MAX)`).
   */
  accuracy?: number;
  /** `armor_penetration`, taken off your armour before its mitigation curve. */
  armorPenetration?: number;
  /** `<element>_penetration`, taken off the raw resist *before* the 75% clamp. */
  penetration?: Record<string, number>;
  /**
   * `critical_hit` and `critical_damage`.
   *
   * Recorded but not part of effective HP, and deliberately: eHP answers "how much raw incoming
   * damage do I survive", and a crit makes the raw number bigger rather than making your
   * mitigation worse. Fold it in by hand — a 250% crit against a 30% crit chance is a 45% larger
   * average hit, not 45% less effective HP.
   */
  critChance?: number;
  critDamage?: number;
  /**
   * `total_damage` — `(EntityConfig.dmg_multi - 1) * 100`, per mob rather than per rarity.
   *
   * Same story as crit: it scales the hit, not your defences.
   */
  totalDamage?: number;
};

export type EnemySetup = {
  level?: number;
  armor?: number;
  resists?: Record<string, number>;
  maxResists?: Record<string, number>;
  blockChance?: number;
  dodge?: number;
  /**
   * `spell_dodge` — the mob's evasion against a spell, where {@link dodge} is against an attack.
   *
   * Two separate stats in Mine and Slash and two separate numbers on a mob: the pack's
   * `mmorpg_base_stats/mob` gives 20 of one and 15 of the other, both level-scaled, so an Epic
   * at level 100 dodges 416 of your attacks' accuracy and 312 of your spells'. Stating only the
   * first made every spell build read as though the target had no evasion against it at all.
   */
  spellDodge?: number;
  damageReduction?: number;
  /** What this mob's own hit does to you — the other half of a target preset. */
  offence?: MobOffence;
  /**
   * `mmorpg_mob_affix` ids the target carries — what makes a real Epic tougher than the preset.
   *
   * Stated as ids rather than as the numbers they come to, which is the whole point: the fields
   * above are someone's guess at a mob's armour, and an affix is the game's own answer. The
   * Training Dummy mod settled on the same shape — its presets "pin no numbers at all" and take
   * affixes as toggles — so a figure here and a figure measured against a dummy are asking the
   * same question.
   *
   * Each resolves at `ToExactStat(100, level)` against {@link EnemySetup.level}: fixed, not
   * rolled, and at the mob's level rather than the character's. They stack with the fields above
   * rather than replacing them, in one accumulator, because that is what the container does.
   *
   * A mob rolls at most one prefix and one suffix; more than that is reported rather than
   * refused, since asking "what would three cost" is a fair planner question.
   */
  affixes?: string[];
};

/**
 * An Augment the character has socketed — an aura gem, as the Java calls it.
 *
 * `enabled` is optional and **defaults to true**: Augments a build has are normally on, and
 * making the common case the default keeps hand-authored documents short. Use
 * {@link isAuraEnabled} rather than reading the field, so the default lives in one place.
 */
export type AuraSetup = {
  /** `mmorpg_aura` id — `SkillGemData.id` for a gem of type `AURA`. */
  id: string;
  enabled?: boolean;
  /**
   * `SkillGemData.rar` — a `mmorpg_gear_rarity` id, common through mythic.
   *
   * It grants no stats of its own. What it does is **bound the roll**: a gem's percent is
   * drawn from its rarity's band and nothing moves it out again —
   *
   *     data.rar = rar.GUID();
   *     data.perc = rar.stat_percents.random();
   *
   * — SkillGemBlueprint.java:32-40, and `UpgradeSkillGemRarityItemMod` rescales `perc` into the
   * new band when the rarity goes up rather than leaving it behind. So a mythic Augment rolls
   * 86-100 and a common one 0-17, and a document claiming a common gem at 95% is describing an
   * item the game cannot make.
   */
  rarity?: string;
  /**
   * `SkillGemData.getStatPercent()` — the roll the aura *gem* carries, which every one of the
   * aura's stats is interpolated at:
   *
   *     public List<ExactStatData> GetAllStats(EntityData en, SkillGemData data) {
   *         return this.stats.stream()
   *             .map(x -> x.ToExactStat(data.getStatPercent(), en.getLevel()))
   *             .collect(Collectors.toList());
   *     }
   *
   * — AuraGem.java:98-104. Without it an aura computes at its minimum, and an aura is not a
   * small contribution: a single one can be a third of a character's dodge.
   */
  rollPercent?: number;
};

export type ExileEffectSetup = {
  /** `mmorpg_exile_effect` id. */
  id: string;
  /**
   * Stacks the capture recorded.
   *
   * Honoured for an ordinary buff — one caught at two of five was genuinely at two. **Not** for
   * a `charge`-tagged effect, which is a resource you sit at the cap of and whose cap is the one
   * thing an edit can move (`MaximumChargesStat`). There the cap wins; see `effect-state.ts`.
   */
  stacks?: number;
  /**
   * The spell that applied the effect (`ExileEffectInstanceData.spell_id`).
   *
   * Not decoration: an effect's stats are rolled at a percent interpolated over *that spell's*
   * rank, not at a fixed value.
   *
   *     LeveledValue lvlval = new LeveledValue(0, 100);
   *     int perc = (int) lvlval.getValue(caster, spell);
   *     var result = x.ToExactStat((int) (perc), Load.Unit(caster).getLevel());
   *
   * — ExileEffect.getExactStats:150-176, and `LeveledValue.getValue` returns **0 when the
   * provider is null**. So an effect whose applying spell is unknown really does roll its
   * minimum, and recording the spell is the whole difference between a buff at 0% and the same
   * buff at 75%.
   */
  spellId?: string;
  /**
   * `ExileEffectInstanceData.str_multi` — a flat multiplier on every stat the effect grants,
   * applied last:
   *
   *     result.percentIncrease = (100 * multi) - 100;
   *     result.increaseByAddedPercent();   // v1 *= (1 + percentIncrease / 100F)
   *
   * which is exactly `v1 *= multi`. Defaults to 1.
   *
   * **Recorded, not consumed.** The engine derives this rather than reading it — see
   * `strMultiFor` in `damage/effect-state.ts`, which sums the `inc_effect_of_*_buff_*` stats
   * matching the effect's own tags and reproduces every value captured in this project's
   * fixtures exactly. Reading it here froze a buff at whatever the character was when the
   * capture was taken, so an ascendancy worth +50% to defensive buffs moved nothing.
   *
   * It stays in the document because a capture is still the measurement worth keeping: the
   * engine carries it as `EffectOption.capturedStrMulti` and the UI shows it beside the derived
   * number, so the two diverging is visible rather than silent.
   */
  strMulti?: number;
};

/**
 * Context the engine needs that is not part of the character: what it is fighting and which
 * conditional modifiers are considered active.
 *
 * `conditions` exists because 308 `mmorpg_stat_condition` entries gate stat and damage-layer
 * contributions ("while on low life", "if you have crit recently"). An unlisted condition is
 * *not* assumed false silently — it must fail loud, per the project's standing rule against
 * silent defaults. What that means in practice depends on the condition, and they fall into
 * three kinds:
 *
 *   - **Derivable** from the build and the chosen skill — `spell_has_tag_*` (118 entries),
 *     `wep_type_match`, `is_ailment_*`, `ele_match_stat`, `is_spell`. The engine answers
 *     these from the data. Declaring them here does nothing and they are never reported.
 *   - **Chance** — `random_roll`, referenced 144 times. The engine models the probability
 *     and names each one it applied. Declaring one forces it on or off outright.
 *   - **World or timeline** — `is_*_not_on_cd` (73), `is_in_combat`, `is_day`,
 *     `light_level`, `is_target_low`, `is_under_exile_effect`. Nothing in a static document
 *     answers these. Left out they are treated as inactive *and reported*, one diagnostic
 *     per distinct id.
 */
export type BuildConfig = {
  /** Shorthand for `enemy.level`. `enemy.level` wins when both are set. */
  enemyLevel?: number;
  mapTier?: number;
  enemy?: EnemySetup;
  /** Condition id -> whether it is considered active. */
  conditions?: Record<string, boolean>;
  /**
   * How much health the target has left, as a percent of its maximum.
   *
   * One number instead of seven toggles, and the reason is that the seven are not independent.
   * This pack gates stats on the target being under 50%, under 25%, above 70% and above 30%, and
   * a build screen that offered each as its own switch let you say the mob was on 20% health and
   * near full at the same time — so "Vital Points" and "Swift Killer" both paid out at once, on
   * a mob that cannot exist. A percentage answers all seven at once and can only answer them
   * consistently.
   *
   * Compared exactly as the game compares it, strict either way:
   *
   *     is_hp_above:  return perc < en.getHealth() / en.getMaxHealth() * 100;
   *     is_hp_under:  return perc > en.getHealth() / en.getMaxHealth() * 100;
   *
   * — IsHealthAbove/BellowPercentCondition.java. So a target stated at exactly 50% satisfies
   * neither `is_target_low_hp` nor an `is_hp_above` of 50.
   *
   * **Unset means unstated**, not full: the conditions then resolve to `unknown` and are reported
   * the way they always were, because a planner that quietly assumed a full-health target would
   * be turning every execute bonus in the pack off without saying so. `config.conditions` still
   * overrides an individual one.
   */
  targetHealthPercent?: number;
  /**
   * The same, for the character's own health — `is_source_low_hp` and `is_source_very_low_hp`.
   *
   * "While on low life" is a build choice rather than an accident, which is why it is stated here
   * rather than derived: a build *plays* at 30% health on purpose, and the damage it is worth
   * there is the number its owner wants.
   */
  selfHealthPercent?: number;
  /**
   * Exile effect id -> how many stacks of it are up, for the effects the build can produce.
   *
   * `true` means "up, at the cap", `false` means off, and a number pins the stacks. Anything the
   * build can grant and this map does not mention is assumed up at the cap — see
   * `resolveEffectState`, which also reports every one of them and what granted it.
   *
   * This is how the pack's branch tables are answered. `armageddon` declares its meteors twice,
   * the second copy gated on four `overheat` stacks; `soul_siphon` has eight mutually exclusive
   * `on_cast` parts keyed on which aura you run and whether `sacrifice` is at three; every
   * weapon skill asks which stance you are in. Debuffs live here too: `shred` and
   * `elemental_weakness` are `negative`, so their stats land on the *enemy's* sheet rather than
   * yours, which is what makes "assume the target is shredded" a number rather than a wish.
   *
   * Mutually exclusive effects — `ExileEffect.one_of_a_kind_id`, which groups the thirteen auras,
   * the two stances, the three hymns — resolve to one member, and an explicit entry here is what
   * wins that choice.
   */
  effects?: Record<string, EffectSetup>;
  /**
   * What an effect this map does not mention is assumed to be.
   *
   *   - **`"available"`** — up, at its cap. The planner's default: a build that owns the skill
   *     that grants `overheat` can obviously be at four stacks of it, and reporting zero for
   *     every combo finisher on the bar would be useless.
   *   - **`"captured"`** — off unless `exileEffects` recorded it. A capture is a complete
   *     reading of what was live at that instant, so anything absent from it was not up, and a
   *     sheet that adds buffs the game was not running will not reconcile with the game.
   *
   * **Unset means `"available"`**, because this is a planner. A build you are working on should
   * show what it can do, with a toggle for every effect it could put up; and a build imported
   * from the game is still a build you are going to work on. `"captured"` is for the one caller
   * whose question is different — a fixture, which compares a sheet against a *measurement* of
   * that character at one instant, where an effect the capture did not record was genuinely not
   * running and adding it would stop the two ever reconciling. `checkFixture` sets it itself.
   *
   * Either way the engine reports which reading it took, in `EffectState.assume`.
   */
  assumeEffects?: "available" | "captured";
  /**
   * Which built-in target the enemy block was built from, when it was.
   *
   * These mirror the Training Dummy mod's presets one for one, so a number here and a number
   * on the dummy in game are measured against the same thing. `enemy` still wins over anything
   * the preset produced — the preset fills the block, the block is what the engine reads.
   */
  targetPreset?: string;
  /** Where the enemy stands, for the projectile geometry. Unset means `DEFAULT_PLACEMENT`. */
  target?: TargetPlacement;
  /**
   * How many enemies are in range, for the pack figure only.
   *
   * Never touches the single-target number. Every enemy is assumed to be placed like the one
   * in `target`, which flatters a skill whose area is smaller than the pack is wide.
   */
  packSize?: number;
  /**
   * Force a damage source's hits-per-cast instead of letting the engine derive it, keyed by
   * `DamageSource.id`.
   *
   * The engine flies each projectile and counts what lands, so this is an override rather than
   * the normal path — for a homing projectile it cannot simulate, or a mob you know will not
   * stand in your ground effect for its full duration.
   */
  coverageOverrides?: Record<string, number>;
  /**
   * `ServerContainer.IN_COMBAT_REGEN_MULTI` — how much of your regeneration you keep while
   * fighting. Unset means this pack's own value.
   *
   * It is here rather than derived because it is a **server config**, not pack data: it lives in
   * `defaultconfigs/mine_and_slash-server.toml`, which the extractor does not read and which a
   * server owner is free to change after a world is created. Craft to Exile 2 ships `1.0` and
   * the mod's own default is `0.5`, so the two most likely worlds a player is on differ by a
   * factor of two on every regeneration number the Defence tab prints and on whether the Damage
   * tab calls a build sustainable.
   *
   * `in_combat` is a ten-second cooldown that every hit you land or take re-stamps, so anything
   * resembling a rotation sits inside it. Energy is exempt by name in
   * `RestoreResourceEvent.activate` and is not scaled by this.
   */
  inCombatRegenMulti?: number;
};

/**
 * One saved stage of a build: the trees, the points and the level they were planned at.
 *
 * A build is not one allocation, it is a sequence of them — the tree you run to 20, the one you
 * respec into at 50, and the two endgame trees you are still arguing with yourself about. Before
 * this there was one way to keep the earlier ones, which was to save a second file, and a second
 * file is a second character: change a ring and you have changed it in one of them.
 *
 * So a stage holds the part of a build that is **spent**, and nothing else:
 *
 *   - the three trees,
 *   - `statPoints` and `schools`, which are spent out of the same levelling budget and move for
 *     the same reasons — a level-20 tree next to a level-100 stat allocation is not a stage of
 *     anything,
 *   - the `level` all of the above were planned at, which is what makes the point budgets, the
 *     school row requirements and every level-scaled perk read correctly when it is switched to.
 *
 * Gear, jewels, skills, auras, the enemy and the config are **not** here. They belong to the
 * character and are shared by every stage, which is the entire difference between this and
 * saving another file: switching stage changes what you spent, never what you are wearing.
 *
 * Every field below the id and the name is optional and means "nothing allocated", exactly as
 * the same field means on {@link BuildDoc} — a brand new stage is a legal empty one.
 */
export type BuildStage = {
  /**
   * Stable identity, opaque and never shown. Referenced by {@link BuildDoc.activeStage}.
   *
   * Not the name: a stage called "Levelling" that gets renamed to "1-20" is the same stage, and
   * two stages are allowed to be called the same thing by a person who has not finished
   * thinking yet.
   */
  id: string;
  /** What the player called it — "1-20", "Crit endgame". Free text, theirs to change. */
  name: string;
  /**
   * The one stage that represents this build to anything that can only show one: an exporter, a
   * build-guide viewer, a thumbnail.
   *
   * Separate from {@link BuildDoc.activeStage} on purpose. Opening the levelling tree to check
   * something must not silently change what a guide publishes, and the endgame tree a build is
   * *about* is usually not the one being edited at any given moment.
   *
   * At most one stage carries it. Absent rather than `false` on the others, so the flag reads as
   * a mark on one entry rather than a field every entry has an opinion about.
   */
  main?: true;
  /** `character.level` this stage was planned at. */
  level?: number;
  talents?: TreeCoord[];
  ascendancy?: TreeCoord[];
  atlas?: TreeCoord[];
  /** `character.statPoints` — see there. */
  statPoints?: Record<string, number>;
  /** `character.schools` — see there. */
  schools?: Record<string, number>;
};

export type BuildMeta = {
  name?: string;
  createdAt?: string;
  /** Versions this document was authored against, for spotting drift after a pack update. */
  mineAndSlashVersion?: string;
  packVersion?: string;
  notes?: string;
};

export type BuildDoc = {
  schemaVersion: number;
  meta?: BuildMeta;
  character: {
    level: number;
    /** `mmorpg_spell_school` id. */
    school?: string;
    /** Ascendancy identifier, as used by the `ascendancy` tree. */
    ascendancy?: string;
    /**
     * Level-up points spent on core stats — `PlayerData.statPoints.map`, verbatim.
     *
     * Keys are `mmorpg_stat` ids with the `core_stat` serializer (`strength`, `dexterity`,
     * `intelligence`); values are whole points. The game stores exactly this — a
     * `HashMap<String, Integer>` — and `AllocateStatPacket` refuses any key that is not a
     * `CoreStat`, so recording the map rather than the resulting stat totals keeps an
     * allocation recreatable in the same way an affix roll is.
     *
     * One point is worth **+1 flat**, at every character level. `StatPointsData` emits
     * `ExactStatData.levelScaled(val, stat, ModType.FLAT, 1)` — level *one*, hardcoded — and
     * `CORE_STAT_SCALING` is `base 1 + 0.05 * (lvl - 1)`, which at level 1 is exactly 1. A
     * point spent at level 90 is worth what it was at level 2.
     */
    statPoints?: Record<string, number>;
    /**
     * Spell school allocations — `SpellSchoolsData.allocated_lvls`, verbatim.
     *
     * Keys are **perk ids**, values the level that perk is levelled to. Not school ids: the
     * game allocates into individual perks and derives the set of schools from which grids
     * those perks live in, so recording it this way is what keeps `school`, the solo-class
     * bonus and the two-school limit all answerable from one field rather than three.
     *
     * A perk at level N grants N times its stats, and a **spell** perk's stat is
     * `learn_<spellId>`, which `SpellCastingData.calcSpellLevels` reads back as the spell's
     * rank. So this field also determines every spell level — see `spell-schools.ts`.
     */
    schools?: Record<string, number>;
    /**
     * The game's own point totals, keyed by `PlayerPointsType` (`TALENTS`, `SPELLS`,
     * `PASSIVES`, `STATS`, `ASCENDANCY`, `ATLAS`).
     *
     * Present only in a document the companion mod produced, because only the game can know
     * it: `getFreePoints` adds `getBonusPoints` from quests and items, which no document can
     * derive from a level. Where it is present the validator trusts it instead of the
     * level-derived ceiling, which is what stops a legitimately quest-boosted character from
     * being reported as having overspent.
     */
    pointTotals?: Record<string, number>;
    /**
     * Whether the campaign's epilogue is done, which is worth four passive points and ten
     * spell points — `EPILOGUE_BONUS_POINTS` in `queries.ts` has both numbers and where
     * they came from.
     *
     * A statement about progression rather than about the character sheet, and it has to be one:
     * `getBonusPoints` is quest and item rewards, and no amount of levelling derives it. Without
     * it a level-100 plan is four passives and ten spell points short of the character it is
     * planning, which is the difference between a tree that fits and one that does not.
     *
     * Ignored outright where {@link pointTotals} is present — a document the companion mod
     * produced carries the game's own finished count, and a checkbox cannot improve on it.
     */
    questsComplete?: boolean;
    /**
     * `PlayerData.omensFilled` — how many equipped pieces the game counted as satisfying the
     * omen's requirements.
     *
     * The engine derives this itself from `gear`; this is the game's own answer, recorded so
     * the two can be compared. A disagreement is a bug in the derivation, and without this
     * field it would surface as a wrong stat somewhere downstream instead.
     */
    omensFilled?: number;
    /**
     * The player's **vanilla** attribute totals, keyed by registry id
     * (`minecraft:generic.max_health`, `kubejs:dodge`, ...).
     *
     * `mmorpg_stat_compat` turns these into real MnS stats, and reads the *total* value rather
     * than the bonus:
     *
     *     int val = (int) (en.getAttributeValue(at) * conversion);
     *     int value = MathHelper.clamp(val, minimum_cap, maximum_cap);
     *     value = (int) scaling.scale(value, lvl);
     *     return ExactStatData.noScaling(value, mod_type, mns_stat_id);
     *
     * — StatCompat.getResult:101-126. Nothing else in the document implies them: they come
     * from other mods entirely (Solonion's food-diversity benefits, Mine and Meals, KubeJS),
     * so a character that has eaten a varied diet genuinely has more health and magic shield
     * than the same character that has not, and no amount of gear inspection reveals it.
     */
    attributes?: Record<string, number>;
    /**
     * Swings per second the **weapon alone** allows, before Mine and Slash multiplies it.
     *
     * `minecraft:generic.attack_speed` in {@link attributes} is the finished number, and it is
     * finished in a way that makes it useless on its own to a planner. MnS's `attack_speed` is an
     * `AttributeStat` with `MULTIPLY_BASE`, so vanilla computes
     *
     *     total = (4.0 + the item's own modifier) * (1 + attack_speed / 100)
     *
     * and a capture records the left-hand side. Reading that back froze the swing rate: gear,
     * tree and buffs could move `attack_speed` from 13% to 64% and the rate never budged, because
     * the contribution was already baked into the measurement.
     *
     * This is the half that is genuinely a property of the equipped weapon rather than of the
     * character, and it is the half the snapshot cannot supply — `mmorpg_base_gear_types` names
     * `possible_items` like `roe_weapons:axe_3` and the modifier lives in that item, not in any
     * registry. So it is recorded once and the percent is re-applied on every edit.
     *
     * Back-filled when a capture is opened, from the attribute and the sheet that produced it.
     * Editable, because changing weapon is a thing a planner does and no capture can answer it.
     */
    baseAttackSpeed?: number;
    /**
     * How many distinct foods the character has eaten — Solonion's food-diversity counter.
     *
     * This is a *planning* input, not a capture: `attributes` above is what the game actually
     * reported and always wins where both are present. It exists so someone building in the
     * app without a capture can say "I'm at 30 foods" and see what that is worth, and so the
     * cost of eating more is visible at all.
     *
     * The benefit table comes from the pack's own `config/solonion.json`, carried on the
     * snapshot as `externalConfig.foodDiversity`. Benefits are cumulative: every one whose
     * `threshold` is at or below this count applies.
     */
    foodDiversity?: number;
  };
  tree?: {
    talents?: TreeCoord[];
    ascendancy?: TreeCoord[];
    atlas?: TreeCoord[];
  };
  /**
   * Saved stages of the same character — the levelling tree, the mid-game tree, the two
   * endgame trees you cannot decide between.
   *
   * A stage is **not** a second character. It is the part of a build that is spent rather than
   * worn: the three trees, the core-stat points, the spell-school allocation, and the level all
   * four of those were planned at. Gear, jewels, skills, auras and config are the character's
   * and are shared by every stage, which is what makes switching between two endgame trees a
   * comparison of the trees rather than of two unrelated documents.
   *
   * ## The live document is always one of them
   *
   * `tree`, `character.level`, `character.statPoints` and `character.schools` stay exactly what
   * they have always been: the character as it stands, and the only thing the engine, the
   * validator and the companion mod's dump ever read. {@link BuildDoc.activeStage} names the
   * entry in this list that those fields are currently showing, and the app writes them back
   * into it on every edit. So a document with stages has the active one stored twice, and where
   * the two ever disagree — a hand edit, a capture written over an older file — **the live
   * fields win**, because they are what every other reader of this format already believes.
   *
   * Absent entirely until someone asks for a second stage. A document with no `stages` is a
   * character with one unnamed stage, which is what every build authored before this field
   * existed is, and it must keep meaning exactly that.
   */
  stages?: BuildStage[];
  /**
   * Which stage the live fields are showing — a {@link BuildStage.id}.
   *
   * Ignored where it names nothing, rather than being an error: a document that lost its stage
   * list to a hand edit is still a perfectly good character.
   */
  activeStage?: string;
  /**
   * What the character is **wearing**.
   *
   * This is the equipped loadout and nothing else: every stat the engine collects, every slot
   * the validator counts against `SLOT_CAPACITY`, and every fixture ever captured reads this
   * list and only this list. {@link BuildDoc.itemPool} is the bench beside it and contributes
   * nothing, which is the whole distinction between the two.
   */
  gear?: Item[];
  /**
   * Items the build owns but is not wearing.
   *
   * A planner is mostly used to ask "which of these two swords", and until now the only way to
   * hold the loser was to keep it equipped in a second document. This is the bench: items you
   * have crafted, imported or are still deciding about, saved with the build and exported with
   * it.
   *
   * **It contributes nothing.** No stat, no set bonus, no slot occupancy, no requirement check
   * against the character. The engine does not read it at all — `collectGear` walks `gear` —
   * which is deliberate and is what keeps every existing capture, fixture and stat comparison
   * meaning exactly what it meant before this field existed.
   *
   * The Items tab shows the two lists as **one pool** with the worn ones marked, because that is
   * how a player thinks about what they own. Equipping moves an item from here into `gear` and
   * unequipping moves it back, so nothing is ever lost by trying something on; where the slot is
   * already full, the item that comes off lands here rather than being deleted.
   */
  itemPool?: Item[];
  /**
   * The single omen. `CharacterEquipment.CURIO_BLOCKS` gives `OMEN` a count of 1, so this is
   * one entry rather than a list.
   */
  omen?: OmenSetup;
  jewels?: Jewel[];
  skills?: SkillSetup[];
  auras?: AuraSetup[];
  exileEffects?: ExileEffectSetup[];
  /**
   * Meals, seafood and elixirs — `PlayerBuffData.map`, one entry per slot.
   *
   * Temporary, and deliberately in the document anyway. A character that has eaten genuinely
   * has the stats, `more_food_stats` exists to scale exactly this context, and a capture taken
   * after lunch read 6% low on health with nothing in the document to explain it.
   */
  foodBuffs?: FoodBuffSetup[];
  config?: BuildConfig;
};

/** Which of the three buff slots a food occupies. `PlayerBuffData.Type`, lowercased. */
export const FOOD_BUFF_SLOTS = ["meal", "fish", "potion"] as const;

export type FoodBuffSlot = (typeof FOOD_BUFF_SLOTS)[number];

/**
 * One eaten food or drunk elixir.
 *
 * `StatBuff.getStats` is the whole of it, and its arithmetic is unusual enough to spell out:
 *
 *     return mods.stream().map(x -> x.ToExactStat((int) (perc + lvl), lvl)).collect(...);
 *
 * The roll percent handed to `ToExactStat` is `perc + lvl` — the crafted roll **plus the food's
 * level**. A level 100 meal therefore rolls at 100 percentage points past whatever the crafting
 * gave it, which is why the `life` buff's 5..10% health band pays out 14.65% rather than
 * anything inside the band. `lvl` is also what its flats scale to, so the two arguments are not
 * interchangeable even though they are added together.
 */
export type FoodBuffSetup = {
  /** `mmorpg_stat_buff` id — `life`, `str`, `crit`, ... */
  id: string;
  /** Which slot it fills. Only one food can hold a slot, so this is what a second one replaces. */
  slot?: FoodBuffSlot;
  /**
   * The food's own level, not the character's. `PlayerBuffData.tryAdd` refuses a food above the
   * eater's level, so it is bounded by it but usually below.
   */
  level?: number;
  /** The crafted roll, 0-100, *before* the level is added to it. */
  rollPercent?: number;
  /** Foods default to on, so that unticking one shows what it is worth. */
  enabled?: boolean;
};

/** Food buffs default to on. Always read `enabled` through this. */
export function isFoodBuffEnabled(buff: FoodBuffSetup): boolean {
  return buff.enabled ?? true;
}

/**
 * How much of an exile effect is up: off, on at the cap, or a pinned number of stacks.
 *
 * `true` and an omitted entry both mean the cap, because `ExileEffect.getMaxCharges` is a
 * derived number — `max_stacks` plus whatever `max_<id>_charges` the build carries — and a
 * planner that reported one endurance charge for a build that generates three would be wrong in
 * a way no default can be right.
 */
export type EffectSetup = boolean | number;

/** Auras default to on. Always read `enabled` through this. */
export function isAuraEnabled(aura: AuraSetup): boolean {
  return aura.enabled ?? true;
}

/**
 * `GemInventoryHelper.MAX_SKILL_GEMS` — how many Skills a character can have active at once.
 *
 *     public static int MAX_SKILL_GEMS = 8;
 *     public static int SUPPORT_GEMS_PER_SKILL = 5;
 *     public static int TOTAL_SLOTS = MAX_SKILL_GEMS * (1 + SUPPORT_GEMS_PER_SKILL);
 *
 * It is the size of the skill-gem inventory, and `getHotbarGem(i)` indexes straight into it, so
 * it is also the length of the hotbar. A ninth Skill is not a weaker Skill — there is nowhere
 * to put it.
 *
 * A document may still *hold* more than eight, the same way it holds a disabled Skill: keeping
 * the setup you are comparing against is the point of `enabled`. What it may not do is have
 * more than eight of them on at once.
 */
export const MAX_ACTIVE_SKILLS = 8;

/** Skills default to on. Always read `enabled` through this. */
export function isSkillEnabled(skill: SkillSetup): boolean {
  return skill.enabled ?? true;
}

/** How many of a bar's Skills are on — what {@link MAX_ACTIVE_SKILLS} bounds. */
export function activeSkillCount(skills: readonly SkillSetup[] | undefined): number {
  return (skills ?? []).filter(isSkillEnabled).length;
}

/**
 * A skill's support gems as `{ id, rollPercent }`, whichever way the document spells them.
 *
 * Always read `supports` through this. A bare string entry has no roll of its own and falls
 * back to the Skill's `gemPercent`, which is what the engine did for every support gem before
 * the per-gem roll existed; `undefined` still means "nothing recorded", so the collector can
 * tell that apart from a real 0% and warn.
 */
export function supportLinks(skill: SkillSetup): SupportLink[] {
  return (skill.supports ?? []).map((link) => {
    const id = typeof link === "string" ? link : link.id;
    const roll = typeof link === "string" ? skill.gemPercent : link.rollPercent ?? skill.gemPercent;
    const rarity = typeof link === "string" ? undefined : link.rarity;
    const enabled = typeof link === "string" ? undefined : link.enabled;
    // Keys are omitted rather than set to `undefined`, so the result is a `SupportLink` that can
    // be written straight back into the document without leaving dead fields behind.
    const out: SupportLink = { id };
    if (roll !== undefined) out.rollPercent = roll;
    if (rarity !== undefined) out.rarity = rarity;
    if (enabled !== undefined) out.enabled = enabled;
    return out;
  });
}

/** Support links default to on. Always read `enabled` through this. */
export function isSupportEnabled(link: SupportLink): boolean {
  return link.enabled ?? true;
}

/**
 * The links that actually reach the spell — {@link supportLinks} with the switched-off ones
 * dropped.
 *
 * Every consumer that asks "what is socketed here" wants this one, and every consumer that
 * *renders* the sockets wants `supportLinks`. Keeping them as two functions is what stops a
 * disabled gem from being drawn as absent or summed as present.
 */
export function activeSupportLinks(skill: SkillSetup): SupportLink[] {
  return supportLinks(skill).filter(isSupportEnabled);
}

/** An empty document at the current version — the starting point for hand-authoring. */
export function emptyBuild(level = 1): BuildDoc {
  return { schemaVersion: BUILD_DOC_VERSION, character: { level } };
}

/** The tree keys of a `BuildDoc`, paired with the registry id each one allocates into. */
export const TREE_KEYS = {
  talents: "talents",
  ascendancy: "ascendancy",
  atlas: "atlas_passives",
} as const;

export type TreeKey = keyof typeof TREE_KEYS;
