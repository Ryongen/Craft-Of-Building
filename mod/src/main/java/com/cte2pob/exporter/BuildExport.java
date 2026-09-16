package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.robertx22.mine_and_slash.capability.entity.EntityData;
import com.robertx22.mine_and_slash.capability.player.PlayerData;
import com.robertx22.mine_and_slash.capability.player.helper.GemInventoryHelper;
import com.robertx22.mine_and_slash.capability.player.helper.SocketedGem;
import com.robertx22.mine_and_slash.capability.player.data.PlayerBuffData;
import com.robertx22.mine_and_slash.database.data.profession.buffs.StatBuff;
import com.robertx22.mine_and_slash.database.registry.ExileDB;
import com.robertx22.mine_and_slash.saveclasses.ExactStatData;
import com.robertx22.mine_and_slash.database.data.game_balance_config.PlayerPointsType;
import com.robertx22.mine_and_slash.database.data.omen.OmenData;
import com.robertx22.mine_and_slash.database.data.perks.Perk;
import com.robertx22.mine_and_slash.database.data.talent_tree.TalentTree;
import com.robertx22.mine_and_slash.saveclasses.PointData;
import com.robertx22.mine_and_slash.saveclasses.gearitem.gear_parts.AffixData;
import com.robertx22.mine_and_slash.saveclasses.item_classes.GearItemData;
import com.robertx22.mine_and_slash.saveclasses.jewel.JewelItemData;
import com.robertx22.mine_and_slash.saveclasses.skill_gem.SkillGemData;
import com.robertx22.mine_and_slash.uncommon.datasaving.StackSaving;
import com.robertx22.mine_and_slash.vanilla_mc.potion_effects.EntityStatusEffectsData;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraft.world.item.ItemStack;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The character, as a {@code BuildDoc}.
 *
 * <p>Everything here comes out of the two capabilities the server syncs to its owning player:
 * {@code PlayerData} (talents, stat points, spell schools, the gem, aura and jewel inventories)
 * and {@code EntityData} (level). Nothing is asked of the server and nothing is recomputed.
 *
 * <p>Where the game holds something the build document has no shape for, this records a warning
 * rather than an approximation. Those warnings are the useful output when a fixture disagrees
 * with the engine: they say up front which part of the character the document could not carry.
 */
public final class BuildExport {

    private BuildExport() {
    }

    public static JsonObject build(LocalPlayer player, Warnings warn, String packVersion, String mnsVersion) {
        PlayerData pd = PlayerData.get(player);
        EntityData en = EntityData.get(player);

        JsonObject build = new JsonObject();
        build.addProperty("schemaVersion", 1);

        JsonObject meta = new JsonObject();
        meta.addProperty("name", player.getGameProfile().getName());
        meta.addProperty("createdAt", Exporter.today());
        meta.addProperty("mineAndSlashVersion", mnsVersion);
        meta.addProperty("packVersion", packVersion);
        meta.addProperty("notes", "Exported from the game by cte2pob-exporter " + Cte2PobExporter.VERSION + ".");
        build.add("meta", meta);

        build.add("character", character(player, pd, en, warn));

        JsonObject tree = trees(pd, warn);
        if (tree.size() > 0) {
            build.add("tree", tree);
        }

        gear(player, build, warn);
        omen(pd, build, warn);
        jewels(pd, build, warn);
        skills(pd, build, warn);
        auras(pd, build, warn);
        foodBuffs(pd, en, build, warn);
        exileEffects(en, build, warn);

        return build;
    }

