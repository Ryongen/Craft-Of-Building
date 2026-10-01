package com.cte2pob.exporter;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.robertx22.mine_and_slash.mmorpg.SlashRef;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.item.ItemStack;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reads a field out of an item's saved gear JSON.
 *
 * <p>A couple of the fields this export needs have no accessor - {@code GearSocketsData.rp}, the
 * runeword's roll, is private with no getter at all. Rather than reflect into it, this reads the
 * string the field was serialised *into*: {@code LoadSave.Save} is
 * {@code nbt.putString(loc, gson.toJson(obj))}, so the item's {@code mmorpg_gear} tag is that
 * object's own JSON, field names and all.
 *
 * <p>That makes this a reading rather than a guess, and it stays correct for as long as the
 * field keeps its name - which is the same condition every other line of this exporter is under,
 * since it compiles against those field names too.
 */
public final class RawGear {

    private static final String GEAR_TAG = SlashRef.MODID + "_gear";

    private RawGear() {
    }

    private static final String CUSTOM_TAG = SlashRef.MODID + "_custom_data";
    private static final String POTENTIAL_TAG = SlashRef.MODID + "_potential";

    /** The parsed `mmorpg_gear` object, or null if the stack has none or it will not parse. */
    public static JsonObject json(ItemStack stack) {
        return saved(stack, GEAR_TAG);
    }

    /** Any `ItemstackDataSaver`'s saved object, by its NBT key. Null when absent or unparseable. */
    private static JsonObject saved(ItemStack stack, String key) {
        try {
            CompoundTag tag = stack.getTag();
            if (tag == null || !tag.contains(key)) {
                return null;
            }
            JsonElement parsed = JsonParser.parseString(tag.getString(key));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * {@code CustomItemData}'s string map. {@code GenericDataHolder.map} is private, but the saver
     * wrote the object as {@code {"data": {"map": {...}}}}, so the map is read from there. Empty
     * when the stack has no custom data, which is the common case for an untouched drop.
     */
    public static Map<String, String> customMap(ItemStack stack) {
        Map<String, String> out = new LinkedHashMap<>();
        try {
            JsonObject custom = saved(stack, CUSTOM_TAG);
            if (custom == null || !custom.has("data")) {
                return out;
            }
            JsonObject data = custom.getAsJsonObject("data");
            if (!data.has("map")) {
                return out;
            }
            for (Map.Entry<String, JsonElement> e : data.getAsJsonObject("map").entrySet()) {
                if (e.getValue().isJsonPrimitive()) {
                    out.put(e.getKey(), e.getValue().getAsString());
                }
            }
        } catch (Exception ignored) {
            // A map that will not read is treated as no custom data.
        }
        return out;
    }

    /**
     * {@code PotentialData.potential}, or null when the stack has no potential key at all — which
     * the game treats differently from zero only in that every potential-costing orb fails on it.
     */
    public static Integer potential(ItemStack stack) {
        try {
            JsonObject pot = saved(stack, POTENTIAL_TAG);
            if (pot == null || !pot.has("potential")) {
                return null;
            }
            return pot.get("potential").getAsInt();
        } catch (Exception e) {
            return null;
        }
    }

    /** An integer field of the gear's `sockets` object — `sl`, `rp`, and the like. */
    public static Integer socketsInt(ItemStack stack, String field) {
        try {
            JsonObject gear = json(stack);
            if (gear == null || !gear.has("sockets")) {
                return null;
            }
            JsonObject sockets = gear.getAsJsonObject("sockets");
            if (!sockets.has(field) || !sockets.get(field).isJsonPrimitive()) {
                return null;
            }
            return sockets.get(field).getAsInt();
        } catch (Exception e) {
            return null;
        }
    }
}
