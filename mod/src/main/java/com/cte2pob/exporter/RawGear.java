package com.cte2pob.exporter;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.robertx22.mine_and_slash.mmorpg.SlashRef;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.item.ItemStack;

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

    /** The parsed `mmorpg_gear` object, or null if the stack has none or it will not parse. */
    public static JsonObject json(ItemStack stack) {
        try {
            CompoundTag tag = stack.getTag();
            if (tag == null || !tag.contains(GEAR_TAG)) {
                return null;
            }
            JsonElement parsed = JsonParser.parseString(tag.getString(GEAR_TAG));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
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