    /**
     * The player's vanilla attribute totals.
     *
     * `mmorpg_stat_compat` converts these into real Mine and Slash stats, reading
     * `en.getAttributeValue(at)` - the **total**, base included. In this pack that is how
     * Solonion's food-diversity benefits, Mine and Meals and the KubeJS attributes reach the
     * character sheet, and none of it is visible in gear or talents. Without these the engine
     * reads health, magic shield, dodge and armour low with nothing to explain it.
     *
     * <p>Every registered attribute the player has is written, including ones still at their
     * default value. An earlier version skipped those as noise and was wrong to: `getResult`
     * reads the **total**, not the bonus, so an attribute sitting at its default still converts
     * to a real number. `kubejs:weapon_damage` at its default of 1.0 is exactly the +1% the
     * level 1 capture shows, and skipping it made that look like an engine bug.
     */
    private static void attributes(LocalPlayer player, JsonObject character, Warnings warn) {
        JsonObject out = new JsonObject();
        for (Attribute attribute : ForgeRegistries.ATTRIBUTES) {
            AttributeInstance instance = player.getAttribute(attribute);
            if (instance == null) {
                continue;
            }
            ResourceLocation key = ForgeRegistries.ATTRIBUTES.getKey(attribute);
            if (key != null) {
                out.addProperty(key.toString(), instance.getValue());
            }
        }
        if (out.size() > 0) {
            character.add("attributes", out);
            warn.add(out.size() + " vanilla attribute(s) recorded under character.attributes. "
                    + "mmorpg_stat_compat turns these into real stats, so food diversity and similar "
                    + "mods are part of the numbers below.");
        }
    }

    private static JsonObject character(LocalPlayer player, PlayerData pd, EntityData en, Warnings warn) {
        JsonObject character = new JsonObject();
        character.addProperty("level", en.getLevel());
        attributes(player, character, warn);

        if (pd.statPoints != null && pd.statPoints.map != null && !pd.statPoints.map.isEmpty()) {
            JsonObject points = new JsonObject();
            pd.statPoints.map.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .forEach(e -> {
                        if (e.getValue() != null && e.getValue() != 0) {
                            points.addProperty(e.getKey(), e.getValue());
                        }
                    });
            if (points.size() > 0) {
                character.add("statPoints", points);
            }
        }

        if (pd.ascClass != null) {
            List<String> schools = pd.ascClass.allocatedSchoolsInOrder();
            if (schools != null && !schools.isEmpty()) {
                // `school` is the first class in allocation order, which is the one the game's
                // own screen opens on. It is provenance rather than input: what the engine
                // reads is `schools` below.
                character.addProperty("school", schools.get(0));
            }

            // SpellSchoolsData.allocated_lvls, verbatim: perk id -> level. This is the whole of
            // a character's class allocation, and because a spell perk's stat is
            // `learn_<spell>`, it is also every spell's rank.
            if (pd.ascClass.allocated_lvls != null && !pd.ascClass.allocated_lvls.isEmpty()) {
                JsonObject allocated = new JsonObject();
                pd.ascClass.allocated_lvls.entrySet().stream()
                        .sorted(Map.Entry.comparingByKey())
                        .forEach(e -> {
                            if (e.getValue() != null && e.getValue() > 0) {
                                allocated.addProperty(e.getKey(), e.getValue());
                            }
                        });
                if (allocated.size() > 0) {
                    character.add("schools", allocated);
                }
            }
        }

        pointTotals(player, character, warn);
        character.addProperty("omensFilled", pd.omensFilled);

        return character;
    }

    /**
     * The game's own point totals per pool.
     *
     * `getFreePoints` is total minus spent, and `getPointsInUse` is spent, so the sum is the
     * total - including `getBonusPoints`, the quest and item rewards that no build document can
     * derive from a level. Recording it is what lets the validator check a spend exactly rather
     * than warning that it *might* be legitimate.
     */
    private static void pointTotals(LocalPlayer player, JsonObject character, Warnings warn) {
        JsonObject totals = new JsonObject();
        for (PlayerPointsType type : PlayerPointsType.values()) {
            try {
                int free = type.getFreePoints(player);
                int inUse = type.getPointsInUse(player);
                totals.addProperty(type.name(), free + inUse);
            } catch (Exception e) {
                warn.add("Point total for " + type.name() + " could not be read (" + e + ").");
            }
        }
        if (totals.size() > 0) {
            character.add("pointTotals", totals);
        }
    }

