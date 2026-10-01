package com.cte2pob.exporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.robertx22.mine_and_slash.database.data.StatMod;
import com.robertx22.mine_and_slash.database.data.unique_items.UniqueGear;
import com.robertx22.mine_and_slash.itemstack.ExileStack;
import com.robertx22.mine_and_slash.saveclasses.gearitem.gear_parts.AffixData;
import com.robertx22.mine_and_slash.saveclasses.gearitem.gear_parts.SocketData;
import com.robertx22.mine_and_slash.saveclasses.item_classes.GearItemData;
import net.minecraft.world.item.ItemStack;
import net.minecraftforge.registries.ForgeRegistries;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One equipped item, expressed the way {@code BuildDoc.Item} wants it: a base, a rarity, a
 * level and per-affix {@code {id, tier, rollPercent}} - never a bag of finished stats.
 *
 * <p>That is possible because it is also how the game stores it. {@code AffixData} is
 * {@code {p, id, rar, ty}} and this writes those four fields across, so nothing here is
 * inferred from a rendered tooltip and no roll has to be solved back out of a displayed value.
 * The roll percent in particular is a number no player can read anywhere in game.
 */
public final class GearExport {

    private GearExport() {
    }

    public static JsonObject item(ItemStack stack, GearItemData gear, Warnings warn, String where) {
        JsonObject item = new JsonObject();
        ExileStack ex = ExileStack.of(stack);

        item.addProperty("base", gear.gtype);
        item.addProperty("rarity", gear.rar);
        item.addProperty("itemLevel", gear.lvl);

        baseRolls(item, ex, gear, warn, where);

        if (gear.imp != null && gear.imp.has()) {
            JsonArray implicits = new JsonArray();
            JsonObject roll = new JsonObject();
            roll.addProperty("affixId", gear.imp.imp);
            // No tier is written, because an implicit has none: ImplicitStatsData saves only
            // `p` and `imp` where AffixData also saves `rar`, and GetAllStats calls
            // ToExactStat(p, lvl) with the percent directly. The build document's AffixRoll.tier
            // is optional for exactly this case. Earlier builds put the item's own rarity here,
            // which made every implicit look like a band violation to the validator - an epic
            // necklace rolling 79% is ordinary, since ImplicitStatsData is the one gear part
            // that keeps IGearPartTooltip.getMinMax's default MinMax(0, 100).
            roll.addProperty("rollPercent", gear.imp.p);
            implicits.add(roll);
            item.add("implicits", implicits);
        }

        addAffixes(item, "prefixes", gear.affixes == null ? null : gear.affixes.pre);
        addAffixes(item, "suffixes", gear.affixes == null ? null : gear.affixes.suf);
        addAffixes(item, "corruptions", gear.affixes == null ? null : gear.affixes.cor);

        if (gear.ench != null && !gear.ench.isEmpty()) {
            JsonObject roll = new JsonObject();
            roll.addProperty("affixId", gear.ench.en);
            roll.addProperty("tier", gear.ench.rar);
            roll.addProperty("rollPercent", gear.ench.getPercent());
            item.add("enchant", roll);
        }

        unique(item, ex, gear, warn, where);
        sockets(stack, item, gear, warn, where);
        enchantments(stack, item);
        craft(stack, item, gear);

        return item;
    }

    /**
     * {@code CustomItemData.KEYS} - every key the mod names. Any other integer-valued key in the
     * map is a {@code MaxUsesKey} counter ({@code level_up}, {@code relief}, ...). The planner's
     * NBT reader ({@code craftFromExtras} in import-item.ts) applies the same rule; keep the two
     * lists in step.
     */
    private static final Set<String> NAMED_CUSTOM_KEYS = Set.of("cr", "crafted", "mr", "sl", "uq", "own", "ownn", "ql", "et");

    /**
     * The stack data crafting reads and a build doesn't - {@code BuildDoc.CraftState}. It lives in
     * two other savers on the stack ({@code mmorpg_potential}, {@code mmorpg_custom_data}), not in
     * {@code GearItemData}, which is why the item document never carried it.
     *
     * <p>The flags and counters are read from the custom data's raw map rather than through
     * {@code CustomItemData}'s typed keys so that a counter this exporter has never heard of still
     * arrives: an orb added in a later pack update keys its {@code max_uses} by a new id.
     */
    private static void craft(ItemStack stack, JsonObject item, GearItemData gear) {
        Map<String, String> custom = RawGear.customMap(stack);
        JsonObject craft = new JsonObject();
        craft.addProperty("v", 1);

        Integer potential = RawGear.potential(stack);
        if (potential != null) {
            craft.addProperty("potential", potential);
        } else {
            craft.add("potential", JsonNull.INSTANCE);
        }
        craft.addProperty("corrupted", "true".equals(custom.get("cr")));
        craft.addProperty("mirrored", "true".equals(custom.get("mr")));
        craft.addProperty("crafted", "true".equals(custom.get("crafted")));
        craft.addProperty("sockets", gear.sockets == null ? 0 : gear.sockets.getTotalSockets());
        craft.addProperty("enchantTimes", intOr(custom.get("et"), 0));

        JsonObject uses = new JsonObject();
        JsonObject raw = new JsonObject();
        for (Map.Entry<String, String> e : custom.entrySet()) {
            raw.addProperty(e.getKey(), e.getValue());
            if (NAMED_CUSTOM_KEYS.contains(e.getKey())) {
                continue;
            }
            int n = intOr(e.getValue(), 0);
            if (n > 0) {
                uses.addProperty(e.getKey(), n);
            }
        }
        craft.add("uses", uses);
        if (raw.size() > 0) {
            craft.add("custom", raw);
        }
        item.add("craft", craft);
    }