    /**
     * The three trees. All of them live in {@code TalentsData}, keyed by {@code SchoolType} -
     * the atlas passives included, which is a different thing from {@code PlayerData.atlas}
     * (the map atlas, whose nodes are dungeon-realm ids and not tree coordinates).
     *
     * <p>{@code PointData} is {@code (x, y)} where {@code x} is the index within a line and
     * {@code y} the line number: {@code TalentGrid} increments {@code x} per comma and
     * {@code y} per newline. The build document's {@code TreeCoord} is {@code [row, col]}, so
     * the pair is written the other way round.
     */
    private static JsonObject trees(PlayerData pd, Warnings warn) {
        JsonObject tree = new JsonObject();
        if (pd.talents == null) {
            return tree;
        }
        addTree(tree, "talents", pd.talents.getAllAllocatedPerks(TalentTree.SchoolType.TALENTS));
        addTree(tree, "ascendancy", pd.talents.getAllAllocatedPerks(TalentTree.SchoolType.ASCENDANCY));
        addTree(tree, "atlas", pd.talents.getAllAllocatedPerks(TalentTree.SchoolType.ATLAS));

        if (pd.atlas != null && pd.atlas.unlockedNodes != null && !pd.atlas.unlockedNodes.isEmpty()) {
            warn.add("Your map atlas has " + pd.atlas.unlockedNodes.size() + " unlocked node(s). Those are "
                    + "AtlasData node ids, not talent tree coordinates, and the build document has no field "
                    + "for them. `tree.atlas` above is the atlas_passives tree, which is a different thing.");
        }
        return tree;
    }

    private static void addTree(JsonObject tree, String key, Map<PointData, Perk> allocated) {
        if (allocated == null || allocated.isEmpty()) {
            return;
        }
        List<PointData> points = new ArrayList<>(allocated.keySet());
        points.sort(Comparator.<PointData>comparingInt(p -> p.y).thenComparingInt(p -> p.x));

        JsonArray coords = new JsonArray();
        for (PointData point : points) {
            JsonArray pair = new JsonArray();
            pair.add(point.y);
            pair.add(point.x);
            coords.add(pair);
        }
        tree.add(key, coords);
    }

    private static void gear(LocalPlayer player, JsonObject build, Warnings warn) {
        JsonArray gear = new JsonArray();

        for (Equipment.Slot slot : Equipment.equipped(player, warn)) {
            ItemStack stack = slot.stack();
            if (stack.isEmpty()) {
                continue;
            }
            GearItemData data;
            try {
                if (!StackSaving.GEARS.has(stack)) {
                    continue;
                }
                data = StackSaving.GEARS.loadFrom(stack);
            } catch (Exception e) {
                warn.add(slot.label() + ": holds an item whose mmorpg_gear data could not be read (" + e + ").");
                continue;
            }
            if (data == null) {
                continue;
            }
            gear.add(GearExport.item(stack, data, warn, slot.label()));
        }

        if (gear.size() > 0) {
            build.add("gear", gear);
        }
    }

    private static void omen(PlayerData pd, JsonObject build, Warnings warn) {
        OmenData omen;
        try {
            omen = pd.getOmen();
        } catch (Exception e) {
            return;
        }
        if (omen == null || omen.id == null || omen.id.isEmpty()) {
            return;
        }

        JsonObject out = new JsonObject();
        out.addProperty("id", omen.id);
        out.addProperty("itemLevel", omen.lvl);
        out.addProperty("rarity", omen.rar);

        if (omen.rarities != null && !omen.rarities.isEmpty()) {
            JsonObject requires = new JsonObject();
            omen.rarities.forEach((type, count) -> requires.addProperty(type.name(), count));
            out.add("requires", requires);
        }

        if (omen.slot_req != null && !omen.slot_req.isEmpty()) {
            JsonArray reqs = new JsonArray();
            for (OmenData.OmenSlotReq req : omen.slot_req) {
                JsonObject entry = new JsonObject();
                entry.addProperty("slot", req.slot);
                entry.addProperty("rarityType", req.rtype.name());
                reqs.add(entry);
            }
            out.add("slotRequirements", reqs);
        }

        JsonArray affixes = affixArray(omen.aff);
        if (affixes.size() > 0) {
            out.add("affixes", affixes);
        }

        build.add("omen", out);
    }

    private static void jewels(PlayerData pd, JsonObject build, Warnings warn) {
        if (pd.jewelData == null) {
            return;
        }
        List<JewelItemData> all;
        try {
            all = pd.jewelData.getAllJewels();
        } catch (Exception e) {
            warn.add("Jewels could not be read: " + e);
            return;
        }
        if (all == null || all.isEmpty()) {
            return;
        }

        JsonArray jewels = new JsonArray();
        int i = 0;
        for (JewelItemData jewel : all) {
            if (jewel == null) {
                continue;
            }
            JsonObject out = new JsonObject();
            out.addProperty("rarity", jewel.rar);
            out.addProperty("itemLevel", jewel.lvl);

            JsonArray affixes = affixArray(jewel.affixes);
            if (affixes.size() > 0) {
                out.add("affixes", affixes);
            }
            JsonArray corruptions = affixArray(jewel.cor);
            if (corruptions.size() > 0) {
                out.add("corruptions", corruptions);
            }

            if (jewel.uniq != null && jewel.uniq.id != null && !jewel.uniq.id.isEmpty()) {
                JsonObject unique = new JsonObject();
                unique.addProperty("id", jewel.uniq.id);
                unique.addProperty("rollPercent", jewel.uniq.perc);
                try {
                    unique.addProperty("tier", jewel.uniq.getCraftedTier().ordinal());
                } catch (Exception ignored) {
                    // The tier only decides how many of the unique's stats it carries; without it
                    // the id and roll are still the two numbers that matter.
                }
                out.add("unique", unique);
            }

            if (jewel.auraStats != null && !jewel.auraStats.isEmpty()) {
                JsonArray auraStats = new JsonArray();
                for (var stat : jewel.auraStats) {
                    if (stat == null || stat.affix == null || stat.affix.isEmpty()) {
                        continue;
                    }
                    JsonObject entry = new JsonObject();
                    entry.addProperty("affixId", stat.affix);
                    entry.addProperty("rollPercent", stat.perc);
                    entry.addProperty("itemLevel", stat.lvl);
                    auraStats.add(entry);
                }
                if (auraStats.size() > 0) {
                    out.add("auraStats", auraStats);
                    warn.add("jewel[" + i + "]: carries " + auraStats.size() + " aura-conditional stat(s), "
                            + "each live only while the aura named by its affix `eye_aura_req` is "
                            + "socketed. Unsocket that aura and these stop counting.");
                }
            }
            // Which tree socket a jewel sits in is not recorded by the game's jewel inventory,
            // so `socket` is left out rather than guessed. The engine does not need it.

            jewels.add(out);
            i++;
        }

        if (jewels.size() > 0) {
            build.add("jewels", jewels);
        }
    }