    private static int intOr(String value, int fallback) {
        if (value == null || !value.matches("-?\\d+")) {
            return fallback;
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /**
     * {@code BaseStatsData} holds a single percent for the whole item, and {@code GetAllStats}
     * applies it to every entry of the base's {@code base_stats}. The build document has one
     * roll per entry, so the same number is written once per entry - that is the same item,
     * said in the other format.
     *
     * <p>Quality is written as its own field. The game adds it to the roll
     * ({@code int p = this.p + gear.getQualityBaseStatsBonus(stack)}) and so does the engine,
     * but keeping the two apart is what stops a 40% roll on a 20-quality item from being
     * indistinguishable from a 60% roll on a plain one.
     */
    private static void baseRolls(JsonObject item, ExileStack ex, GearItemData gear, Warnings warn, String where) {
        List<StatMod> baseStats;
        try {
            baseStats = gear.GetBaseGearType().base_stats;
        } catch (Exception e) {
            warn.add(where + ": base gear type `" + gear.gtype + "` is not registered on this client, "
                    + "so its base stat rolls could not be written.");
            return;
        }
        if (baseStats == null || baseStats.isEmpty()) {
            return;
        }

        int stored = gear.baseStats == null ? 0 : gear.baseStats.p;

        JsonArray rolls = new JsonArray();
        for (int i = 0; i < baseStats.size(); i++) {
            rolls.add(stored);
        }
        item.add("baseRolls", rolls);

        // Quality is its own field rather than folded into the roll, because the game keeps them
        // apart too: `int p = this.p + gear.getQualityBaseStatsBonus(stack)`. Folding would make
        // a 40% roll on a 20-quality item indistinguishable from a 60% roll on a plain one.
        try {
            int quality = gear.getQualityBaseStatsBonus(ex);
            if (quality != 0) {
                item.addProperty("quality", quality);
            }
        } catch (Exception ignored) {
            // No custom data on the stack means no quality, which is the default anyway.
        }
    }

    private static void addAffixes(JsonObject item, String key, List<AffixData> affixes) {
        if (affixes == null || affixes.isEmpty()) {
            return;
        }
        JsonArray array = new JsonArray();
        for (AffixData affix : affixes) {
            if (affix == null || affix.isEmpty()) {
                continue;
            }
            JsonObject roll = new JsonObject();
            roll.addProperty("affixId", affix.id);
            // The affix's own rarity, which is not the item's: a mythic item can carry a
            // common-tier affix, and the roll band comes from the affix's tier.
            roll.addProperty("tier", affix.rar);
            roll.addProperty("rollPercent", affix.p);
            array.add(roll);
        }
        if (array.size() > 0) {
            item.add(key, array);
        }
    }

    private static void unique(JsonObject item, ExileStack ex, GearItemData gear, Warnings warn, String where) {
        if (gear.uniqueStats == null) {
            return;
        }
        String id = null;
        try {
            UniqueGear unique = gear.uniqueStats.getUnique(ex);
            if (unique != null) {
                id = unique.GUID();
            }
        } catch (Exception ignored) {
            // Falls through to the warning below.
        }
        if (id == null || id.isEmpty()) {
            warn.add(where + ": the item carries unique stats but its unique id could not be read "
                    + "from the stack's custom data, so `unique` is missing and the engine will "
                    + "compute none of those stats.");
            return;
        }
        item.addProperty("unique", id);

        if (gear.uniqueStats.perc != null && !gear.uniqueStats.perc.isEmpty()) {
            JsonArray rolls = new JsonArray();
            for (Integer p : gear.uniqueStats.perc) {
                rolls.add(p == null ? 0 : p);
            }
            item.add("uniqueRolls", rolls);
        }
    }

    /**
     * Vanilla enchantments on the piece.
     *
     * 27 of this pack's `mmorpg_stat_compat` entries are enchantment compat, and they sum
     * across every equipped piece with a per-item clamp before a total clamp
     * (`getEnchantCompatResult`). So the level has to be recorded per item, not totalled here.
     */
    private static void enchantments(ItemStack stack, JsonObject item) {
        var all = stack.getAllEnchantments();
        if (all.isEmpty()) {
            return;
        }
        JsonObject out = new JsonObject();
        for (var e : all.entrySet()) {
            var key = ForgeRegistries.ENCHANTMENTS.getKey(e.getKey());
            if (key != null) {
                out.addProperty(key.toString(), e.getValue());
            }
        }
        if (out.size() > 0) {
            item.add("enchantments", out);
        }
    }

    private static void sockets(ItemStack stack, JsonObject item, GearItemData gear, Warnings warn, String where) {
        if (gear.sockets == null) {
            return;
        }
        JsonArray gems = new JsonArray();
        JsonArray runes = new JsonArray();
        // `SocketData.p` - a rune rolls its stats when socketed, the same way an affix does.
        // Without it the engine computes every rune at its minimum, which on a four-rune
        // runeword item is a large silent shortfall.
        JsonArray runeRolls = new JsonArray();
        for (SocketData socket : gear.sockets.getSocketed()) {
            if (socket == null || socket.isEmpty()) {
                continue;
            }
            if (socket.isGem()) {
                gems.add(socket.g);
            } else if (socket.isRune()) {
                runes.add(socket.g);
                runeRolls.add(socket.p);
            }
        }
        if (gems.size() > 0) {
            item.add("sockets", gems);
        }
        if (runes.size() > 0) {
            item.add("runes", runes);
            item.add("runeRolls", runeRolls);
        }

        // `sl` above the rarity's `sockets.max` is the corruption's socket (ChaosStat adds it with a
        // bare `addSocket()`, past `canAddSocket`). The planner's NBT reader derives `bonusSockets`
        // by this same rule; the document path used to have no way to learn it at all.
        try {
            int bonus = gear.sockets.getTotalSockets() - gear.getRarity().sockets.max;
            if (bonus > 0) {
                item.addProperty("bonusSockets", bonus);
            }
        } catch (Exception e) {
            warn.add(where + ": its rarity `" + gear.rar + "` is not registered on this client, "
                    + "so sockets added by corruption could not be counted.");
        }

        if (gear.sockets.hasRuneWord()) {
            try {
                item.addProperty("runeword", gear.sockets.getRuneWord().GUID());
            } catch (Exception e) {
                warn.add(where + ": carries a runeword that is not registered on this client.");
            }
            // `GearSocketsData.rp` is private with no accessor, so it is read from the item's own
            // saved JSON - which is the same string the field was serialised into
            // (`LoadSave.Save` is `gson.toJson`), not a guess at what it might hold.
            Integer roll = RawGear.socketsInt(stack, "rp");
            if (roll != null) {
                item.addProperty("runewordRoll", roll);
            } else {
                warn.add(where + ": has a runeword whose roll percent could not be read from the "
                        + "item's saved JSON, so the engine will compute its stats at 0%.");
            }
        }
    }
}