    private static void skills(PlayerData pd, JsonObject build, Warnings warn) {
        GemInventoryHelper gems;
        try {
            gems = pd.getSkillGemInventory();
        } catch (Exception e) {
            warn.add("The Skill inventory could not be read: " + e);
            return;
        }
        if (gems == null) {
            return;
        }

        JsonArray skills = new JsonArray();
        for (int i = 0; i < GemInventoryHelper.MAX_SKILL_GEMS; i++) {
            SocketedGem socketed;
            SkillGemData data;
            try {
                socketed = gems.getHotbarGem(i);
                data = socketed == null ? null : socketed.getSkillData();
            } catch (Exception e) {
                continue;
            }
            if (data == null || data.id == null || data.id.isEmpty()) {
                continue;
            }

            JsonObject skill = new JsonObject();
            skill.addProperty("spellId", data.id);
            // `InsertedSpell.rank` is the game's own answer: `calcSpellLevels` sets it from the
            // `learn_<spell>` stat and then adds the bonus ranks from `MaxSpellLevel` /
            // `MaxAllSpellLevels`, clamped to MAX_BONUS_SPELL_LEVELS. The gem's own level is the
            // fallback for a spell the caster does not hold a rank for.
            int rank = socketed.spell == null ? 0 : socketed.spell.rank;
            skill.addProperty("level", rank > 0 ? rank : data.getLevel());
            // The Skill item's own roll. It buys nothing in game - `Spell.getStats` derives its
            // percent from the rank, `(getLevelOf(p) / getMaxLevelWithBonuses()) * 100`, and
            // never looks at the item - but it is recorded because it is what the item says,
            // and it is the only roll a document can offer a support gem with none of its own.
            skill.addProperty("gemPercent", data.getStatPercent());

            try {
                List<SkillGemData> supports = socketed.getSupportDatas();
                if (supports != null && !supports.isEmpty()) {
                    JsonArray links = new JsonArray();
                    for (SkillGemData support : supports) {
                        if (support != null && support.id != null && !support.id.isEmpty()) {
                            // Every support gem is its own item with its own roll:
                            // `SupportGem.GetAllStats(en, data)` reads `data.getStatPercent()`
                            // off *this* gem, not off the Skill it is linked into. Writing bare
                            // ids left the engine rolling all of them at the Skill's own
                            // percent, a number with nothing to do with any of them.
                            JsonObject link = new JsonObject();
                            link.addProperty("id", support.id);
                            link.addProperty("rollPercent", support.getStatPercent());
                            // The rarity grants nothing by itself, but it is the band the roll
                            // above was drawn from (`data.perc = rar.stat_percents.random()`),
                            // so without it a document cannot say whether its own roll is one
                            // the game could have produced - and the app cannot show the gem
                            // as the colour the player knows it by.
                            link.addProperty("rarity", support.getRarityId());
                            links.add(link);
                        }
                    }
                    if (links.size() > 0) {
                        skill.add("supports", links);
                    }
                }
            } catch (Exception e) {
                warn.add("skill `" + data.id + "`: its support gems could not be read (" + e + ").");
            }

            skills.add(skill);
        }

        if (skills.size() > 0) {
            build.add("skills", skills);
            // `main` decides which skill DPS is reported for. That is a choice about what you
            // want to look at, not a fact about the character, so the export does not make it.
            warn.add("No skill is marked `main`, so the engine reports damage for the first one. Set "
                    + "`main: true` on the skill you care about.");
        }
    }

    /**
     * Auras, read from the gem inventory rather than from {@code PlayerData.aurasOn}.
     *
     * <p>`aurasOn` looked like the obvious source and is a trap: it is rebuilt server-side
     * inside {@code CachedPlayerStats.recalcAllocated}, so on the client it is simply empty and
     * an exporter reading it silently records no auras at all. A single aura can be a third of
     * a character's dodge, so that is not a small omission.
     *
     * <p>The real source is the same one the game's own stat calculation uses:
     *
     *     for (ItemStack stack : getAuras()) {
     *         SkillGemData data = StackSaving.SKILL_GEM.loadFrom(stack);
     *         if (data != null) {
     *             AuraGem aura = data.getAura();
     *             ctx.add(new SimpleStatCtx(StatContext.StatCtxType.AURA, aura.GetAllStats(Load.Unit(en), data)));
     *         }
     *     }
     *
     * — GemInventoryHelper.getAuraStats:214-222. Every socketed aura gem applies; there is no
     * on/off gate, so `enabled` is always true here. `getStatPercent()` is the gem's own roll,
     * which every stat on the aura is interpolated at.
     */
    private static void auras(PlayerData pd, JsonObject build, Warnings warn) {
        List<SkillGemData> gems;
        try {
            gems = pd.getSkillGemInventory().getAurasGems();
        } catch (Exception e) {
            warn.add("Could not read the aura gem inventory, so no auras are recorded. Any aura you "
                    + "have running is missing from the numbers below.");
            return;
        }
        if (gems == null || gems.isEmpty()) {
            return;
        }

        JsonArray auras = new JsonArray();
        for (SkillGemData gem : gems) {
            if (gem == null || gem.id == null || gem.id.isEmpty()) {
                continue;
            }
            JsonObject aura = new JsonObject();
            aura.addProperty("id", gem.id);
            aura.addProperty("enabled", true);
            aura.addProperty("rollPercent", gem.getStatPercent());
            // Same pair as a support gem: an Augment is a `SkillGemData` too, and its rarity is
            // the band its roll came from.
            aura.addProperty("rarity", gem.getRarityId());
            auras.add(aura);
        }
        if (auras.size() > 0) {
            build.add("auras", auras);
        }
    }

    /**
     * Buffs, potions and shrine effects that are running right now.
     *
     * These are real contributions to the sheet the capture records, so leaving them out made
     * every stat they touch read low with nothing to explain it. They live on the unit rather
     * than on PlayerData:
     *
     *     public ConcurrentHashMap<String, ExileEffectInstanceData> exileMap = ...;
     *
     * — EntityStatusEffectsData, keyed by the effect's GUID with the stack count on the value,
     * which is exactly the build document's {@code ExileEffectSetup}.
     *
     * <p>Note what this does <em>not</em> cover: vanilla attribute and enchantment bonuses that
     * reach the sheet through {@code mmorpg_stat_compat} - Mine and Meals food, KubeJS
     * attributes and the like. Those are not exile effects and the engine does not model them,
     * so a capture taken while well fed still reads high against it.
     */
    private static void exileEffects(EntityData en, JsonObject build, Warnings warn) {
        var data = en.getStatusEffectsData();
        if (data == null || data.exileMap == null) {
            return;
        }
        // Before the list of what *is* up: the list of what is not. Runs even when nothing is
        // running, which is the case it matters most in.
        selfBuffsNotRunning(build, data, warn);
        if (data.exileMap.isEmpty()) {
            return;
        }
        JsonArray effects = new JsonArray();
        for (var entry : data.exileMap.entrySet()) {
            String id = entry.getKey();
            if (id == null || id.isEmpty()) {
                continue;
            }
            var inst = entry.getValue();
            JsonObject effect = new JsonObject();
            effect.addProperty("id", id);
            int stacks = inst == null ? 0 : inst.stacks;
            if (stacks > 0) {
                effect.addProperty("stacks", stacks);
            }
            // Both of these decide how strong the buff actually is, and neither is derivable
            // from the effect id. `spell_id` names the spell whose rank the effect's stats are
            // interpolated over (ExileEffect.getExactStats), and `str_multi` multiplies every
            // one of them afterwards. Without the first, an engine has to roll the minimum.
            if (inst != null) {
                if (inst.spell_id != null && !inst.spell_id.isEmpty()) {
                    effect.addProperty("spellId", inst.spell_id);
                }
                effect.addProperty("strMulti", inst.str_multi);
            }
            effects.add(effect);
        }
        if (effects.size() > 0) {
            build.add("exileEffects", effects);
            warn.add(effects.size() + " exile effect(s) were running when this was captured, and they "
                    + "are part of the numbers below. Capture again with nothing active if you want a "
                    + "fixture that pins the bare character.");
            for (var entry : data.exileMap.entrySet()) {
                var inst = entry.getValue();
                if (inst != null && (inst.spell_id == null || inst.spell_id.isEmpty())) {
                    warn.add("exile effect `" + entry.getKey() + "` records no applying spell, so its "
                            + "stats cannot be rolled at the right percent and will read at their "
                            + "minimum. It was probably granted by a shrine or an item rather than cast.");
                }
            }
        }
    }

    /**
     * Names the self-buffs on the skill bar that are not currently running.
     *
     * <p>A capture records the effect map as it is at the instant F6 is pressed, which is the
     * right thing to record and a treacherous thing to read. A player who walked to a quiet
     * corner to export has let their auras lapse; the numbers in the capture are then the
     * character without them, while the damage they are trying to explain was dealt with them
     * up. Nothing in the file said so, and the resulting disagreement looks like an engine bug
     * in whatever stat the missing buff touched.
     *
     * <p>The test is the pack's own naming convention: for a self-buff the spell and the effect
     * it applies share an id - {@code sanguine_aura} the spell grants {@code sanguine_aura} the
     * effect - which holds for 87 of this pack's spells. That is a convention rather than a
     * rule, so this only ever warns: a spell whose effect is named differently is simply not
     * reported, and no capture is ever rejected for it.
     */
    private static void selfBuffsNotRunning(JsonObject build, EntityStatusEffectsData data, Warnings warn) {
        JsonArray skills = build.getAsJsonArray("skills");
        if (skills == null || skills.size() == 0) {
            return;
        }

        List<String> idle = new ArrayList<>();
        for (var element : skills) {
            String spellId;
            try {
                spellId = element.getAsJsonObject().get("spellId").getAsString();
            } catch (Exception e) {
                continue;
            }
            if (spellId == null || spellId.isEmpty() || data.exileMap.containsKey(spellId)) {
                continue;
            }
            try {
                if (ExileDB.ExileEffects().getAll().containsKey(spellId)) {
                    idle.add(spellId);
                }
            } catch (Throwable e) {
                return;
            }
        }
        if (idle.isEmpty()) {
            return;
        }

        warn.add(idle.size() + " skill(s) on your bar apply a buff of the same name that was NOT running "
                + "when this was captured: " + String.join(", ", idle) + ". Every stat those buffs touch "
                + "is absent from the numbers here. If you are checking this capture against damage you "
                + "dealt with them up, put them up and export again - otherwise the two describe "
                + "different characters and the difference will look like an engine bug.");
    }

    /**
     * Meals, seafood and elixirs - {@code PlayerBuffData.map}, one entry per slot.
     *
     * <p>These are a real part of the sheet and were missing from it. A character eating a
     * level 100 meal carries +14.65% health and +43.6% health regen, which showed up as the
     * engine reading 6% low on health with nothing in the document to account for it.
     *
     * <p>The awkward part is that the game does not keep the recipe, only the result:
     *
     *     List&lt;ExactStatData&gt; stats = buff.getStats(lvl, perc);
     *     Buff data = new Buff(buff.GUID(), stats, ticks);
     *
     * - {@code PlayerBuffData.tryAdd}. {@code lvl} and {@code perc} are spent and dropped. So
     * this searches for them: {@code StatBuff.getStats} is cheap and total, and its output is
     * unique enough that replaying it over every legal pair recovers the two numbers the
     * document needs to be able to re-roll the food rather than just quote it. The search is
     * bounded by {@code tryAdd}'s own rule that a food above the eater's level cannot be eaten.
     *
     * <p>Where several pairs produce identical stats - which happens when a buff is all
     * PERCENT mods, since those do not scale to level - the highest level is taken. Any of them
     * reproduces the sheet exactly; the highest is the likeliest food to be holding a slot at
     * the character's level.
     */
    private static void foodBuffs(PlayerData pd, EntityData en, JsonObject build, Warnings warn) {
        PlayerBuffData buffs;
        try {
            buffs = pd.buff;
        } catch (Exception e) {
            warn.add("Food buffs could not be read: " + e);
            return;
        }
        if (buffs == null || buffs.map == null || buffs.map.isEmpty()) {
            return;
        }

        int playerLevel;
        try {
            playerLevel = en.getLevel();
        } catch (Exception e) {
            playerLevel = 1;
        }

        JsonArray out = new JsonArray();
        for (Map.Entry<PlayerBuffData.Type, PlayerBuffData.Buff> entry : buffs.map.entrySet()) {
            PlayerBuffData.Buff buff = entry.getValue();
            if (buff == null || buff.id == null || buff.id.isEmpty()) {
                continue;
            }
            JsonObject json = new JsonObject();
            json.addProperty("id", buff.id);
            // Not `Type.GUID()`: that is the display name lowercased ("elixir", "seafood"),
            // which drifts with translation. The enum constant is the stable key.
            json.addProperty("slot", entry.getKey().name().toLowerCase(Locale.ROOT));
            json.addProperty("enabled", true);

            int[] roll = solveBuffRoll(buff, playerLevel);
            if (roll == null) {
                warn.add("food buff `" + buff.id + "`: its level and roll could not be recovered from the "
                        + "stats the game stored, so the document records neither and the engine will "
                        + "compute it at its weakest. Its stats are part of the observed numbers below.");
            } else {
                json.addProperty("level", roll[0]);
                json.addProperty("rollPercent", roll[1]);
            }
            out.add(json);
        }

        if (out.size() > 0) {
            build.add("foodBuffs", out);
            warn.add(out.size() + " food buff(s) were running when this was captured and are part of the "
                    + "numbers below. They expire - a meal lasts an hour - so a fixture kept for long "
                    + "enough to matter is pinning a character that no longer exists.");
        }
    }

    /**
     * Recovers {@code {lvl, perc}} by replaying {@code StatBuff.getStats} over every pair the
     * game would have accepted. Returns null if nothing reproduces the stored stats.
     */
    private static int[] solveBuffRoll(PlayerBuffData.Buff buff, int playerLevel) {
        StatBuff def;
        try {
            def = ExileDB.StatBuffs().get(buff.id);
        } catch (Exception e) {
            return null;
        }
        if (def == null || buff.stats == null || buff.stats.isEmpty()) {
            return null;
        }
        for (int lvl = Math.max(playerLevel, 1); lvl >= 1; lvl--) {
            for (int perc = 0; perc <= 100; perc++) {
                if (sameStats(def.getStats(lvl, perc), buff.stats)) {
                    return new int[] { lvl, perc };
                }
            }
        }
        return null;
    }

    private static boolean sameStats(List<ExactStatData> a, List<ExactStatData> b) {
        if (a == null || b == null || a.size() != b.size()) {
            return false;
        }
        for (int i = 0; i < a.size(); i++) {
            ExactStatData x = a.get(i);
            ExactStatData y = b.get(i);
            if (!x.getStatId().equals(y.getStatId()) || x.getType() != y.getType()) {
                return false;
            }
            // Both sides came out of the same float arithmetic, so this is an equality check
            // with room for the last bit rather than a tolerance.
            if (Math.abs(x.getValue() - y.getValue()) > 1e-4f) {
                return false;
            }
        }
        return true;
    }

    private static JsonArray affixArray(List<AffixData> affixes) {
        JsonArray array = new JsonArray();
        if (affixes == null) {
            return array;
        }
        for (AffixData affix : affixes) {
            if (affix == null || affix.isEmpty()) {
                continue;
            }
            JsonObject roll = new JsonObject();
            roll.addProperty("affixId", affix.id);
            roll.addProperty("tier", affix.rar);
            roll.addProperty("rollPercent", affix.p);
            array.add(roll);
        }
        return array;
    }
}
